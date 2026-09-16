/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ProviderError, ProviderErrorKind } from './errors';
import { isRecord, readLines, sendHttpRequest, toBase64 } from './http';
import { ChatMessage, ChatRequest, ChatUsage, FetchFunction, ModelDescriptor, ModelProvider, ModelTier, ResponsePart } from './types';

/** Ollama's default address. */
export const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434';

/** Output tokens reserved in the context window Kete requests from Ollama. */
export const OLLAMA_OUTPUT_TOKENS = 4096;

/**
 * How long to wait for a local model to start responding, in milliseconds.
 * Generous, because the wait covers loading the model into memory and reading
 * the whole prompt, and a slow or shared machine can take minutes over a large
 * agent prompt before the first token appears.
 */
export const DEFAULT_OLLAMA_REQUEST_TIMEOUT_MS = 120000;

/**
 * Bounds for the configured timeout. The ceiling is not a preference: Node's
 * `fetch` applies its own 300 s headers timeout that a caller cannot raise
 * without supplying an undici dispatcher, and a request that outlives it fails
 * as "fetch failed" rather than as our own timeout. Stopping just under that
 * keeps the failure ours, and keeps the setting from promising a wait the
 * runtime will not honour. Measured against a CPU-only server: a bare prompt
 * answers in ~10 s, an agent-sized prompt with the workbench's tools took
 * ~175 s, and a larger one exceeded 300 s and died there.
 */
const MIN_REQUEST_TIMEOUT_MS = 10000;
const MAX_REQUEST_TIMEOUT_MS = 290000;

/**
 * Turns the `kete.models.ollama.requestTimeout` setting, in seconds, into
 * milliseconds, falling back to the default when it is missing or unusable and
 * clamping it to something a person could wait for.
 */
export function resolveRequestTimeoutMs(seconds: unknown): number {
	if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
		return DEFAULT_OLLAMA_REQUEST_TIMEOUT_MS;
	}
	return Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(MIN_REQUEST_TIMEOUT_MS, Math.round(seconds * 1000)));
}

const LABEL = 'Ollama';

/** Dependencies of {@link OllamaProvider}. */
export interface OllamaProviderOptions {
	readonly fetch: FetchFunction;
	/** Read on every call, so a changed setting applies at once. */
	readonly getEndpoint: () => string;
	/**
	 * The largest prompt, in tokens, to send to a local model. The context window
	 * requested from Ollama is this plus {@link OLLAMA_OUTPUT_TOKENS}; it stays the
	 * same across requests, because a different `num_ctx` makes Ollama reload the model.
	 */
	readonly getMaxInputTokens: () => number;
	/** How long to wait for response headers, which includes loading the model. */
	/**
	 * How long to wait for the first response byte of a chat request. Read on
	 * every call, so a changed setting applies at once.
	 */
	readonly getRequestTimeoutMs?: () => number;
	/** Creates ids for tool calls, which Ollama doesn't always assign. */
	readonly createCallId?: () => string;
}

/** What `/api/show` says about a model. */
export interface ModelDetails {
	readonly contextLength: number | undefined;
	readonly capabilities: readonly string[] | undefined;
}

/**
 * Local models served by Ollama (`/api/tags`, `/api/show`, `/api/chat`).
 */
export class OllamaProvider implements ModelProvider {
	public readonly id = 'ollama';

	/** `/api/show` results by model digest; a digest changes when the model does. */
	private readonly details = new Map<string, ModelDetails>();
	private callCounter = 0;

	constructor(private readonly options: OllamaProviderOptions) { }

	async probe(signal: AbortSignal): Promise<void> {
		await sendHttpRequest({
			fetch: this.options.fetch,
			url: `${this.endpoint()}/api/version`,
			init: { method: 'GET' },
			signal,
			headersTimeoutMs: 3000,
			label: LABEL,
		});
	}

	async listModels(signal: AbortSignal): Promise<readonly ModelDescriptor[]> {
		const response = await sendHttpRequest({
			fetch: this.options.fetch,
			url: `${this.endpoint()}/api/tags`,
			init: { method: 'GET' },
			signal,
			headersTimeoutMs: 5000,
			label: LABEL,
		});
		const body: unknown = await response.json().catch(() => undefined);
		const entries = isRecord(body) && Array.isArray(body.models) ? body.models : [];
		const models: ModelDescriptor[] = [];
		for (const entry of entries) {
			if (!isRecord(entry) || typeof entry.name !== 'string') {
				continue;
			}
			const details = await this.getDetails(entry.name, typeof entry.digest === 'string' ? entry.digest : entry.name, signal);
			if (details.capabilities && !details.capabilities.includes('completion')) {
				continue; // An embedding model can't chat.
			}
			models.push(this.describe(entry.name, details));
		}
		return models;
	}

