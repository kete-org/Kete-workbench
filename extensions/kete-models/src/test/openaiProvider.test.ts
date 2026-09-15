/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { ProviderError, ProviderErrorKind } from '../core/errors';
import { buildChatCompletionsRequest, DEFAULT_OPENAI_BASE_URL, openAiModels, OpenAIProvider } from '../core/openaiProvider';
import { ChatRequest, ModelTier, ResponsePart } from '../core/types';
import { chunkedBody, fakeFetch, jsonResponse, OPENAI_ERROR_STREAM, OPENAI_TOOL_CALL_STREAM } from './fixtures';

const models = openAiModels({ mid: 'gpt-5-mini', frontier: 'gpt-5-codex' });
const mid = models.find(model => model.tier === ModelTier.Mid)!;

/** `apiKey: null` stands for a provider with no key stored. */
function provider(handler: Parameters<typeof fakeFetch>[0], options: { apiKey?: string | null; baseUrl?: string } = {}) {
	const fake = fakeFetch(handler);
	const instance = new OpenAIProvider({
		fetch: fake.fetch,
		getApiKey: async () => options.apiKey === undefined ? 'test-key' : options.apiKey ?? undefined,
		getBaseUrl: () => options.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
		getModelIds: () => ({ mid: 'gpt-5-mini', frontier: 'gpt-5-codex' }),
	});
	return { provider: instance, requests: fake.requests };
}

async function kindOf(promise: Promise<unknown>): Promise<ProviderErrorKind | string> {
	try {
		await promise;
		return 'resolved';
	} catch (error) {
		return error instanceof ProviderError ? error.kind : String(error);
	}
}

