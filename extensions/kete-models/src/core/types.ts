/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The portable model core. Nothing under `core/` imports `vscode`, so a CLI or
// JetBrains client can reuse providers, routing and connectivity (D-010).

/**
 * Cost tiers, cheapest first. Their numeric order is what the router compares.
 */
export enum ModelTier {
	/** A model served by Ollama on this machine or the user's own server. No per-token cost. */
	Local = 0,
	/** An inexpensive cloud model (Claude Haiku 4.5). */
	Mid = 1,
	/** The most capable, most expensive cloud models (Claude Sonnet 5, Claude Opus 5). */
	Frontier = 2,
}

/**
 * Parses a tier name as used in settings and request hints.
 */
export function parseModelTier(value: unknown): ModelTier | undefined {
	switch (value) {
		case 'local': return ModelTier.Local;
		case 'mid': return ModelTier.Mid;
		case 'frontier': return ModelTier.Frontier;
		default: return undefined;
	}
}

/**
 * The name of a tier, for settings, hints and logs.
 */
export function modelTierName(tier: ModelTier): 'local' | 'mid' | 'frontier' {
	switch (tier) {
		case ModelTier.Local: return 'local';
		case ModelTier.Mid: return 'mid';
		case ModelTier.Frontier: return 'frontier';
	}
}

/** Text content. */
export interface TextPart {
	readonly type: 'text';
	readonly text: string;
}

/** An image, as raw bytes. */
export interface ImagePart {
	readonly type: 'image';
	readonly mimeType: string;
	readonly data: Uint8Array;
}

/** A tool call the model made in an earlier assistant turn. */
export interface ToolCallPart {
	readonly type: 'toolCall';
	readonly callId: string;
	readonly name: string;
	readonly input: object;
}

/** The result of a tool call, sent back in a user turn. */
export interface ToolResultPart {
	readonly type: 'toolResult';
	readonly callId: string;
	readonly text: string;
	readonly isError?: boolean;
}

/** Anything a request message may contain. */
export type ContentPart = TextPart | ImagePart | ToolCallPart | ToolResultPart;

/** One message of a conversation. */
export interface ChatMessage {
	readonly role: 'system' | 'user' | 'assistant';
	readonly content: readonly ContentPart[];
}

/** A tool the model may call. */
export interface ChatTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema?: object;
}

/** A provider-neutral chat request. */
export interface ChatRequest {
	readonly messages: readonly ChatMessage[];
	readonly tools: readonly ChatTool[];
	/** Whether the model must call a tool. */
	readonly toolCallRequired: boolean;
	readonly maxOutputTokens?: number;
}

/** What a provider streams back. */
export type ResponsePart = TextPart | ToolCallPart;

/** Token counts a provider reported for one request, when it reports them. */
export interface ChatUsage {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	/** Prompt tokens written to the provider's prompt cache (billed at a premium). */
	readonly cacheCreationInputTokens?: number;
	/** Prompt tokens served from the provider's prompt cache (billed at a discount). */
	readonly cacheReadInputTokens?: number;
	readonly stopReason?: string;
}

/** A model a provider can serve. */
export interface ModelDescriptor {
	/** The provider's own model name, e.g. `qwen2.5-coder:7b` or `claude-sonnet-5`. */
	readonly providerModelId: string;
	readonly displayName: string;
	readonly family: string;
	readonly tier: ModelTier;
	readonly maxInputTokens: number;
	readonly maxOutputTokens: number;
	/** `undefined` when the provider didn't say. */
	readonly supportsToolCalling: boolean | undefined;
	readonly supportsImages: boolean | undefined;
}

/** A disposable resource. */
export interface Disposable {
	dispose(): void;
}

/**
 * A model backend (D-010's `ModelProvider`): Ollama, the Claude API, and later
 * others. Providers only translate and transport. They don't route, retry or
 * decide connectivity; errors are thrown as `ProviderError`.
 */
export interface ModelProvider {
	readonly id: string;
	/** Models this provider can serve right now. */
	listModels(signal: AbortSignal): Promise<readonly ModelDescriptor[]>;
	/**
	 * Streams a response. Parts are passed to `onPart` as they arrive; the promise
	 * resolves when the response is complete.
	 */
	chat(model: ModelDescriptor, request: ChatRequest, onPart: (part: ResponsePart) => void, signal: AbortSignal): Promise<ChatUsage>;
	/** A cheap reachability check, for the connectivity monitor. */
	probe(signal: AbortSignal): Promise<void>;
}

/** The subset of `fetch` the providers use, so tests can substitute recorded responses. */
export type FetchFunction = (input: string, init: RequestInit) => Promise<Response>;
