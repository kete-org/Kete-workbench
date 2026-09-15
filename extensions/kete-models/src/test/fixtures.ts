/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Scheduler } from '../core/connectivity';
import { Disposable, FetchFunction } from '../core/types';

/**
 * A Claude Messages API stream in the documented wire format: text, then a tool
 * call whose input JSON arrives in pieces, with prompt cache usage.
 */
export const CLAUDE_TOOL_CALL_STREAM = [
	'event: message_start',
	'data: {"type":"message_start","message":{"id":"msg_01","type":"message","role":"assistant","model":"claude-haiku-4-5-20251001","content":[],"stop_reason":null,"usage":{"input_tokens":12,"cache_creation_input_tokens":0,"cache_read_input_tokens":4100,"output_tokens":1}}}',
	'',
	'event: content_block_start',
	'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
	'',
	'event: ping',
	'data: {"type": "ping"}',
	'',
	'event: content_block_delta',
	'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Reading the "}}',
	'',
	'event: content_block_delta',
	'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"file — ✓"}}',
	'',
	'event: content_block_stop',
	'data: {"type":"content_block_stop","index":0}',
	'',
	'event: content_block_start',
	'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01","name":"read_file","input":{}}}',
	'',
	'event: content_block_delta',
	'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":""}}',
	'',
	'event: content_block_delta',
	'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\": \\"src/"}}',
	'',
	'event: content_block_delta',
	'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"main.ts\\"}"}}',
	'',
	'event: content_block_stop',
	'data: {"type":"content_block_stop","index":1}',
	'',
	'event: message_delta',
	'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":42}}',
	'',
	'event: message_stop',
	'data: {"type":"message_stop"}',
	'',
	'',
].join('\r\n');

/** A Claude stream that fails with an overload error after starting. */
export const CLAUDE_OVERLOADED_STREAM = [
	'event: message_start',
	'data: {"type":"message_start","message":{"id":"msg_02","usage":{"input_tokens":5,"output_tokens":1}}}',
	'',
	'event: error',
	'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
	'',
	'',
].join('\n');

/**
 * An OpenAI Chat Completions stream: text, then a tool call whose arguments
 * arrive across deltas, then usage with a prompt cache hit and `[DONE]`.
 */
export const OPENAI_TOOL_CALL_STREAM = [
	'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-5-mini","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}',
	'',
	'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"Reading the "}}]}',
	'',
	'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"file — ✓"}}]}',
	'',
	'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_01","type":"function","function":{"name":"read_file","arguments":""}}]}}]}',
	'',
	'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\": \\"src/"}}]}}]}',
	'',
	'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"main.ts\\"}"}}]}}]}',
	'',
	'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
	'',
	'data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":4200,"completion_tokens":42,"total_tokens":4242,"prompt_tokens_details":{"cached_tokens":4100}}}',
	'',
	'data: [DONE]',
	'',
	'',
].join('\r\n');

/** An OpenAI stream that reports a mid-stream failure as an error object. */
export const OPENAI_ERROR_STREAM = [
	'data: {"id":"chatcmpl-2","choices":[{"index":0,"delta":{"content":"partial"}}]}',
	'',
	'data: {"error":{"message":"The server had an error","type":"server_error"}}',
	'',
	'',
].join('\n');

/** An Ollama `/api/chat` stream in its newline-delimited JSON format. */
export const OLLAMA_CHAT_STREAM = [
	'{"model":"qwen2.5-coder:7b","created_at":"2026-09-15T10:00:00Z","message":{"role":"assistant","content":"Hello"},"done":false}',
	'{"model":"qwen2.5-coder:7b","created_at":"2026-09-15T10:00:00Z","message":{"role":"assistant","content":", Akwaaba"},"done":false}',
	'{"model":"qwen2.5-coder:7b","created_at":"2026-09-15T10:00:01Z","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"read_file","arguments":{"path":"README.md"}}}]},"done":false}',
	'{"model":"qwen2.5-coder:7b","created_at":"2026-09-15T10:00:01Z","message":{"role":"assistant","content":""},"done_reason":"stop","done":true,"total_duration":1200000000,"prompt_eval_count":31,"eval_count":9}',
	'',
].join('\n');

/** Ollama `/api/tags`: a chat model and an embedding model. */
export const OLLAMA_TAGS = {
	models: [
		{ name: 'qwen2.5-coder:7b', model: 'qwen2.5-coder:7b', digest: 'sha-qwen', size: 4683087332, details: { family: 'qwen2', parameter_size: '7.6B' } },
		{ name: 'nomic-embed-text:latest', model: 'nomic-embed-text:latest', digest: 'sha-nomic', size: 274302450, details: { family: 'nomic-bert' } },
	],
};

/** Ollama `/api/show` for each model in {@link OLLAMA_TAGS}. */
export const OLLAMA_SHOW: Record<string, object> = {
	'qwen2.5-coder:7b': { capabilities: ['completion', 'tools', 'insert'], model_info: { 'general.architecture': 'qwen2', 'qwen2.context_length': 32768 } },
	'nomic-embed-text:latest': { capabilities: ['embedding'], model_info: { 'nomic-bert.context_length': 2048 } },
};

/**
 * A response body that delivers `text` in chunks of `chunkSize` bytes, to
 * exercise parsers on arbitrary chunk boundaries (including inside multi-byte
 * characters).
 */
export function chunkedBody(text: string, chunkSize: number): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
	let offset = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= bytes.length) {
				controller.close();
				return;
			}
			controller.enqueue(bytes.slice(offset, offset + chunkSize));
			offset += chunkSize;
		},
	});
}

/** A request the fake fetch received. */
export interface RecordedRequest {
	readonly url: string;
	readonly method: string;
	readonly headers: Record<string, string>;
	readonly body: unknown;
}

/**
 * A `fetch` that answers from a handler and records every request. Never
 * touches the network.
 */
export function fakeFetch(handler: (request: RecordedRequest) => Response | Promise<Response>): { readonly fetch: FetchFunction; readonly requests: RecordedRequest[] } {
	const requests: RecordedRequest[] = [];
	const fetch: FetchFunction = async (url, init) => {
		const request: RecordedRequest = {
			url,
			method: init.method ?? 'GET',
			headers: { ...(init.headers as Record<string, string> | undefined) },
			body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
		};
		requests.push(request);
		return handler(request);
	};
	return { fetch, requests };
}

/** A JSON response. */
export function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A scheduler whose clock and timers only move when the test says so. */
export class FakeScheduler implements Scheduler {
	private time = 0;
	private readonly timers: { at: number; callback: () => void; cancelled: boolean }[] = [];

	now(): number {
		return this.time;
	}

	setTimeout(callback: () => void, delayMs: number): Disposable {
		const timer = { at: this.time + delayMs, callback, cancelled: false };
		this.timers.push(timer);
		return { dispose: () => { timer.cancelled = true; } };
	}

	/** Delays of timers that are still pending, in order of creation. */
	pendingDelays(): number[] {
		return this.timers.filter(timer => !timer.cancelled).map(timer => timer.at - this.time);
	}

	/** Moves the clock and runs timers that are due. */
	advance(ms: number): void {
		this.time += ms;
		for (const timer of [...this.timers]) {
			if (!timer.cancelled && timer.at <= this.time) {
				timer.cancelled = true;
				timer.callback();
			}
		}
	}
}
