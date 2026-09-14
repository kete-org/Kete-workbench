/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IMarkdownString, MarkdownString } from '../../../../base/common/htmlContent.js';
import { localize } from '../../../../nls.js';
import { IGovernanceApprover, IGovernanceGate } from '../../../../platform/governance/common/governance.js';
import { ConfirmedReason, ToolConfirmKind } from '../../chat/common/chatService/chatService.js';
import type { IPreparedToolInvocation, IToolConfirmationMessages, IToolData, IToolInvocation } from '../../chat/common/tools/languageModelToolsService.js';
import { governedToolAction } from './governedActions.js';

function withNote(note: string, text: string | IMarkdownString | undefined): MarkdownString {
	const existing = typeof text === 'string' ? text : text?.value;
	return new MarkdownString(existing ? `_${note}_\n\n${existing}` : `_${note}_`);
}

/**
 * Makes a tool call's own confirmation the governance approval.
 *
 * When the gate will need a human to approve the call, its confirmation (the
 * chat confirmation, or the dialog when there is no chat session) must be shown
 * and cannot be skipped by auto-approval, hooks or remembered approvals. It says
 * why it is being asked, and "always allow" options are withheld. The person is
 * then asked once, rather than confirming in chat and again in a governance
 * dialog.
 *
 * Returns the prepared invocation to use and the auto-confirmation that still
 * applies (none, when governance requires approval).
 *
 * @param inChat Whether the confirmation is shown in chat, which can present the
 * tool's input; the no-session dialog shows only the title and message.
 */
export function requireGovernedConfirmation(
	gate: IGovernanceGate,
	invocation: IToolInvocation,
	tool: IToolData,
	prepared: IPreparedToolInvocation | undefined,
	autoConfirmed: ConfirmedReason | undefined,
	inChat: boolean,
): { prepared: IPreparedToolInvocation | undefined; autoConfirmed: ConfirmedReason | undefined } {
	const assessment = gate.assess(governedToolAction(invocation, tool));
	if (!assessment.approvalRequired) {
		return { prepared, autoConfirmed };
	}

	const note = localize('governanceConfirmationNote', "Kete governance requires your approval for this action (risk tier: {0}).", assessment.tier);
	const existing = prepared?.confirmationMessages;
	// Terminal confirmations show their message only on hover, so the note goes
	// in the visible disclaimer instead.
	const isTerminal = prepared?.toolSpecificData?.kind === 'terminal';

	const confirmationMessages: IToolConfirmationMessages = existing?.title
		? {
			...existing,
			...(isTerminal ? { disclaimer: withNote(note, existing.disclaimer) } : { message: withNote(note, existing.message) }),
			allowAutoConfirm: false,
		}
		: {
			...existing,
			title: localize('governanceConfirmationTitle', "Allow '{0}'?", tool.displayName),
			message: withNote(note, undefined),
			...(isTerminal ? { disclaimer: withNote(note, undefined) } : {}),
			allowAutoConfirm: false,
		};

	return {
		prepared: {
			...prepared,
			confirmationMessages,
			// In chat, a tool with no presentation of its own shows its input, so the
			// person can see what they are approving.
			toolSpecificData: prepared?.toolSpecificData ?? (inChat ? { kind: 'input', rawInput: invocation.parameters } : undefined),
		},
		autoConfirmed: undefined,
	};
}

/** Whether a confirmation outcome is a person explicitly allowing the call, rather than any form of auto-approval. */
export function isExplicitApproval(reason: ConfirmedReason): boolean {
	return reason.type === ToolConfirmKind.UserAction;
}

/**
 * Hands the gate an approval the person already gave in the tool's confirmation.
 * Only pass it for a call whose confirmation ended in {@link isExplicitApproval};
 * the gate still decides whether approval is needed and records the outcome.
 */
export const approvedInToolConfirmation: IGovernanceApprover = {
	source: 'tool confirmation',
	requestApproval: async () => true,
};
