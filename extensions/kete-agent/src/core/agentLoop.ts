/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentMessage, AgentMessagePart, AgentModel, AgentProgress, AgentToolCall, AgentToolDefinition, AgentToolInvoker, CancellationSignal, ToolOutcome } from './agentTypes';

/** Default bound on model round trips for one chat request. */
export const DEFAULT_MAX_ITERATIONS = 12;

/** Default cap on the characters of one tool result fed back to the model. */
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 24_000;

/**
 * Why the loop stopped.
 *
 * - `completed`: the model answered without requesting tools.
 * - `maxIterations`: the model still wanted tools after the last allowed round trip.
 * - `cancelled`: the request was cancelled.
 * - `modelError`: the model request failed; see {@link AgentLoopResult.error}.
 */
export type AgentStopReason = 'completed' | 'maxIterations' | 'cancelled' | 'modelError';

/**
 * Inputs to {@link runAgentLoop}.
 */
export interface AgentLoopOptions {
	readonly model: AgentModel;
	readonly invoker: AgentToolInvoker;
	readonly system: string;
	/** The conversation so far, ending with the person's current request. */
	readonly messages: readonly AgentMessage[];
	readonly tools: readonly AgentToolDefinition[];
	readonly progress: AgentProgress;
	readonly signal: CancellationSignal;
	readonly maxIterations?: number;
	readonly maxToolResultChars?: number;
}

/**
 * What happened during one run of the loop.
 */
export interface AgentLoopResult {
	readonly stopReason: AgentStopReason;
	/** Model round trips made. */
	readonly iterations: number;
	/** Every tool call the model requested, with how it ended. */
	readonly toolCalls: readonly { readonly call: AgentToolCall; readonly outcome: ToolOutcome }[];
	/** The full transcript, including the model's turns and tool results. */
	readonly transcript: readonly AgentMessage[];
	/** The model error's message, when {@link stopReason} is `modelError`. */
	readonly error?: string;
}

/**
 * The agent core's plan → act → observe loop.
 *
 * Each iteration sends the transcript to the model (plan), runs the tool calls
 * it asks for one at a time (act), and appends their results to the transcript
 * (observe). It stops when the model answers without tool calls, when
 * `maxIterations` round trips have been made, or when cancelled.
 *
 * Approval is not handled here. Tool calls go through the invoker, which in the
 * fork is `vscode.lm.invokeTool` and therefore the governance gate; the loop
 * only reacts to the outcome. A call that was refused, by the gate or by the
 * person, is never re-invoked with the same input during the same run: the model
 * is told it was refused instead.
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
	const maxIterations = Math.max(1, options.maxIterations ?? DEFAULT_MAX_ITERATIONS);
	const maxToolResultChars = options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
	const { model, invoker, system, tools, progress, signal } = options;

	const transcript: AgentMessage[] = [...options.messages];
	const toolCalls: { call: AgentToolCall; outcome: ToolOutcome }[] = [];
	const refused = new Map<string, ToolOutcome>();
	let iterations = 0;

	const finish = (stopReason: AgentStopReason, error?: string): AgentLoopResult => ({ stopReason, iterations, toolCalls, transcript, error });

	while (iterations < maxIterations) {
		if (signal.isCancellationRequested) {
			return finish('cancelled');
		}

		iterations++;
		const assistantParts: AgentMessagePart[] = [];
		const requestedCalls: AgentToolCall[] = [];
		let text = '';
		try {
			for await (const part of model.send({ system, messages: transcript, tools }, signal)) {
				if (signal.isCancellationRequested) {
					break;
				}
				if (part.kind === 'text') {
					text += part.text;
					progress.text(part.text);
				} else {
					requestedCalls.push(part.call);
				}
			}
		} catch (error) {
			if (signal.isCancellationRequested) {
				return finish('cancelled');
			}
			return finish('modelError', error instanceof Error ? error.message : String(error));
		}

		if (text) {
			assistantParts.push({ kind: 'text', text });
		}
		for (const call of requestedCalls) {
			assistantParts.push({ kind: 'toolCall', call });
		}
		if (assistantParts.length) {
			transcript.push({ role: 'assistant', parts: assistantParts });
		}

		if (signal.isCancellationRequested) {
			return finish('cancelled');
		}
		if (!requestedCalls.length) {
			return finish('completed');
		}

		const resultParts: AgentMessagePart[] = [];
		for (const call of requestedCalls) {
			const outcome = await runToolCall(call, invoker, refused, signal);
			toolCalls.push({ call, outcome });
			resultParts.push({ kind: 'toolResult', callId: call.callId, text: truncate(describeOutcome(outcome), maxToolResultChars) });
		}
		transcript.push({ role: 'user', parts: resultParts });

		if (signal.isCancellationRequested) {
			return finish('cancelled');
		}
	}

	return finish('maxIterations');
}

async function runToolCall(call: AgentToolCall, invoker: AgentToolInvoker, refused: Map<string, ToolOutcome>, signal: CancellationSignal): Promise<ToolOutcome> {
	if (signal.isCancellationRequested) {
		return { kind: 'cancelled' };
	}

	const key = toolCallKey(call);
	const earlierRefusal = refused.get(key);
	if (earlierRefusal) {
		return earlierRefusal;
	}

	let outcome: ToolOutcome;
	try {
		outcome = await invoker.invoke(call, signal);
	} catch (error) {
		outcome = signal.isCancellationRequested
			? { kind: 'cancelled' }
			: { kind: 'error', message: error instanceof Error ? error.message : String(error) };
	}

	if (outcome.kind === 'governanceDenied' || outcome.kind === 'userDeclined') {
		refused.set(key, outcome);
	}
	return outcome;
}

/**
 * The text fed back to the model for a tool call's outcome. Model-facing, so
 * not localized.
 */
export function describeOutcome(outcome: ToolOutcome): string {
	switch (outcome.kind) {
		case 'completed':
			return outcome.text || 'The tool completed without output.';
		case 'governanceDenied':
			// The gate's own message already says the action was not performed and
			// must not be retried as-is; keep it verbatim so its reason survives.
			return outcome.text;
		case 'userDeclined':
			return 'The user declined this tool call, so it was not performed. Do not retry it as-is: continue without it, or ask the user how to proceed.';
		case 'error':
			return `The tool call failed: ${outcome.message}`;
		case 'cancelled':
			return 'The tool call was cancelled and was not performed.';
	}
}

/**
 * Identifies a call by tool name and input, so a refused call is recognised when
 * the model asks for it again. Object keys are sorted so key order doesn't matter.
 */
export function toolCallKey(call: AgentToolCall): string {
	return `${call.name}\u0000${stableStringify(call.input)}`;
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(',')}]`;
	}
	if (value && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
		return `{${entries.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'undefined';
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars)}\n[Output truncated: ${text.length - maxChars} more characters were omitted.]`;
}
