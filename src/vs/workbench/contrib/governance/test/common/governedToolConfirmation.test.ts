/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { InMemoryAuditSink } from '../../../../../platform/governance/common/governanceAuditLog.js';
import { GovernanceGate } from '../../../../../platform/governance/common/governanceGate.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ConfirmedReason, ToolConfirmKind } from '../../../chat/common/chatService/chatService.js';
import { IPreparedToolInvocation, IToolData, IToolInvocation, ToolDataSource } from '../../../chat/common/tools/languageModelToolsService.js';
import { TerminalToolId } from '../../../chat/common/tools/terminalToolIds.js';
import { isExplicitApproval, requireGovernedConfirmation } from '../../common/governedToolConfirmation.js';

const terminalTool: IToolData = { id: TerminalToolId.RunInTerminal, source: ToolDataSource.Internal, displayName: 'Run in Terminal', modelDescription: 'Run' };

function invocation(command: string): IToolInvocation {
	return { callId: 'call-1', toolId: TerminalToolId.RunInTerminal, parameters: { command }, context: undefined };
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' ? value : (value as { value?: string } | undefined)?.value;
}

suite('Governed tool confirmation', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createGate() {
		return store.add(new GovernanceGate(new InMemoryAuditSink(), new TestConfigurationService(), new NullLogService()));
	}

	const autoApproved: ConfirmedReason = { type: ToolConfirmKind.ConfirmationNotNeeded };

	test('leaves calls below the approval threshold, and their auto-approval, untouched', () => {
		const prepared: IPreparedToolInvocation = { invocationMessage: 'Running' };

		const result = requireGovernedConfirmation(createGate(), invocation('docker ps'), terminalTool, prepared, autoApproved, true);

		assert.deepStrictEqual(result, { prepared, autoConfirmed: autoApproved });
	});

	test('a governed call must be confirmed by a person and says why', () => {
		const gate = createGate();
		const terminalPrepared: IPreparedToolInvocation = {
			confirmationMessages: { title: 'Run command?', message: 'kubectl apply', disclaimer: 'Existing disclaimer', allowAutoConfirm: true },
			toolSpecificData: { kind: 'terminal', commandLine: { original: 'kubectl --context prod apply -f .' }, language: 'sh' },
		};

		const withOwnConfirmation = requireGovernedConfirmation(gate, invocation('kubectl --context prod apply -f .'), terminalTool, terminalPrepared, autoApproved, true);
		const withoutConfirmationInChat = requireGovernedConfirmation(gate, invocation('terraform apply'), terminalTool, undefined, autoApproved, true);
		const withoutConfirmationNoSession = requireGovernedConfirmation(gate, invocation('terraform apply'), terminalTool, undefined, undefined, false);

		assert.deepStrictEqual(
			[withOwnConfirmation, withoutConfirmationInChat, withoutConfirmationNoSession].map(r => ({
				autoConfirmed: r.autoConfirmed,
				title: text(r.prepared?.confirmationMessages?.title),
				allowAutoConfirm: r.prepared?.confirmationMessages?.allowAutoConfirm,
				disclaimerHasNote: !!text(r.prepared?.confirmationMessages?.disclaimer)?.includes('Kete governance requires your approval'),
				messageHasNote: !!text(r.prepared?.confirmationMessages?.message)?.includes('Kete governance requires your approval'),
				presentation: r.prepared?.toolSpecificData?.kind,
			})),
			[
				{ autoConfirmed: undefined, title: 'Run command?', allowAutoConfirm: false, disclaimerHasNote: true, messageHasNote: false, presentation: 'terminal' },
				{ autoConfirmed: undefined, title: 'Allow \'Run in Terminal\'?', allowAutoConfirm: false, disclaimerHasNote: false, messageHasNote: true, presentation: 'input' },
				{ autoConfirmed: undefined, title: 'Allow \'Run in Terminal\'?', allowAutoConfirm: false, disclaimerHasNote: false, messageHasNote: true, presentation: undefined },
			]
		);
	});

	test('only a person clicking a confirmation button counts as explicit approval', () => {
		assert.deepStrictEqual(
			[
				{ type: ToolConfirmKind.UserAction },
				{ type: ToolConfirmKind.ConfirmationNotNeeded },
				{ type: ToolConfirmKind.Setting, id: 'chat.tools.global.autoApprove' },
				{ type: ToolConfirmKind.LmServicePerTool, scope: 'session' },
				{ type: ToolConfirmKind.Skipped },
				{ type: ToolConfirmKind.Denied },
			].map(reason => isExplicitApproval(reason as ConfirmedReason)),
			[true, false, false, false, false, false]
		);
	});
});
