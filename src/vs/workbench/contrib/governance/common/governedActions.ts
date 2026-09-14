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
 * The strings in a task definition's `command` or `args`. Besides plain strings,
 * tasks accept `{ value, quoting }` objects whose `value` is a string or an
 * array of strings, and the task tool writes whatever it is given into
 * tasks.json, so those count too.
 */
function taskStrings(value: unknown): string[] {
	if (typeof value === 'string') {
		return [value];
	}
	if (Array.isArray(value)) {
		return value.flatMap(taskStrings);
	}
	if (value && typeof value === 'object') {
		return taskStrings((value as { value?: unknown }).value);
	}
	return [];
}

/**
 * The command line a task definition runs: its command followed by its
 * arguments. Joined with spaces and without the quoting the task system would
 * add, which can only split an argument into more segments to classify, never
 * hide one.
 */
function taskCommandLine(task: unknown): string | undefined {
	if (!task || typeof task !== 'object') {
		return undefined;
	}
	const { command, args } = task as { command?: unknown; args?: unknown };
	const parts = [...taskStrings(command), ...taskStrings(args)];
	return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * Every version of a terminal tool's command line: the model's, and once the
 * tool has prepared the call, the tool's rewrite and the person's edit. The one
 * that will run comes first, then the others, one per line, so the gate judges
 * the riskiest and the audit entry shows all of them.
 */
function terminalCommandLine(invocation: IToolInvocation): string | undefined {
	const command: unknown = invocation.parameters?.command;
	const prepared = invocation.toolSpecificData?.kind === 'terminal' ? invocation.toolSpecificData.commandLine : undefined;
	const variants = [
		prepared?.userEdited ?? prepared?.toolEdited ?? prepared?.original,
		prepared?.original,
		prepared?.toolEdited,
		prepared?.userEdited,
		command,
	].filter((variant): variant is string => typeof variant === 'string');
	return variants.length > 0 ? [...new Set(variants)].join('\n') : undefined;
}

/**
 * The command line a tool call runs, for tools that run one. The gate
 * classifies a tool by its id and by this command line, so a command-running
 * tool missing here would have a remote command it runs under-classified.
 */
function toolCommandLine(invocation: IToolInvocation, tool: IToolData): string | undefined {
	switch (tool.id) {
		case TerminalToolId.RunInTerminal:
		case TerminalToolId.SendToTerminal:
		// Approves a command that Copilot CLI then runs itself, outside the gate.
		case TerminalToolId.ConfirmTerminalCommand:
			return terminalCommandLine(invocation);
		case TerminalToolId.CreateAndRunTask:
			return taskCommandLine(invocation.parameters?.task);
		default:
			// run_task names an existing task whose command isn't in the call; the
			// classifier treats it conservatively instead.
			return undefined;
	}
}

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
	return {
		kind: GovernedActionKind.Tool,
		name: tool.id,
		origin: toolOrigin(tool),
		sessionId: invocation.context ? chatSessionResourceToId(invocation.context.sessionResource) : UNSCOPED_SESSION_ID,
		commandLine: toolCommandLine(invocation, tool),
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
