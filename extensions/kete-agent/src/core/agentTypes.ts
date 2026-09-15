/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The agent core's own vocabulary. Everything under `core/` is portable (D-010):
// it imports nothing from `vscode` or Node, so the same loop can back the fork,
// the CLI and other thin clients. Each client supplies adapters for these
// interfaces; in the fork they wrap `vscode.lm`, whose model requests and tool
// calls pass through the governance gate (D-003).

/**
 * Structurally compatible with `vscode.CancellationToken`.
 */
export interface CancellationSignal {
	readonly isCancellationRequested: boolean;
}

/**
 * Something that can be disposed. Structurally compatible with `vscode.Disposable`.
 */
export interface DisposableLike {
	dispose(): void;
}

/**
 * A tool the model may call, as described to the model.
 */
export interface AgentToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema?: object;
}

/**
 * A tool call requested by the model.
 */
export interface AgentToolCall {
	readonly callId: string;
	readonly name: string;
	readonly input: object;
}

/**
 * How a tool call ended, as seen by the agent loop.
 *
 * - `completed`: the tool ran and returned `text`.
 * - `governanceDenied`: the governance gate refused the call. It was not performed.
 * - `userDeclined`: the person declined the call in its confirmation. It was not performed.
 * - `error`: the tool, or invoking it, failed.
 * - `cancelled`: the request was cancelled while the tool was pending.
 */
export type ToolOutcome =
	| { readonly kind: 'completed'; readonly text: string }
	| { readonly kind: 'governanceDenied'; readonly text: string }
	| { readonly kind: 'userDeclined' }
	| { readonly kind: 'error'; readonly message: string }
	| { readonly kind: 'cancelled' };

/**
 * A part of a message in the agent transcript.
 */
export type AgentMessagePart =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'toolCall'; readonly call: AgentToolCall }
	| { readonly kind: 'toolResult'; readonly callId: string; readonly text: string };

/**
 * A message in the agent transcript. System instructions are not a message;
 * they travel separately in {@link AgentModelRequest.system}.
 */
export interface AgentMessage {
	readonly role: 'user' | 'assistant';
	readonly parts: readonly AgentMessagePart[];
}

/**
 * One request to a model.
 */
export interface AgentModelRequest {
	readonly system: string;
	readonly messages: readonly AgentMessage[];
	readonly tools: readonly AgentToolDefinition[];
}

/**
 * A streamed piece of a model response.
 */
export type AgentModelResponsePart =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'toolCall'; readonly call: AgentToolCall };

/**
 * A language model, as the agent core uses it.
 */
export interface AgentModel {
	/** Upper bound on the tokens a request may contain. */
	readonly maxInputTokens: number;
	send(request: AgentModelRequest, signal: CancellationSignal): AsyncIterable<AgentModelResponsePart>;
}

/**
 * Runs tool calls on the agent's behalf. In the fork every call goes through
 * `vscode.lm.invokeTool`, and so through the governance gate.
 */
export interface AgentToolInvoker {
	invoke(call: AgentToolCall, signal: CancellationSignal): Promise<ToolOutcome>;
}

/**
 * Receives what the agent produces while it runs.
 */
export interface AgentProgress {
	/** A chunk of the model's answer, to show as it arrives. */
	text(chunk: string): void;
}
