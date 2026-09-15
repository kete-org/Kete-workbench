/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ProviderError, ProviderErrorKind } from './errors';
import { isRecord, readServerSentEvents, sendHttpRequest, toBase64 } from './http';
import { ChatMessage, ChatRequest, ChatUsage, ContentPart, FetchFunction, ModelDescriptor, ModelProvider, ModelTier, ResponsePart } from './types';

/** OpenAI's own address. Configurable, because the same wire format is served by
 *  other endpoints (Azure OpenAI, OpenRouter, vLLM, LM Studio). */
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * Default model ids. OpenAI renames and retires models, and an
 * OpenAI-compatible server serves entirely different ones, so both are
 * settings; these are only the starting values.
 */
export const DEFAULT_OPENAI_MID_MODEL = 'gpt-5-mini';
export const DEFAULT_OPENAI_FRONTIER_MODEL = 'gpt-5-codex';

const LABEL = 'OpenAI API';
const DEFAULT_MAX_OUTPUT_TOKENS = 32000;

/**
 * Conservative context limits, used because the Chat Completions API doesn't
 * report per-model limits. Too low only means Kete routes a large prompt up a
 * tier earlier than it had to.
 */
const OPENAI_MAX_INPUT_TOKENS = 128000;
const OPENAI_MAX_OUTPUT_TOKENS = 64000;

/** The two models this provider offers, one per cloud tier. */
export interface OpenAIModelIds {
	readonly mid: string;
	readonly frontier: string;
}

/** Dependencies of {@link OpenAIProvider}. */
export interface OpenAIProviderOptions {
	readonly fetch: FetchFunction;
	/** Reads the key from secret storage on each call, so a changed key applies at once. */
	readonly getApiKey: () => Promise<string | undefined>;
	/** Read on every call, so a changed setting applies at once. */
	readonly getBaseUrl: () => string;
	/** Read on every call, so a changed setting applies at once. */
	readonly getModelIds: () => OpenAIModelIds;
	readonly headersTimeoutMs?: number;
}

/**
 * Builds the descriptors for the configured model ids.
 */
export function openAiModels(ids: OpenAIModelIds): readonly ModelDescriptor[] {
	const models: ModelDescriptor[] = [];
	const add = (id: string, tier: ModelTier) => {
		const trimmed = id.trim();
		if (trimmed && !models.some(model => model.providerModelId === trimmed)) {
			models.push({
				vendor: 'openai',
				providerModelId: trimmed,
				displayName: trimmed,
				family: `openai/${trimmed}`,
				tier,
				maxInputTokens: OPENAI_MAX_INPUT_TOKENS,
				maxOutputTokens: OPENAI_MAX_OUTPUT_TOKENS,
				supportsToolCalling: true,
				supportsImages: true,
			});
		}
	};
	add(ids.mid, ModelTier.Mid);
	add(ids.frontier, ModelTier.Frontier);
	return models;
}

/**
 * The OpenAI Chat Completions API, streamed. Chat Completions rather than the
 * Responses API because it is the format every OpenAI-compatible server speaks,
 * which is what makes one setting enough to point Kete at Azure OpenAI,
 * OpenRouter, vLLM or LM Studio.
 *
 * Prompt caching needs no request fields here: OpenAI caches long prompt
 * prefixes automatically and reports the hits in `usage`, so the provider only
 * keeps the prefix stable (tools sorted by name, system message first) and
 * reports what came back.
 */
export class OpenAIProvider implements ModelProvider {
	public readonly id = 'openai';

	constructor(private readonly options: OpenAIProviderOptions) { }

	/** Whether an API key is stored. */
	async hasApiKey(): Promise<boolean> {
		return !!(await this.options.getApiKey());
	}

	async listModels(): Promise<readonly ModelDescriptor[]> {
		return (await this.hasApiKey()) ? openAiModels(this.options.getModelIds()) : [];
	}

