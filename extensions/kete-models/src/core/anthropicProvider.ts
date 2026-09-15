/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ProviderError, ProviderErrorKind } from './errors';
import { isRecord, readServerSentEvents, sendHttpRequest, toBase64 } from './http';
import { ChatMessage, ChatRequest, ChatUsage, ContentPart, FetchFunction, ModelDescriptor, ModelProvider, ModelTier, ResponsePart } from './types';

/** The Claude API's address. Not configurable, so no setting can redirect it. */
export const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com';

const ANTHROPIC_VERSION = '2023-06-01';
const LABEL = 'Claude API';
const DEFAULT_MAX_OUTPUT_TOKENS = 32000;

/** Claude model ids Kete routes to. */
export const ClaudeModelId = {
	Haiku: 'claude-haiku-4-5-20251001',
	Sonnet: 'claude-sonnet-5',
	Opus: 'claude-opus-5',
} as const;

/**
 * The Claude models Kete offers, cheapest first. Limits are conservative
 * defaults; the Models API is authoritative.
 */
export const CLAUDE_MODELS: readonly ModelDescriptor[] = [
	{ vendor: 'anthropic', providerModelId: ClaudeModelId.Haiku, displayName: 'Claude Haiku 4.5', family: 'claude-haiku-4-5', tier: ModelTier.Mid, maxInputTokens: 200000, maxOutputTokens: 64000, supportsToolCalling: true, supportsImages: true },
	{ vendor: 'anthropic', providerModelId: ClaudeModelId.Sonnet, displayName: 'Claude Sonnet 5', family: 'claude-sonnet-5', tier: ModelTier.Frontier, maxInputTokens: 200000, maxOutputTokens: 64000, supportsToolCalling: true, supportsImages: true },
	{ vendor: 'anthropic', providerModelId: ClaudeModelId.Opus, displayName: 'Claude Opus 5', family: 'claude-opus-5', tier: ModelTier.Frontier, maxInputTokens: 200000, maxOutputTokens: 64000, supportsToolCalling: true, supportsImages: true },
];

/** Dependencies of {@link AnthropicProvider}. */
export interface AnthropicProviderOptions {
	readonly fetch: FetchFunction;
	/** Reads the key from secret storage on each call, so a changed key applies at once. */
	readonly getApiKey: () => Promise<string | undefined>;
	readonly headersTimeoutMs?: number;
}

/**
 * The Claude Messages API, streamed. Stable prompt prefixes carry
 * `cache_control` breakpoints, because cached input costs a tenth of uncached
 * input and agent conversations resend the same prefix every turn.
 */
export class AnthropicProvider implements ModelProvider {
	public readonly id = 'anthropic';

	constructor(private readonly options: AnthropicProviderOptions) { }

	/** Whether an API key is stored. */
	async hasApiKey(): Promise<boolean> {
		return !!(await this.options.getApiKey());
	}

	async listModels(): Promise<readonly ModelDescriptor[]> {
		return (await this.hasApiKey()) ? CLAUDE_MODELS : [];
	}

