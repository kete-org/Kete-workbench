/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Token-budgeted assembly of what one request sends: the system prompt, as much
// recent history as fits, and the person's message with its retrieved context.
// Budgets use a cheap character estimate rather than a tokenizer round trip per
// message, which matters most on the slow local-model path.

import { AgentMessage, AgentToolDefinition } from './agentTypes';

/** Characters per token assumed by {@link estimateTokens}. */
const CHARS_PER_TOKEN = 4;

/**
 * A rough token count for text: about four characters per token. It errs high
 * for code, which leaves headroom.
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * A piece of retrieved context, such as a file the person attached.
 */
export interface ContextItem {
	readonly label: string;
	readonly content: string;
}

/**
 * How a request's input budget is split.
 */
export interface ContextBudget {
	/** Tokens left for history, the message and its context. */
	readonly availableTokens: number;
	/** Characters retrieved context may use. */
	readonly contextChars: number;
	/** Characters one tool result may use. */
	readonly toolResultChars: number;
}

/** Share of the model's input window kept free for its response and tool turns. */
const RESERVED_SHARE = 0.25;
/** Share of the remaining budget retrieved context may use. */
const CONTEXT_SHARE = 0.5;
/** Largest tool result kept, whatever the window. */
const MAX_TOOL_RESULT_CHARS = 24_000;

/**
 * Splits a model's input window between the fixed parts of a request (system
 * prompt, tool definitions) and the parts that can shrink.
 */
export function computeContextBudget(maxInputTokens: number, system: string, tools: readonly AgentToolDefinition[]): ContextBudget {
	const fixedTokens = estimateTokens(system) + estimateTokens(JSON.stringify(tools));
	const availableTokens = Math.max(0, Math.floor(maxInputTokens * (1 - RESERVED_SHARE)) - fixedTokens);
	return {
		availableTokens,
		contextChars: Math.floor(availableTokens * CONTEXT_SHARE) * CHARS_PER_TOKEN,
		// A quarter of the window per result keeps a few tool turns within reach of small models.
		toolResultChars: Math.max(1000, Math.min(MAX_TOOL_RESULT_CHARS, Math.floor(maxInputTokens / 4) * CHARS_PER_TOKEN)),
	};
}

/**
 * Renders retrieved context to append to the person's message, within
 * `maxChars`. Items are kept in order; the one that crosses the limit is cut
 * and later ones are listed by label only. Returns `undefined` for no items.
 */
export function renderRetrievedContext(items: readonly ContextItem[], maxChars: number): string | undefined {
	if (!items.length) {
		return undefined;
	}

	const sections: string[] = [];
	const omitted: string[] = [];
	let remaining = maxChars;
	for (const item of items) {
		const header = `### ${item.label}\n`;
		if (remaining <= header.length) {
			omitted.push(item.label);
			continue;
		}
		const room = remaining - header.length;
		const content = item.content.length > room ? `${item.content.slice(0, room)}\n[Truncated to fit the context budget.]` : item.content;
		sections.push(header + content);
		remaining -= header.length + Math.min(item.content.length, room);
	}
	if (omitted.length) {
		sections.push(`Omitted to fit the context budget: ${omitted.join(', ')}`);
	}
	return `## Context\n${sections.join('\n\n')}`;
}

/**
 * Keeps as much recent history as fits `availableTokens` after the current
 * message, dropping the oldest messages first. The current message is always
 * kept. History never starts with an assistant message.
 */
export function fitHistory(history: readonly AgentMessage[], current: AgentMessage, availableTokens: number): { readonly messages: readonly AgentMessage[]; readonly droppedMessages: number } {
	let remaining = availableTokens - estimateMessageTokens(current);
	let start = history.length;
	while (start > 0) {
		const cost = estimateMessageTokens(history[start - 1]);
		if (cost > remaining) {
			break;
		}
		remaining -= cost;
		start--;
	}
	while (start < history.length && history[start].role !== 'user') {
		start++;
	}
	return { messages: [...history.slice(start), current], droppedMessages: start };
}

function estimateMessageTokens(message: AgentMessage): number {
	let tokens = 0;
	for (const part of message.parts) {
		switch (part.kind) {
			case 'text':
				tokens += estimateTokens(part.text);
				break;
			case 'toolCall':
				tokens += estimateTokens(part.call.name) + estimateTokens(JSON.stringify(part.call.input));
				break;
			case 'toolResult':
				tokens += estimateTokens(part.text);
				break;
		}
	}
	return tokens;
}