	async probe(signal: AbortSignal): Promise<void> {
		const apiKey = await this.requireApiKey();
		try {
			await sendHttpRequest({
				fetch: this.options.fetch,
				url: `${this.baseUrl()}/models`,
				init: { method: 'GET', headers: this.headers(apiKey) },
				signal,
				headersTimeoutMs: 5000,
				label: LABEL,
			});
		} catch (error) {
			// A rejected key still proves the service is reachable.
			if (error instanceof ProviderError && error.kind === ProviderErrorKind.Auth) {
				return;
			}
			throw error;
		}
	}

	/**
	 * Checks a key before it is stored. Resolves `false` if the API rejects it;
	 * throws if the API can't be reached, so an offline user can still store one.
	 */
	async verifyApiKey(apiKey: string, signal: AbortSignal): Promise<boolean> {
		try {
			await sendHttpRequest({
				fetch: this.options.fetch,
				url: `${this.baseUrl()}/models`,
				init: { method: 'GET', headers: this.headers(apiKey) },
				signal,
				headersTimeoutMs: 5000,
				label: LABEL,
			});
			return true;
		} catch (error) {
			if (error instanceof ProviderError && error.kind === ProviderErrorKind.Auth) {
				return false;
			}
			throw error;
		}
	}

	async chat(model: ModelDescriptor, request: ChatRequest, onPart: (part: ResponsePart) => void, signal: AbortSignal): Promise<ChatUsage> {
		const apiKey = await this.requireApiKey();
		const body = buildChatCompletionsRequest(model, request);
		const response = await sendHttpRequest({
			fetch: this.options.fetch,
			url: `${this.baseUrl()}/chat/completions`,
			init: { method: 'POST', headers: { ...this.headers(apiKey), 'content-type': 'application/json' }, body: JSON.stringify(body) },
			signal,
			headersTimeoutMs: this.options.headersTimeoutMs ?? 60000,
			label: LABEL,
		});
		if (!response.body) {
			throw new ProviderError(ProviderErrorKind.Unhealthy, `${LABEL} returned an empty response`);
		}
		return parseChatCompletionsStream(response.body, onPart, signal);
	}

	private async requireApiKey(): Promise<string> {
		const apiKey = await this.options.getApiKey();
		if (!apiKey) {
			throw new ProviderError(ProviderErrorKind.Auth, 'No OpenAI API key is set');
		}
		return apiKey;
	}

	private headers(apiKey: string): Record<string, string> {
		return { authorization: `Bearer ${apiKey}` };
	}

	/** The configured base URL, without a trailing slash. */
	private baseUrl(): string {
		const raw = this.options.getBaseUrl().trim() || DEFAULT_OPENAI_BASE_URL;
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			throw new ProviderError(ProviderErrorKind.BadRequest, 'The OpenAI endpoint setting is not a valid URL');
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			throw new ProviderError(ProviderErrorKind.BadRequest, 'The OpenAI endpoint setting must be an http or https URL');
		}
		return raw.replace(/\/+$/, '');
	}
}

type OpenAIContent = string | Record<string, unknown>[];
interface OpenAIMessage {
	readonly role: 'system' | 'user' | 'assistant' | 'tool';
	content: OpenAIContent;
	tool_calls?: Record<string, unknown>[];
	readonly tool_call_id?: string;
}

/** The body of a Chat Completions request. */
export interface ChatCompletionsRequestBody {
	readonly model: string;
	readonly stream: true;
	readonly stream_options: { readonly include_usage: true };
	readonly max_completion_tokens: number;
	readonly messages: OpenAIMessage[];
	readonly tools?: Record<string, unknown>[];
	readonly tool_choice?: 'required';
}

/**
 * Builds a Chat Completions request body.
 *
 * Tool results are their own `role: 'tool'` messages rather than parts of a user
 * turn, and a tool call belongs to the assistant message that made it, so the
 * conversation is rebuilt rather than mapped part by part. Tools are sorted by
 * name to keep the cached prefix stable between turns.
 */