	async probe(signal: AbortSignal): Promise<void> {
		const apiKey = await this.requireApiKey();
		try {
			await sendHttpRequest({
				fetch: this.options.fetch,
				url: `${ANTHROPIC_API_BASE_URL}/v1/models?limit=1`,
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
				url: `${ANTHROPIC_API_BASE_URL}/v1/models?limit=1`,
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
		const body = buildMessagesRequest(model, request);
		const response = await sendHttpRequest({
			fetch: this.options.fetch,
			url: `${ANTHROPIC_API_BASE_URL}/v1/messages`,
			init: { method: 'POST', headers: { ...this.headers(apiKey), 'content-type': 'application/json' }, body: JSON.stringify(body) },
			signal,
			headersTimeoutMs: this.options.headersTimeoutMs ?? 60000,
			label: LABEL,
		});
		if (!response.body) {
			throw new ProviderError(ProviderErrorKind.Unhealthy, `${LABEL} returned an empty response`);
		}
		return parseMessagesStream(response.body, onPart, signal);
	}

	private async requireApiKey(): Promise<string> {
		const apiKey = await this.options.getApiKey();
		if (!apiKey) {
			throw new ProviderError(ProviderErrorKind.Auth, 'No Claude API key is set');
		}
		return apiKey;
	}

	private headers(apiKey: string): Record<string, string> {
		return { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION };
	}
}

type CacheControl = { readonly type: 'ephemeral' };
type AnthropicBlock = Record<string, unknown> & { cache_control?: CacheControl };
interface AnthropicMessage {
	readonly role: 'user' | 'assistant';
	readonly content: AnthropicBlock[];
}

/** The body of a Messages API request. */
export interface MessagesRequestBody {
	readonly model: string;
	readonly max_tokens: number;
	readonly stream: true;
	readonly system?: AnthropicBlock[];
	readonly messages: AnthropicMessage[];
	readonly tools?: AnthropicBlock[];
	readonly tool_choice?: { readonly type: 'any' };
}

const EPHEMERAL: CacheControl = { type: 'ephemeral' };

/**
 * Builds a Messages API request body.
 *
 * Caching: the prompt renders as tools, then system, then messages, and a cache
 * hit needs an identical prefix. Tools are sorted by name so their order can't
 * vary, and there are three breakpoints (the API allows four): the last tool,
 * the last system block, and the last block of the conversation, so the next
 * turn reads everything before its own new message from cache. Prefixes below
 * the model's minimum length simply aren't cached; that costs nothing.
 */
export function buildMessagesRequest(model: ModelDescriptor, request: ChatRequest): MessagesRequestBody {
	const system: AnthropicBlock[] = [];
	const messages: AnthropicMessage[] = [];

	for (const message of request.messages) {
		if (message.role === 'system') {
			for (const part of message.content) {
				if (part.type === 'text' && part.text) {
					system.push({ type: 'text', text: part.text });
				}
			}
			continue;
		}
		const content = toAnthropicContent(message);
		if (content.length === 0) {
			continue;
		}
		const previous = messages[messages.length - 1];
		if (previous && previous.role === message.role) {
			previous.content.push(...content);
			sortToolResultsFirst(previous);
		} else {
			messages.push({ role: message.role, content });
		}
	}

	const tools: AnthropicBlock[] = [...request.tools]
		.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
		.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema ?? { type: 'object', properties: {} } }));

	if (tools.length > 0) {
		tools[tools.length - 1].cache_control = EPHEMERAL;
	}
	if (system.length > 0) {
		system[system.length - 1].cache_control = EPHEMERAL;
	}
	const lastMessage = messages[messages.length - 1];
	if (lastMessage) {
		lastMessage.content[lastMessage.content.length - 1].cache_control = EPHEMERAL;
	}

	return {
		model: model.providerModelId,
		max_tokens: Math.min(request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, model.maxOutputTokens),
		stream: true,
		...(system.length > 0 ? { system } : {}),
		messages,
		...(tools.length > 0 ? { tools } : {}),
		...(tools.length > 0 && request.toolCallRequired ? { tool_choice: { type: 'any' } as const } : {}),
	};
}

function toAnthropicContent(message: ChatMessage): AnthropicBlock[] {
	const blocks: AnthropicBlock[] = [];
	for (const part of message.content) {
		const block = toAnthropicBlock(part, message.role);
		if (block) {
			blocks.push(block);
		}
	}
	// The API requires tool results to lead a user turn.
	return blocks.sort((a, b) => Number(b.type === 'tool_result') - Number(a.type === 'tool_result'));
}

function sortToolResultsFirst(message: AnthropicMessage): void {
	message.content.sort((a, b) => Number(b.type === 'tool_result') - Number(a.type === 'tool_result'));
}

function toAnthropicBlock(part: ContentPart, role: ChatMessage['role']): AnthropicBlock | undefined {
	switch (part.type) {
		case 'text':
			// The API rejects empty text blocks.
			return part.text ? { type: 'text', text: part.text } : undefined;
		case 'image':
			return role === 'user'
				? { type: 'image', source: { type: 'base64', media_type: part.mimeType, data: toBase64(part.data) } }
				: undefined;
		case 'toolCall':
			return role === 'assistant' ? { type: 'tool_use', id: part.callId, name: part.name, input: part.input } : undefined;
		case 'toolResult':
			return role === 'user'
				? { type: 'tool_result', tool_use_id: part.callId, content: part.text || '(empty)', ...(part.isError ? { is_error: true } : {}) }
				: undefined;
	}
}