	async chat(model: ModelDescriptor, request: ChatRequest, onPart: (part: ResponsePart) => void, signal: AbortSignal): Promise<ChatUsage> {
		const body = buildOllamaChatRequest(model, request, this.contextWindow());
		const response = await sendHttpRequest({
			fetch: this.options.fetch,
			url: `${this.endpoint()}/api/chat`,
			init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
			signal,
			headersTimeoutMs: this.options.getRequestTimeoutMs?.() ?? DEFAULT_OLLAMA_REQUEST_TIMEOUT_MS,
			label: LABEL,
		});
		if (!response.body) {
			throw new ProviderError(ProviderErrorKind.Unhealthy, `${LABEL} returned an empty response`);
		}
		return parseOllamaChatStream(response.body, onPart, signal, this.options.createCallId ?? (() => `ollama_call_${++this.callCounter}`));
	}

	private describe(name: string, details: ModelDetails): ModelDescriptor {
		const contextWindow = Math.min(this.contextWindow(), details.contextLength ?? Number.MAX_SAFE_INTEGER);
		return {
			vendor: 'ollama',
			providerModelId: name,
			displayName: name,
			family: `ollama/${name}`,
			tier: ModelTier.Local,
			maxInputTokens: Math.max(1024, contextWindow - OLLAMA_OUTPUT_TOKENS),
			maxOutputTokens: OLLAMA_OUTPUT_TOKENS,
			supportsToolCalling: details.capabilities ? details.capabilities.includes('tools') : undefined,
			supportsImages: details.capabilities ? details.capabilities.includes('vision') : undefined,
		};
	}

	private async getDetails(name: string, digest: string, signal: AbortSignal): Promise<ModelDetails> {
		const cached = this.details.get(digest);
		if (cached) {
			return cached;
		}
		let details: ModelDetails = { contextLength: undefined, capabilities: undefined };
		try {
			const response = await sendHttpRequest({
				fetch: this.options.fetch,
				url: `${this.endpoint()}/api/show`,
				init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: name }) },
				signal,
				headersTimeoutMs: 5000,
				label: LABEL,
			});
			details = parseShowResponse(await response.json());
			this.details.set(digest, details);
		} catch (error) {
			if (error instanceof ProviderError && error.kind === ProviderErrorKind.Cancelled) {
				throw error;
			}
			// Older Ollama versions: capabilities stay unknown, and aren't cached.
		}
		return details;
	}

	private contextWindow(): number {
		return this.options.getMaxInputTokens() + OLLAMA_OUTPUT_TOKENS;
	}

	private endpoint(): string {
		const raw = this.options.getEndpoint().trim() || DEFAULT_OLLAMA_ENDPOINT;
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			throw new ProviderError(ProviderErrorKind.BadRequest, 'The Ollama endpoint setting is not a valid URL');
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			throw new ProviderError(ProviderErrorKind.BadRequest, 'The Ollama endpoint setting must be an http or https URL');
		}
		return raw.replace(/\/+$/, '');
	}
}

/**
 * Reads the context length and capabilities from an `/api/show` response.
 */
export function parseShowResponse(body: unknown): ModelDetails {
	if (!isRecord(body)) {
		return { contextLength: undefined, capabilities: undefined };
	}
	let contextLength: number | undefined;
	if (isRecord(body.model_info)) {
		for (const [key, value] of Object.entries(body.model_info)) {
			if (key.endsWith('.context_length') && typeof value === 'number') {
				contextLength = value;
			}
		}
	}
	const capabilities = Array.isArray(body.capabilities) ? body.capabilities.filter((c): c is string => typeof c === 'string') : undefined;
	return { contextLength, capabilities };
}

/** The body of an Ollama `/api/chat` request. */
export interface OllamaChatRequestBody {
	readonly model: string;
	readonly messages: Record<string, unknown>[];
	readonly tools?: Record<string, unknown>[];
	readonly stream: true;
	readonly options: { readonly num_ctx: number; readonly num_predict: number };
}