export function buildChatCompletionsRequest(model: ModelDescriptor, request: ChatRequest): ChatCompletionsRequestBody {
	const messages: OpenAIMessage[] = [];

	for (const message of request.messages) {
		if (message.role === 'system') {
			const text = textOf(message.content);
			if (text) {
				messages.push({ role: 'system', content: text });
			}
			continue;
		}

		// Tool results must be separate messages, and must follow the assistant
		// message whose tool calls they answer.
		for (const part of message.content) {
			if (part.type === 'toolResult') {
				messages.push({ role: 'tool', tool_call_id: part.callId, content: part.isError ? `Error: ${part.text || '(empty)'}` : part.text || '(empty)' });
			}
		}

		const content = toOpenAIContent(message);
		const toolCalls = message.role === 'assistant'
			? message.content.filter((part): part is Extract<ContentPart, { type: 'toolCall' }> => part.type === 'toolCall')
				.map(part => ({ id: part.callId, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) } }))
			: [];
		if (content.length === 0 && toolCalls.length === 0) {
			continue;
		}
		const entry: OpenAIMessage = { role: message.role, content: content.length > 0 ? content : '' };
		if (toolCalls.length > 0) {
			entry.tool_calls = toolCalls;
		}
		messages.push(entry);
	}

	const tools = [...request.tools]
		.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
		.map(tool => ({
			type: 'function',
			function: { name: tool.name, description: tool.description, parameters: tool.inputSchema ?? { type: 'object', properties: {} } },
		}));

	return {
		model: model.providerModelId,
		stream: true,
		stream_options: { include_usage: true },
		max_completion_tokens: Math.min(request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, model.maxOutputTokens),
		messages,
		...(tools.length > 0 ? { tools } : {}),
		...(tools.length > 0 && request.toolCallRequired ? { tool_choice: 'required' as const } : {}),
	};
}

function textOf(content: readonly ContentPart[]): string {
	return content.filter(part => part.type === 'text').map(part => part.text).join('\n');
}

