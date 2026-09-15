/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { AnthropicProvider, buildMessagesRequest, CLAUDE_MODELS, ClaudeModelId } from '../core/anthropicProvider';
import { ProviderError, ProviderErrorKind } from '../core/errors';
import { ChatRequest, ResponsePart } from '../core/types';
import { chunkedBody, CLAUDE_OVERLOADED_STREAM, CLAUDE_TOOL_CALL_STREAM, fakeFetch, jsonResponse } from './fixtures';

const haiku = CLAUDE_MODELS.find(model => model.providerModelId === ClaudeModelId.Haiku)!;

function provider(handler: Parameters<typeof fakeFetch>[0], apiKey: string | undefined = 'test-key') {
	const fake = fakeFetch(handler);
	return { provider: new AnthropicProvider({ fetch: fake.fetch, getApiKey: async () => apiKey }), requests: fake.requests };
}

async function kindOf(promise: Promise<unknown>): Promise<ProviderErrorKind | string> {
	try {
		await promise;
		return 'resolved';
	} catch (error) {
		return error instanceof ProviderError ? error.kind : String(error);
	}
}

suite('AnthropicProvider', () => {

	test('builds a request with system blocks, ordered tool results and cache breakpoints', () => {
		const request: ChatRequest = {
			messages: [
				{ role: 'system', content: [{ type: 'text', text: 'You are Kete.' }] },
				{ role: 'user', content: [{ type: 'text', text: 'Read main.ts' }] },
				{ role: 'assistant', content: [{ type: 'text', text: '' }, { type: 'toolCall', callId: 'toolu_01', name: 'read_file', input: { path: 'main.ts' } }] },
				{ role: 'user', content: [{ type: 'text', text: 'Here it is' }, { type: 'toolResult', callId: 'toolu_01', text: 'console.log(1)' }] },
			],
			tools: [
				{ name: 'write_file', description: 'Write a file' },
				{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
			],
			toolCallRequired: true,
		};

		assert.deepStrictEqual(buildMessagesRequest(haiku, request), {
			model: 'claude-haiku-4-5-20251001',
			max_tokens: 32000,
			stream: true,
			system: [{ type: 'text', text: 'You are Kete.', cache_control: { type: 'ephemeral' } }],
			messages: [
				{ role: 'user', content: [{ type: 'text', text: 'Read main.ts' }] },
				{ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'read_file', input: { path: 'main.ts' } }] },
				{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'console.log(1)' }, { type: 'text', text: 'Here it is', cache_control: { type: 'ephemeral' } }] },
			],
			tools: [
				{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
				{ name: 'write_file', description: 'Write a file', input_schema: { type: 'object', properties: {} }, cache_control: { type: 'ephemeral' } },
			],
			tool_choice: { type: 'any' },
		});
	});

	test('streams text and a tool call assembled from pieces, and reports cache usage', async () => {
		// Six-byte chunks split events, lines, `\r\n` pairs and the multi-byte characters.
		const { provider: claude, requests } = provider(() => new Response(chunkedBody(CLAUDE_TOOL_CALL_STREAM, 6), { status: 200 }));
		const parts: ResponsePart[] = [];
		const usage = await claude.chat(haiku, { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], toolCallRequired: false }, part => parts.push(part), new AbortController().signal);

		assert.deepStrictEqual({ parts, usage, url: requests[0].url, headers: requests[0].headers }, {
			parts: [
				{ type: 'text', text: 'Reading the ' },
				{ type: 'text', text: 'file — ✓' },
				{ type: 'toolCall', callId: 'toolu_01', name: 'read_file', input: { path: 'src/main.ts' } },
			],
			usage: { inputTokens: 12, outputTokens: 42, cacheCreationInputTokens: 0, cacheReadInputTokens: 4100, stopReason: 'tool_use' },
			url: 'https://api.anthropic.com/v1/messages',
			headers: { 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
		});
	});

	test('classifies failures', async () => {
		const request: ChatRequest = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], toolCallRequired: false };
		const run = (handler: Parameters<typeof fakeFetch>[0], apiKey?: string) => kindOf(provider(handler, apiKey).provider.chat(haiku, request, () => { }, new AbortController().signal));

		assert.deepStrictEqual({
			streamError: await run(() => new Response(CLAUDE_OVERLOADED_STREAM)),
			truncated: await run(() => new Response(CLAUDE_TOOL_CALL_STREAM.slice(0, 400))),
			rejectedKey: await run(() => jsonResponse({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401)),
			overloaded: await run(() => jsonResponse({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 529)),
			rateLimited: await run(() => jsonResponse({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 429)),
			invalid: await run(() => jsonResponse({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }, 400)),
			noConnection: await run(() => { throw new TypeError('fetch failed'); }),
			noKey: await run(() => new Response(''), ''),
		}, {
			streamError: ProviderErrorKind.Unhealthy,
			truncated: ProviderErrorKind.Unhealthy,
			rejectedKey: ProviderErrorKind.Auth,
			overloaded: ProviderErrorKind.Unhealthy,
			rateLimited: ProviderErrorKind.Unhealthy,
			invalid: ProviderErrorKind.BadRequest,
			noConnection: ProviderErrorKind.Unreachable,
			noKey: ProviderErrorKind.Auth,
		});
	});

	test('a rejected key still counts as reachable for the probe, and fails verification', async () => {
		const unauthorized = () => jsonResponse({ type: 'error', error: { type: 'authentication_error', message: 'invalid' } }, 401);
		const { provider: claude, requests } = provider(unauthorized);
		const signal = new AbortController().signal;

		assert.deepStrictEqual({
			probe: await kindOf(claude.probe(signal)),
			verify: await claude.verifyApiKey('bad', signal),
			verifyOffline: await kindOf(provider(() => { throw new TypeError('fetch failed'); }).provider.verifyApiKey('key', signal)),
			probeUrl: requests[0].url,
			listedWithoutKey: (await provider(unauthorized, '').provider.listModels()).length,
		}, {
			probe: 'resolved',
			verify: false,
			verifyOffline: ProviderErrorKind.Unreachable,
			probeUrl: 'https://api.anthropic.com/v1/models?limit=1',
			listedWithoutKey: 0,
		});
	});

	test('cancelling stops the stream', async () => {
		const controller = new AbortController();
		const body = new ReadableStream<Uint8Array>({
			start(streamController) {
				streamController.enqueue(new TextEncoder().encode(CLAUDE_TOOL_CALL_STREAM.slice(0, CLAUDE_TOOL_CALL_STREAM.indexOf('event: content_block_stop'))));
			},
		});
		const { provider: claude } = provider(() => new Response(body));
		const result = kindOf(claude.chat(haiku, { messages: [], tools: [], toolCallRequired: false }, () => controller.abort(), controller.signal));
		assert.strictEqual(await result, ProviderErrorKind.Cancelled);
	});
});