suite('OpenAIProvider', () => {

	test('builds a request whose tool results are their own messages and whose tools are ordered', () => {
		const request: ChatRequest = {
			messages: [
				{ role: 'system', content: [{ type: 'text', text: 'You are Kete.' }] },
				{ role: 'user', content: [{ type: 'text', text: 'Read main.ts' }] },
				{ role: 'assistant', content: [{ type: 'text', text: '' }, { type: 'toolCall', callId: 'call_01', name: 'read_file', input: { path: 'main.ts' } }] },
				{ role: 'user', content: [{ type: 'toolResult', callId: 'call_01', text: 'console.log(1)' }, { type: 'text', text: 'Here it is' }] },
			],
			tools: [
				{ name: 'write_file', description: 'Write a file' },
				{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
			],
			toolCallRequired: true,
		};

		assert.deepStrictEqual(buildChatCompletionsRequest(mid, request), {
			model: 'gpt-5-mini',
			stream: true,
			stream_options: { include_usage: true },
			max_completion_tokens: 32000,
			messages: [
				{ role: 'system', content: 'You are Kete.' },
				{ role: 'user', content: [{ type: 'text', text: 'Read main.ts' }] },
				{ role: 'assistant', content: '', tool_calls: [{ id: 'call_01', type: 'function', function: { name: 'read_file', arguments: '{"path":"main.ts"}' } }] },
				{ role: 'tool', tool_call_id: 'call_01', content: 'console.log(1)' },
				{ role: 'user', content: [{ type: 'text', text: 'Here it is' }] },
			],
			tools: [
				{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
				{ type: 'function', function: { name: 'write_file', description: 'Write a file', parameters: { type: 'object', properties: {} } } },
			],
			tool_choice: 'required',
		});
	});

	test('sends images as data URLs and marks failed tool results', () => {
		const request: ChatRequest = {
			messages: [
				{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) }] },
				{ role: 'user', content: [{ type: 'toolResult', callId: 'call_02', text: 'no such file', isError: true }] },
			],
			tools: [],
			toolCallRequired: false,
		};

		assert.deepStrictEqual(buildChatCompletionsRequest(mid, request).messages, [
			{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }] },
			{ role: 'tool', tool_call_id: 'call_02', content: 'Error: no such file' },
		]);
	});

	test('streams text and a tool call whose arguments arrive in pieces', async () => {
		const context = provider(() => new Response(chunkedBody(OPENAI_TOOL_CALL_STREAM, 7), { headers: { 'content-type': 'text/event-stream' } }));
		const parts: ResponsePart[] = [];
		const usage = await context.provider.chat(mid, { messages: [], tools: [], toolCallRequired: false }, part => parts.push(part), new AbortController().signal);

		assert.deepStrictEqual({ parts, usage, url: context.requests[0].url, auth: context.requests[0].headers.authorization }, {
			parts: [
				{ type: 'text', text: 'Reading the ' },
				{ type: 'text', text: 'file — ✓' },
				{ type: 'toolCall', callId: 'call_01', name: 'read_file', input: { path: 'src/main.ts' } },
			],
			// prompt_tokens counts the cached prefix too, so it is reported net of it.
			usage: { inputTokens: 100, outputTokens: 42, cacheReadInputTokens: 4100, stopReason: 'tool_calls' },
			url: 'https://api.openai.com/v1/chat/completions',
			auth: 'Bearer test-key',
		});
	});

	test('maps failures and reaches a configured endpoint', async () => {
		const noKey = provider(() => jsonResponse({}), { apiKey: null });
		const rejected = provider(() => jsonResponse({ error: { message: 'Incorrect API key' } }, 401));
		const missingModel = provider(() => jsonResponse({ error: { message: 'model not found' } }, 404));
		const streamError = provider(() => new Response(chunkedBody(OPENAI_ERROR_STREAM, 32), { headers: { 'content-type': 'text/event-stream' } }));
		const truncated = provider(() => new Response(chunkedBody('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', 16), { headers: { 'content-type': 'text/event-stream' } }));
		const badUrl = provider(() => jsonResponse({}), { baseUrl: 'ftp://example.invalid' });
		const selfHosted = provider(() => new Response(chunkedBody(OPENAI_TOOL_CALL_STREAM, 64), { headers: { 'content-type': 'text/event-stream' } }), { baseUrl: 'http://192.168.1.10:8000/v1/' });
		const chat = (context: ReturnType<typeof provider>) => context.provider.chat(mid, { messages: [], tools: [], toolCallRequired: false }, () => { }, new AbortController().signal);

		const results = {
			noKey: await kindOf(chat(noKey)),
			rejected: await kindOf(chat(rejected)),
			missingModel: await kindOf(chat(missingModel)),
			streamError: await kindOf(chat(streamError)),
			truncated: await kindOf(chat(truncated)),
			badUrl: await kindOf(chat(badUrl)),
			selfHosted: await kindOf(chat(selfHosted)),
		};

		assert.deepStrictEqual({ ...results, selfHostedUrl: selfHosted.requests[0]?.url }, {
			noKey: ProviderErrorKind.Auth,
			rejected: ProviderErrorKind.Auth,
			missingModel: ProviderErrorKind.NotFound,
			streamError: ProviderErrorKind.Unhealthy,
			truncated: ProviderErrorKind.Unhealthy,
			badUrl: ProviderErrorKind.BadRequest,
			selfHosted: 'resolved',
			// The trailing slash of the setting must not double up.
			selfHostedUrl: 'http://192.168.1.10:8000/v1/chat/completions',
		});
	});

	test('offers one model per cloud tier, and none without a key', async () => {
		const withKey = provider(() => jsonResponse({}));
		const without = provider(() => jsonResponse({}), { apiKey: null });

		assert.deepStrictEqual({
			models: (await withKey.provider.listModels()).map(model => ({ id: model.providerModelId, tier: ModelTier[model.tier], vendor: model.vendor })),
			withoutKey: await without.provider.listModels(),
			duplicateIdsCollapse: openAiModels({ mid: 'same-model', frontier: 'same-model' }).length,
			blankIdSkipped: openAiModels({ mid: 'gpt-5-mini', frontier: '  ' }).map(model => model.providerModelId),
		}, {
			models: [
				{ id: 'gpt-5-mini', tier: 'Mid', vendor: 'openai' },
				{ id: 'gpt-5-codex', tier: 'Frontier', vendor: 'openai' },
			],
			withoutKey: [],
			duplicateIdsCollapse: 1,
			blankIdSkipped: ['gpt-5-mini'],
		});
	});
});
