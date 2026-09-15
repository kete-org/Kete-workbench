/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { suite, test } from 'node:test';
import { describeOutcome, runAgentLoop, toolCallKey } from '../core/agentLoop';
import { AgentMessage, AgentModel, AgentModelRequest, AgentModelResponsePart, AgentToolCall, AgentToolInvoker, CancellationSignal, ToolOutcome } from '../core/agentTypes';
import { GOVERNANCE_DENIAL_PREFIX } from '../core/governance';

type Turn = readonly AgentModelResponsePart[] | Error;

/** A model that plays back scripted turns and records the requests it gets. */
class FakeModel implements AgentModel {
	readonly maxInputTokens = 8000;
	readonly requests: AgentModelRequest[] = [];
	private next = 0;

	constructor(private readonly turns: readonly Turn[], private readonly onSend?: (index: number) => void) { }

	async *send(request: AgentModelRequest): AsyncIterable<AgentModelResponsePart> {
		this.requests.push({ ...request, messages: [...request.messages] });
		const index = this.next++;
		this.onSend?.(index);
		const turn = this.turns[Math.min(index, this.turns.length - 1)];
		if (turn instanceof Error) {
			throw turn;
		}
		yield* turn;
	}
}

/** A tool invoker that answers from a function and records calls. */
class FakeInvoker implements AgentToolInvoker {
	readonly calls: string[] = [];
	constructor(private readonly answer: (call: AgentToolCall) => ToolOutcome) { }
	async invoke(call: AgentToolCall): Promise<ToolOutcome> {
		this.calls.push(toolCallKey(call));
		return this.answer(call);
	}
}

const userMessage: AgentMessage = { role: 'user', parts: [{ kind: 'text', text: 'Fix the bug' }] };
const notCancelled: CancellationSignal = { isCancellationRequested: false };

function call(callId: string, name: string, input: object = {}): AgentModelResponsePart {
	return { kind: 'toolCall', call: { callId, name, input } };
}

function text(value: string): AgentModelResponsePart {
	return { kind: 'text', text: value };
}

async function run(model: AgentModel, invoker: AgentToolInvoker, options: { signal?: CancellationSignal; maxIterations?: number } = {}) {
	const streamed: string[] = [];
	const result = await runAgentLoop({
		model,
		invoker,
		system: 'system',
		messages: [userMessage],
		tools: [{ name: 'readFile', description: 'Reads a file' }],
		progress: { text: chunk => streamed.push(chunk) },
		signal: options.signal ?? notCancelled,
		maxIterations: options.maxIterations,
	});
	return { result, streamed };
}

