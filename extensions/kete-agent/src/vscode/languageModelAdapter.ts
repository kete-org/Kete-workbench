/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Adapts the portable agent core to `vscode.lm`. This is the only place the agent
// talks to models and tools, and it does so exclusively through
// `LanguageModelChat.sendRequest` and `vscode.lm.invokeTool`. Both end in the
// workbench's `sendChatRequest` and `invokeTool`, where the governance gate
// records and authorizes them (D-003). The agent carries no gate of its own.

import * as vscode from 'vscode';
import { AgentMessage, AgentModel, AgentModelRequest, AgentModelResponsePart, AgentToolCall, AgentToolDefinition, AgentToolInvoker, ToolOutcome } from '../core/agentTypes';
import { isGovernanceDenial } from '../core/governance';

/**
 * An {@link AgentModel} backed by a `vscode.LanguageModelChat`.
 */
export class VsCodeAgentModel implements AgentModel {

	constructor(
		private readonly model: vscode.LanguageModelChat,
		private readonly token: vscode.CancellationToken,
		private readonly modelOptions: { readonly [name: string]: unknown } | undefined,
	) { }

	get maxInputTokens(): number {
		return this.model.maxInputTokens;
	}

	async *send(request: AgentModelRequest): AsyncIterable<AgentModelResponsePart> {
		// The stable API has no system role, so the system prompt is sent as the
		// first user message, which every provider accepts.
		const messages = [vscode.LanguageModelChatMessage.User(request.system), ...request.messages.map(toChatMessage)];
		const response = await this.model.sendRequest(messages, {
			tools: request.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
			toolMode: vscode.LanguageModelChatToolMode.Auto,
			modelOptions: this.modelOptions,
		}, this.token);

		for await (const part of response.stream) {
			if (part instanceof vscode.LanguageModelTextPart) {
				yield { kind: 'text', text: part.value };
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				yield { kind: 'toolCall', call: { callId: part.callId, name: part.name, input: part.input } };
			}
		}
	}
}

/**
 * An {@link AgentToolInvoker} that runs every call through `vscode.lm.invokeTool`
 * with the chat request's invocation token, so confirmations appear in the chat
 * and the governance gate authorizes the call before it runs.
 */
export class VsCodeToolInvoker implements AgentToolInvoker {

	constructor(
		private readonly toolInvocationToken: vscode.ChatParticipantToolToken,
		private readonly token: vscode.CancellationToken,
	) { }

	async invoke(call: AgentToolCall): Promise<ToolOutcome> {
		try {
			const result = await vscode.lm.invokeTool(call.name, { input: call.input, toolInvocationToken: this.toolInvocationToken }, this.token);
			const text = toolResultToText(result);
			return isGovernanceDenial(text) ? { kind: 'governanceDenied', text } : { kind: 'completed', text };
		} catch (error) {
			if (this.token.isCancellationRequested) {
				return { kind: 'cancelled' };
			}
			// Declining a tool's confirmation surfaces as a cancellation of that call.
			if (isCancellationError(error)) {
				return { kind: 'userDeclined' };
			}
			return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
		}
	}
}

/**
 * Describes the tools to offer the model. When the person picked tools for this
 * request, only those are offered; tools they referenced explicitly come first.
 */
export function selectTools(request: vscode.ChatRequest, maxTools: number): AgentToolDefinition[] {
	const all = vscode.lm.tools;
	const picked = request.tools?.size
		? new Set([...request.tools].filter(([, enabled]) => enabled).map(([tool]) => tool.name))
		: undefined;
	const referenced = new Set(request.toolReferences.map(reference => reference.name));

	return all
		.filter(tool => referenced.has(tool.name) || !picked || picked.has(tool.name))
		.sort((a, b) => Number(referenced.has(b.name)) - Number(referenced.has(a.name)))
		.slice(0, maxTools)
		.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
}

/**
 * Converts earlier turns of this conversation into agent messages. Only text is
 * carried over; earlier tool calls live in those turns' rendered responses.
 */
export function toAgentHistory(history: vscode.ChatContext['history']): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (const turn of history) {
		if (turn instanceof vscode.ChatRequestTurn) {
			if (turn.prompt.trim()) {
				messages.push({ role: 'user', parts: [{ kind: 'text', text: turn.prompt }] });
			}
		} else if (turn instanceof vscode.ChatResponseTurn) {
			const text = turn.response
				.map(part => part instanceof vscode.ChatResponseMarkdownPart ? part.value.value : '')
				.join('')
				.trim();
			if (text) {
				messages.push({ role: 'assistant', parts: [{ kind: 'text', text }] });
			}
		}
	}
	return messages;
}

function toChatMessage(message: AgentMessage): vscode.LanguageModelChatMessage {
	const parts = message.parts.map(part => {
		switch (part.kind) {
			case 'text':
				return new vscode.LanguageModelTextPart(part.text);
			case 'toolCall':
				return new vscode.LanguageModelToolCallPart(part.call.callId, part.call.name, part.call.input);
			case 'toolResult':
				return new vscode.LanguageModelToolResultPart(part.callId, [new vscode.LanguageModelTextPart(part.text)]);
		}
	});
	return message.role === 'user'
		? vscode.LanguageModelChatMessage.User(parts as (vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart)[])
		: vscode.LanguageModelChatMessage.Assistant(parts as (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[]);
}

function toolResultToText(result: vscode.LanguageModelToolResult): string {
	const decoder = new TextDecoder();
	return result.content.map(part => {
		if (part instanceof vscode.LanguageModelTextPart) {
			return part.value;
		}
		if (part instanceof vscode.LanguageModelPromptTsxPart) {
			return JSON.stringify(part.value);
		}
		if (part instanceof vscode.LanguageModelDataPart && (part.mimeType.startsWith('text/') || part.mimeType.includes('json'))) {
			return decoder.decode(part.data);
		}
		return '';
	}).filter(Boolean).join('\n');
}

function isCancellationError(error: unknown): boolean {
	return error instanceof vscode.CancellationError || (error instanceof Error && error.name === 'Canceled');
}