/** Everything but tool calls and tool results, which are messages of their own. */
function toOpenAIContent(message: ChatMessage): Record<string, unknown>[] {
	const parts: Record<string, unknown>[] = [];
	for (const part of message.content) {
		if (part.type === 'text') {
			if (part.text) {
				parts.push({ type: 'text', text: part.text });
			}
		} else if (part.type === 'image' && message.role === 'user') {
			parts.push({ type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${toBase64(part.data)}` } });
		}
	}
	return parts;
}

/**
 * Parses a Chat Completions event stream. Text is passed on as it arrives; a
 * tool call is passed on once the stream moves past it, because its arguments
 * arrive in pieces across deltas.
 */
export async function parseChatCompletionsStream(body: ReadableStream<Uint8Array>, onPart: (part: ResponsePart) => void, signal: AbortSignal): Promise<ChatUsage> {
	const toolCalls = new Map<number, { id: string; name: string; json: string }>();
	let usage: { -readonly [K in keyof ChatUsage]: ChatUsage[K] } = {};
	let completed = false;

	for await (const sse of readServerSentEvents(body, signal, LABEL)) {
		if (sse.data === '[DONE]') {
			completed = true;
			continue;
		}
		let event: unknown;
		try {
			event = JSON.parse(sse.data);
		} catch {
			throw new ProviderError(ProviderErrorKind.Unhealthy, `${LABEL} sent a malformed event`);
		}
		if (!isRecord(event)) {
			continue;
		}
		// Some servers report a mid-stream failure as an error object rather than
		// an HTTP status.
		if (isRecord(event.error)) {
			const message = typeof event.error.message === 'string' ? event.error.message : 'unknown error';
			const type = typeof event.error.type === 'string' ? event.error.type : 'error';
			throw new ProviderError(errorKindForType(type), `${LABEL} stream error (${type}): ${message}`);
		}
		usage = { ...usage, ...readUsage(event.usage) };

		const choices = Array.isArray(event.choices) ? event.choices : [];
		for (const choice of choices) {
			if (!isRecord(choice)) {
				continue;
			}
			if (typeof choice.finish_reason === 'string') {
				usage = { ...usage, stopReason: choice.finish_reason };
				// Arguments are complete once the model stops.
				flushToolCalls(toolCalls, onPart);
				completed = true;
			}
			const delta = isRecord(choice.delta) ? choice.delta : undefined;
			if (!delta) {
				continue;
			}
			if (typeof delta.content === 'string' && delta.content) {
				onPart({ type: 'text', text: delta.content });
			}
			if (Array.isArray(delta.tool_calls)) {
				readToolCallDeltas(delta.tool_calls, toolCalls);
			}
		}
	}

	flushToolCalls(toolCalls, onPart);
	if (!completed) {
		throw new ProviderError(ProviderErrorKind.Unhealthy, `${LABEL} stream ended before the message was complete`);
	}
	return usage;
}

/**
 * Accumulates tool call deltas. Only the first delta of a call carries its id
 * and name; later ones extend its arguments, keyed by `index`.
 */
function readToolCallDeltas(deltas: readonly unknown[], toolCalls: Map<number, { id: string; name: string; json: string }>): void {
	for (const value of deltas) {
		if (!isRecord(value)) {
			continue;
		}
		const index = typeof value.index === 'number' ? value.index : 0;
		const call = toolCalls.get(index) ?? { id: '', name: '', json: '' };
		if (typeof value.id === 'string' && value.id) {
			call.id = value.id;
		}
		const fn = isRecord(value.function) ? value.function : undefined;
		if (fn) {
			if (typeof fn.name === 'string' && fn.name) {
				call.name = fn.name;
			}
			if (typeof fn.arguments === 'string') {
				call.json += fn.arguments;
			}
		}
		toolCalls.set(index, call);
	}
}

function flushToolCalls(toolCalls: Map<number, { id: string; name: string; json: string }>, onPart: (part: ResponsePart) => void): void {
	for (const [index, call] of [...toolCalls].sort((a, b) => a[0] - b[0])) {
		toolCalls.delete(index);
		if (!call.name) {
			continue;
		}
		onPart({ type: 'toolCall', callId: call.id || `openai_call_${index}`, name: call.name, input: parseToolInput(call.json) });
	}
}

function parseToolInput(json: string): object {
	if (!json.trim()) {
		return {};
	}
	try {
		const value: unknown = JSON.parse(json);
		return isRecord(value) ? value : {};
	} catch {
		throw new ProviderError(ProviderErrorKind.Unhealthy, `${LABEL} sent incomplete tool call input`);
	}
}

function errorKindForType(type: string): ProviderErrorKind {
	switch (type) {
		case 'invalid_request_error': return ProviderErrorKind.BadRequest;
		case 'authentication_error': case 'permission_error': case 'insufficient_quota': return ProviderErrorKind.Auth;
		case 'not_found_error': return ProviderErrorKind.NotFound;
		default: return ProviderErrorKind.Unhealthy;
	}
}

/**
 * Reads token counts. `prompt_tokens` counts cached and uncached input
 * together, so the cached part is subtracted to match what the other providers
 * report.
 */
function readUsage(value: unknown): ChatUsage {
	if (!isRecord(value)) {
		return {};
	}
	const usage: { -readonly [K in keyof ChatUsage]: ChatUsage[K] } = {};
	const details = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : undefined;
	const cached = typeof details?.cached_tokens === 'number' ? details.cached_tokens : undefined;
	if (typeof value.prompt_tokens === 'number') {
		usage.inputTokens = cached === undefined ? value.prompt_tokens : Math.max(0, value.prompt_tokens - cached);
	}
	if (typeof value.completion_tokens === 'number') {
		usage.outputTokens = value.completion_tokens;
	}
	if (cached !== undefined) {
		usage.cacheReadInputTokens = cached;
	}
	return usage;
}