/**
 * Builds an `/api/chat` request. Ollama has no equivalent of a required tool
 * call, so `toolCallRequired` isn't sent.
 */
export function buildOllamaChatRequest(model: ModelDescriptor, request: ChatRequest, contextWindow: number): OllamaChatRequestBody {
	const toolNames = new Map<string, string>();
	const messages: Record<string, unknown>[] = [];
	for (const message of request.messages) {
		messages.push(...toOllamaMessages(message, toolNames));
	}
	const tools = request.tools.map(tool => ({
		type: 'function',
		function: { name: tool.name, description: tool.description, parameters: tool.inputSchema ?? { type: 'object', properties: {} } },
	}));
	return {
		model: model.providerModelId,
		messages,
		...(tools.length > 0 ? { tools } : {}),
		stream: true,
		options: { num_ctx: contextWindow, num_predict: Math.min(request.maxOutputTokens ?? model.maxOutputTokens, model.maxOutputTokens) },
	};
}

function toOllamaMessages(message: ChatMessage, toolNames: Map<string, string>): Record<string, unknown>[] {
	const text: string[] = [];
	const images: string[] = [];
	const toolCalls: Record<string, unknown>[] = [];
	const toolResults: Record<string, unknown>[] = [];
	for (const part of message.content) {
		switch (part.type) {
			case 'text':
				text.push(part.text);
				break;
			case 'image':
				images.push(toBase64(part.data));
				break;
			case 'toolCall':
				toolNames.set(part.callId, part.name);
				toolCalls.push({ function: { name: part.name, arguments: part.input } });
				break;
			case 'toolResult': {
				const toolName = toolNames.get(part.callId);
				toolResults.push({ role: 'tool', content: part.text, ...(toolName ? { tool_name: toolName } : {}) });
				break;
			}
		}
	}
	const result: Record<string, unknown>[] = [...toolResults];
	if (text.length > 0 || images.length > 0 || toolCalls.length > 0) {
		result.push({
			role: message.role,
			content: text.join('\n'),
			...(images.length > 0 ? { images } : {}),
			...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
		});
	}
	return result;
}

/**
 * Parses Ollama's newline-delimited JSON chat stream.
 */
export async function parseOllamaChatStream(body: ReadableStream<Uint8Array>, onPart: (part: ResponsePart) => void, signal: AbortSignal, createCallId: () => string): Promise<ChatUsage> {
	for await (const line of readLines(body, signal, LABEL)) {
		if (!line.trim()) {
			continue;
		}
		let chunk: unknown;
		try {
			chunk = JSON.parse(line);
		} catch {
			throw new ProviderError(ProviderErrorKind.Unhealthy, `${LABEL} sent a malformed stream line`);
		}
		if (!isRecord(chunk)) {
			continue;
		}
		if (typeof chunk.error === 'string') {
			throw new ProviderError(ProviderErrorKind.Unhealthy, `${LABEL} stream error: ${chunk.error}`);
		}
		const message = isRecord(chunk.message) ? chunk.message : undefined;
		if (message && typeof message.content === 'string' && message.content) {
			onPart({ type: 'text', text: message.content });
		}
		if (message && Array.isArray(message.tool_calls)) {
			for (const call of message.tool_calls) {
				const fn = isRecord(call) && isRecord(call.function) ? call.function : undefined;
				if (!fn || typeof fn.name !== 'string') {
					continue;
				}
				const id = isRecord(call) && typeof call.id === 'string' && call.id ? call.id : createCallId();
				onPart({ type: 'toolCall', callId: id, name: fn.name, input: parseArguments(fn.arguments) });
			}
		}
		if (chunk.done === true) {
			return {
				...(typeof chunk.prompt_eval_count === 'number' ? { inputTokens: chunk.prompt_eval_count } : {}),
				...(typeof chunk.eval_count === 'number' ? { outputTokens: chunk.eval_count } : {}),
				...(typeof chunk.done_reason === 'string' ? { stopReason: chunk.done_reason } : {}),
			};
		}
	}
	throw new ProviderError(ProviderErrorKind.Unhealthy, `${LABEL} stream ended before the response was complete`);
}

function parseArguments(value: unknown): object {
	if (isRecord(value)) {
		return value;
	}
	if (typeof value === 'string') {
		try {
			const parsed: unknown = JSON.parse(value);
			return isRecord(parsed) ? parsed : {};
		} catch {
			return {};
		}
	}
	return {};
}