suite('agent loop', () => {

	test('stops when the model answers without tool calls, streaming the answer', async () => {
		const model = new FakeModel([[text('All '), text('done.')]]);
		const invoker = new FakeInvoker(() => ({ kind: 'completed', text: '' }));

		const { result, streamed } = await run(model, invoker);

		assert.deepStrictEqual({ stopReason: result.stopReason, iterations: result.iterations, streamed, calls: invoker.calls, requests: model.requests.length }, {
			stopReason: 'completed',
			iterations: 1,
			streamed: ['All ', 'done.'],
			calls: [],
			requests: 1,
		});
	});

	test('feeds tool results back to the model on the next iteration', async () => {
		const model = new FakeModel([
			[text('Reading.'), call('c1', 'readFile', { path: 'a.ts' })],
			[text('Fixed.')],
		]);
		const invoker = new FakeInvoker(() => ({ kind: 'completed', text: 'const a = 1;' }));

		const { result } = await run(model, invoker);

		assert.deepStrictEqual({ stopReason: result.stopReason, secondRequestMessages: model.requests[1].messages }, {
			stopReason: 'completed',
			secondRequestMessages: [
				userMessage,
				{ role: 'assistant', parts: [{ kind: 'text', text: 'Reading.' }, { kind: 'toolCall', call: { callId: 'c1', name: 'readFile', input: { path: 'a.ts' } } }] },
				{ role: 'user', parts: [{ kind: 'toolResult', callId: 'c1', text: 'const a = 1;' }] },
			],
		});
	});

	test('respects the iteration bound when the model keeps calling tools', async () => {
		const model = new FakeModel([[call('c', 'readFile', { path: 'a.ts' })]]);
		const invoker = new FakeInvoker(() => ({ kind: 'completed', text: 'ok' }));

		const { result } = await run(model, invoker, { maxIterations: 3 });

		assert.deepStrictEqual({ stopReason: result.stopReason, iterations: result.iterations, requests: model.requests.length, calls: invoker.calls.length }, {
			stopReason: 'maxIterations',
			iterations: 3,
			requests: 3,
			calls: 3,
		});
	});

	test('stops without invoking tools once cancelled', async () => {
		const signal = { isCancellationRequested: false };
		const model = new FakeModel([[call('c1', 'readFile')], [text('never')]], () => signal.isCancellationRequested = true);
		const invoker = new FakeInvoker(() => ({ kind: 'completed', text: 'ok' }));

		const { result } = await run(model, invoker, { signal });

		assert.deepStrictEqual({ stopReason: result.stopReason, iterations: result.iterations, calls: invoker.calls }, {
			stopReason: 'cancelled',
			iterations: 1,
			calls: [],
		});
	});

	test('does not start when already cancelled', async () => {
		const model = new FakeModel([[text('never')]]);

		const { result } = await run(model, new FakeInvoker(() => ({ kind: 'cancelled' })), { signal: { isCancellationRequested: true } });

		assert.deepStrictEqual({ stopReason: result.stopReason, requests: model.requests.length }, { stopReason: 'cancelled', requests: 0 });
	});

	test('reports a governance denial to the model and never re-invokes the same call', async () => {
		const denial = `${GOVERNANCE_DENIAL_PREFIX} (risk tier: production; reason: deploy). It was not performed.`;
		const deploy = { command: 'kubectl apply -f prod.yaml' };
		const model = new FakeModel([
			[call('c1', 'runInTerminal', deploy)],
			[call('c2', 'runInTerminal', { command: 'kubectl apply -f prod.yaml' })],
			[text('I could not deploy; please run it yourself.')],
		]);
		const invoker = new FakeInvoker(() => ({ kind: 'governanceDenied', text: denial }));

		const { result } = await run(model, invoker);

		assert.deepStrictEqual({
			stopReason: result.stopReason,
			invocations: invoker.calls.length,
			outcomes: result.toolCalls.map(({ outcome }) => outcome.kind),
			fedBack: model.requests[2].messages.filter(message => message.role === 'user').slice(1),
		}, {
			stopReason: 'completed',
			invocations: 1,
			outcomes: ['governanceDenied', 'governanceDenied'],
			fedBack: [
				{ role: 'user', parts: [{ kind: 'toolResult', callId: 'c1', text: denial }] },
				{ role: 'user', parts: [{ kind: 'toolResult', callId: 'c2', text: denial }] },
			],
		});
	});

	test('feeds back declined and failing tool calls instead of stopping', async () => {
		const model = new FakeModel([
			[call('c1', 'editFile', { path: 'a.ts' }), call('c2', 'broken')],
			[text('Done what I could.')],
		]);
		const invoker = new FakeInvoker(tool => {
			if (tool.name === 'editFile') {
				return { kind: 'userDeclined' };
			}
			throw new Error('boom');
		});

		const { result } = await run(model, invoker);

		assert.deepStrictEqual({ stopReason: result.stopReason, fedBack: model.requests[1].messages.at(-1) }, {
			stopReason: 'completed',
			fedBack: {
				role: 'user', parts: [
					{ kind: 'toolResult', callId: 'c1', text: describeOutcome({ kind: 'userDeclined' }) },
					{ kind: 'toolResult', callId: 'c2', text: 'The tool call failed: boom' },
				]
			},
		});
	});

	test('stops with the error when the model request fails', async () => {
		const { result } = await run(new FakeModel([new Error('quota exceeded')]), new FakeInvoker(() => ({ kind: 'cancelled' })));

		assert.deepStrictEqual({ stopReason: result.stopReason, error: result.error }, { stopReason: 'modelError', error: 'quota exceeded' });
	});

	test('identifies repeated calls regardless of input key order', () => {
		assert.strictEqual(
			toolCallKey({ callId: '1', name: 'run', input: { a: 1, b: { c: 2, d: 3 } } }),
			toolCallKey({ callId: '2', name: 'run', input: { b: { d: 3, c: 2 }, a: 1 } }),
		);
	});
});