/**
 * Parses a Messages API event stream. Text is passed on as it arrives; a tool
 * call is passed on once its input JSON is complete.
 */
export async function parseMessagesStream(body: ReadableStream<Uint8Array>, onPart: (part: ResponsePart) => void, signal: AbortSignal): Promise<ChatUsage> {
	const toolCalls = new Map<number, { id: string; name: string; json: string }>();
	let usage: { -readonly [K in keyof ChatUsage]: ChatUsage[K] } = {};
	let completed = false;

	for await (const sse of readServerSentEvents(body, signal, LABEL)) {
		let event: unknown;
		try {
			event = JSON.parse(sse.data);
		} catch {
			throw new ProviderError(ProviderErrorKind.Unhealthy, `${LABEL} sent a malformed event`);
		}
		if (!isRecord(event)) {
			continue;
		}
		switch (event.type) {
			case 'message_start': {
				const message = isRecord(event.message) ? event.message : undefined;
				usage = { ...usage, ...readUsage(message?.usage) };
				break;
			}
			case 'content_block_start': {
				const block = isRecord(event.content_block) ? event.content_block : undefined;
				if (block?.type === 'tool_use' && typeof event.index === 'number' && typeof block.id === 'string' && typeof block.name === 'string') {
					toolCalls.set(event.index, { id: block.id, name: block.name, json: '' });
				} else if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
					onPart({ type: 'text', text: block.text });
				}
				break;
			}
			case 'content_block_delta': {
				const delta = isRecord(event.delta) ? event.delta : undefined;
				if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
					onPart({ type: 'text', text: delta.text });
				} else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string' && typeof event.index === 'number') {
					const call = toolCalls.get(event.index);
					if (call) {
						call.json += delta.partial_json;
					}
				}
				// Thinking and signature deltas are not requested and are ignored.
				break;
			}
			case 'content_block_stop': {
				const call = typeof event.index === 'number' ? toolCalls.get(event.index) : undefined;
				if (call) {
					toolCalls.delete(event.index as number);
					onPart({ type: 'toolCall', callId: call.id, name: call.name, input: parseToolInput(call.json) });
				}
				break;
			}
			case 'message_delta': {
				const delta = isRecord(event.delta) ? event.delta : undefined;
				usage = { ...usage, ...readUsage(event.usage), ...(typeof delta?.stop_reason === 'string' ? { stopReason: delta.stop_reason } : {}) };
				break;
			}
			case 'message_stop':
				completed = true;
				break;
			case 'error': {
				const error = isRecord(event.error) ? event.error : undefined;
				const type = typeof error?.type === 'string' ? error.type : 'error';
				const message = typeof error?.message === 'string' ? error.message : 'unknown error';
				const kind = type === 'invalid_request_error' ? ProviderErrorKind.BadRequest
					: type === 'authentication_error' || type === 'permission_error' ? ProviderErrorKind.Auth
						: type === 'not_found_error' ? ProviderErrorKind.NotFound
							: ProviderErrorKind.Unhealthy;
				throw new ProviderError(kind, `${LABEL} stream error (${type}): ${message}`);
			}
		}
	}

	if (!completed) {
		throw new ProviderError(ProviderErrorKind.Unhealthy, `${LABEL} stream ended before the message was complete`);
	}
	return usage;
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

function readUsage(value: unknown): ChatUsage {
	if (!isRecord(value)) {
		return {};
	}
	const usage: { -readonly [K in keyof ChatUsage]: ChatUsage[K] } = {};
	if (typeof value.input_tokens === 'number') {
		usage.inputTokens = value.input_tokens;
	}
	if (typeof value.output_tokens === 'number') {
		usage.outputTokens = value.output_tokens;
	}
	if (typeof value.cache_creation_input_tokens === 'number') {
		usage.cacheCreationInputTokens = value.cache_creation_input_tokens;
	}
	if (typeof value.cache_read_input_tokens === 'number') {
		usage.cacheReadInputTokens = value.cache_read_input_tokens;
	}
	return usage;
}
