/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { ProviderError, ProviderErrorKind } from '../core/errors';
import { OllamaProvider } from '../core/ollamaProvider';
import { ChatRequest, ModelTier, ResponsePart } from '../core/types';
import { chunkedBody, fakeFetch, jsonResponse, OLLAMA_CHAT_STREAM, OLLAMA_SHOW, OLLAMA_TAGS, RecordedRequest } from './fixtures';

function ollama(handler: (request: RecordedRequest) => Response, endpoint = 'http://127.0.0.1:11434/') {
	const fake = fakeFetch(handler);
	let calls = 0;
	const provider = new OllamaProvider({ fetch: fake.fetch, getEndpoint: () => endpoint, getMaxInputTokens: () => 8000, createCallId: () => `call_${++calls}` });
	return { provider, requests: fake.requests };
}

const server = (request: RecordedRequest): Response => {
	if (request.url.endsWith('/api/tags')) {
		return jsonResponse(OLLAMA_TAGS);
	}
	if (request.url.endsWith('/api/show') && typeof request.body === 'object' && request.body !== null) {
		return jsonResponse(OLLAMA_SHOW[String(Reflect.get(request.body, 'model'))]);
	}
	if (request.url.endsWith('/api/chat')) {
		return new Response(chunkedBody(OLLAMA_CHAT_STREAM, 7));
	}
	return jsonResponse({ error: 'not found' }, 404);
};

suite('OllamaProvider', () => {

	test('lists chat models with their capabilities and skips embedding models', async () => {
		const { provider, requests } = ollama(server);
		const models = await provider.listModels(new AbortController().signal);
		// The second listing reuses the /api/show result.
		await provider.listModels(new AbortController().signal);

		assert.deepStrictEqual({ models, urls: requests.map(r => r.url) }, {
			models: [{
				vendor: 'ollama',
				providerModelId: 'qwen2.5-coder:7b',
				displayName: 'qwen2.5-coder:7b',
				family: 'ollama/qwen2.5-coder:7b',
				tier: ModelTier.Local,
				maxInputTokens: 8000,
				maxOutputTokens: 4096,
				supportsToolCalling: true,
				supportsImages: false,
			}],
			urls: [
				'http://127.0.0.1:11434/api/tags',
				'http://127.0.0.1:11434/api/show',
				'http://127.0.0.1:11434/api/show',
				'http://127.0.0.1:11434/api/tags',
			],
		});
	});

	test('builds a chat request and streams text, tool calls and usage', async () => {
		const { provider, requests } = ollama(server);
		const [model] = await provider.listModels(new AbortController().signal);
		const request: ChatRequest = {
			messages: [
				{ role: 'system', content: [{ type: 'text', text: 'Be brief.' }] },
				{ role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image', mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) }] },
				{ role: 'assistant', content: [{ type: 'toolCall', callId: 'c1', name: 'read_file', input: { path: 'a.ts' } }] },
				{ role: 'user', content: [{ type: 'toolResult', callId: 'c1', text: 'export {}' }, { type: 'text', text: 'Now explain' }] },
			],
			tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }],
			toolCallRequired: false,
		};
		const parts: ResponsePart[] = [];
		const usage = await provider.chat(model, request, part => parts.push(part), new AbortController().signal);

		assert.deepStrictEqual({ body: requests[requests.length - 1].body, parts, usage }, {
			body: {
				model: 'qwen2.5-coder:7b',
				messages: [
					{ role: 'system', content: 'Be brief.' },
					{ role: 'user', content: 'Look', images: ['AQID'] },
					{ role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.ts' } } }] },
					{ role: 'tool', content: 'export {}', tool_name: 'read_file' },
					{ role: 'user', content: 'Now explain' },
				],
				tools: [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } } }],
				stream: true,
				options: { num_ctx: 12096, num_predict: 4096 },
			},
			parts: [
				{ type: 'text', text: 'Hello' },
				{ type: 'text', text: ', Akwaaba' },
				{ type: 'toolCall', callId: 'call_1', name: 'read_file', input: { path: 'README.md' } },
			],
			usage: { inputTokens: 31, outputTokens: 9, stopReason: 'stop' },
		});
	});

	test('classifies failures', async () => {
		const model = { vendor: 'ollama' as const, providerModelId: 'missing', displayName: 'missing', family: 'ollama/missing', tier: ModelTier.Local, maxInputTokens: 8000, maxOutputTokens: 4096, supportsToolCalling: true, supportsImages: false };
		const request: ChatRequest = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], toolCallRequired: false };
		const kind = async (promise: Promise<unknown>) => {
			try {
				await promise;
				return 'resolved';
			} catch (error) {
				return error instanceof ProviderError ? error.kind : String(error);
			}
		};
		const signal = new AbortController().signal;

		assert.deepStrictEqual({
			refused: await kind(ollama(() => { throw new TypeError('fetch failed'); }).provider.probe(signal)),
			missingModel: await kind(ollama(() => jsonResponse({ error: 'model "missing" not found, try pulling it first' }, 404)).provider.chat(model, request, () => { }, signal)),
			streamError: await kind(ollama(() => new Response('{"error":"out of memory"}\n')).provider.chat(model, request, () => { }, signal)),
			truncated: await kind(ollama(() => new Response(OLLAMA_CHAT_STREAM.split('\n')[0] + '\n')).provider.chat(model, request, () => { }, signal)),
			badEndpoint: await kind(ollama(server, 'file:///etc').provider.probe(signal)),
		}, {
			refused: ProviderErrorKind.Unreachable,
			missingModel: ProviderErrorKind.NotFound,
			streamError: ProviderErrorKind.Unhealthy,
			truncated: ProviderErrorKind.Unhealthy,
			badEndpoint: ProviderErrorKind.BadRequest,
		});
	});
});
