/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { GovernedActionKind, IGovernanceDecision, IGovernedAction } from '../../../../platform/governance/common/governance.js';
import { chatSessionResourceToId } from '../../chat/common/model/chatUri.js';
import type { IToolData, IToolInvocation } from '../../chat/common/tools/languageModelToolsService.js';
import { TerminalToolId } from '../../chat/common/tools/terminalToolIds.js';

/**
 * Tools that run their `command` parameter in a shell. The gate classifies a
 * shell action by its command line, so a tool missing from this set is judged
 * by its name alone and a remote command it runs would be under-classified.
 */
const COMMAND_LINE_TOOLS: ReadonlySet<string> = new Set<string>([
	TerminalToolId.RunInTerminal,
	TerminalToolId.SendToTerminal,
]);

/** Session id recorded for actions that don't belong to a chat session. */
export const UNSCOPED_SESSION_ID = 'unscoped';

function toolOrigin(tool: IToolData): string {
	switch (tool.source.type) {
		case 'extension':
			return tool.source.extensionId.value;
		case 'mcp':
			return `mcp:${tool.source.definitionId}`;
		default:
			return tool.source.type;
	}
}

/**
 * Describes a tool call to the governance gate, including the command line for
 * tools that run one.
 */
export function governedToolAction(invocation: IToolInvocation, tool: IToolData): IGovernedAction {
	const command: unknown = invocation.parameters?.command;
	return {
		kind: GovernedActionKind.Tool,
		name: tool.id,
		origin: toolOrigin(tool),
		sessionId: invocation.context ? chatSessionResourceToId(invocation.context.sessionResource) : UNSCOPED_SESSION_ID,
		commandLine: COMMAND_LINE_TOOLS.has(tool.id) && typeof command === 'string' ? command : undefined,
		detail: { callId: invocation.callId, source: tool.source.type },
	};
}

/** Describes a language model request to the governance gate. */
export function governedModelRequest(modelId: string, from: ExtensionIdentifier | undefined, messageCount: number): IGovernedAction {
	return {
		kind: GovernedActionKind.Model,
		name: modelId,
		origin: from?.value ?? 'core',
		sessionId: UNSCOPED_SESSION_ID,
		detail: { messages: messageCount },
	};
}

/**
 * The tool result returned to the model when the gate refuses a tool call, so
 * the model knows the action didn't happen and doesn't blindly retry it.
 */
export function governanceDenialMessage(decision: IGovernanceDecision): string {
	return `Kete Workbench's governance gate did not allow this action (risk tier: ${decision.tier}; reason: ${decision.reason}). It was not performed. Do not retry it as-is: leave it for the user to run, or ask them to approve it.`;
}
