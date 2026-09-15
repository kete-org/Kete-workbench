/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { errorKindForStatus, ProviderError, toProviderError } from './errors';
import { FetchFunction } from './types';

/** Options for {@link sendHttpRequest}. */
export interface HttpRequestOptions {
	readonly fetch: FetchFunction;
	readonly url: string;
	readonly init: RequestInit;
	/** Cancels the request, including a response body still being read. */
	readonly signal: AbortSignal;
	/** How long to wait for the response headers. The body can take longer. */
	readonly headersTimeoutMs: number;
	/** Names the provider in error messages. */
	readonly label: string;
}

/**
 * Sends a request and returns the response once its headers arrive. Throws a
 * `ProviderError` for connection failures, timeouts and non-2xx statuses.
 */
export async function sendHttpRequest(options: HttpRequestOptions): Promise<Response> {
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	options.signal.addEventListener('abort', onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(), options.headersTimeoutMs);
	let response: Response;
	try {
		if (options.signal.aborted) {
			controller.abort();
		}
		response = await options.fetch(options.url, { ...options.init, signal: controller.signal });
	} catch (error) {
		throw toProviderError(error, options.signal, options.label);
	} finally {
		clearTimeout(timer);
		// From here on, readers of the body cancel it through the caller's signal.
		options.signal.removeEventListener('abort', onAbort);
	}

	if (!response.ok) {
		const detail = await readErrorDetail(response);
		throw new ProviderError(errorKindForStatus(response.status), `${options.label} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`, response.status);
	}
	return response;
}

/**
 * Extracts a short error message from an error response body. Understands the
 * Claude API's `{ error: { message } }` and Ollama's `{ error }` shapes.
 */
async function readErrorDetail(response: Response): Promise<string | undefined> {
	let text: string;
	try {
		text = await response.text();
	} catch {
		return undefined;
	}
	try {
		const body: unknown = JSON.parse(text);
		if (isRecord(body)) {
			if (typeof body.error === 'string') {
				return truncate(body.error);
			}
			if (isRecord(body.error) && typeof body.error.message === 'string') {
				return truncate(body.error.message);
			}
		}
	} catch {
		// Not JSON.
	}
	return text ? truncate(text) : undefined;
}

function truncate(value: string): string {
	return value.length > 300 ? `${value.slice(0, 300)}…` : value;
}

/**
 * Whether a value is a non-null object, so its properties can be inspected.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Encodes bytes as base64 without Node's `Buffer`, so the core also runs outside Node.
 */
export function toBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}
	return btoa(binary);
}

/**
 * Reads a response body as UTF-8 lines. Handles chunks split anywhere, including
 * inside a multi-byte character or between `\r` and `\n`.
 */
export async function* readLines(body: ReadableStream<Uint8Array>, signal: AbortSignal, label: string): AsyncGenerator<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	const onAbort = () => { reader.cancel().catch(() => undefined); };
	signal.addEventListener('abort', onAbort, { once: true });
	try {
		while (true) {
			let chunk: Awaited<ReturnType<typeof reader.read>>;
			try {
				chunk = await reader.read();
			} catch (error) {
				throw toProviderError(error, signal, label);
			}
			if (signal.aborted) {
				throw toProviderError(undefined, signal, label);
			}
			if (chunk.done) {
				buffer += decoder.decode();
				break;
			}
			buffer += decoder.decode(chunk.value, { stream: true });
			let newline: number;
			while ((newline = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				yield line.endsWith('\r') ? line.slice(0, -1) : line;
			}
		}
		if (buffer.length > 0) {
			yield buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
		}
	} finally {
		signal.removeEventListener('abort', onAbort);
		reader.releaseLock();
	}
}

/** One server-sent event. */
export interface ServerSentEvent {
	readonly event: string | undefined;
	readonly data: string;
}

/**
 * Reads a `text/event-stream` body as events.
 */
export async function* readServerSentEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal, label: string): AsyncGenerator<ServerSentEvent> {
	let event: string | undefined;
	let data: string[] = [];
	for await (const line of readLines(body, signal, label)) {
		if (line === '') {
			if (data.length > 0) {
				yield { event, data: data.join('\n') };
			}
			event = undefined;
			data = [];
		} else if (line.startsWith(':')) {
			continue;
		} else {
			const colon = line.indexOf(':');
			const field = colon === -1 ? line : line.slice(0, colon);
			let value = colon === -1 ? '' : line.slice(colon + 1);
			if (value.startsWith(' ')) {
				value = value.slice(1);
			}
			if (field === 'event') {
				event = value;
			} else if (field === 'data') {
				data.push(value);
			}
		}
	}
	if (data.length > 0) {
		yield { event, data: data.join('\n') };
	}
}
