/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { GovernanceOutcome, GovernanceRiskTier, GovernedActionKind } from '../../../../../platform/governance/common/governance.js';
import { InMemoryAuditSink } from '../../../../../platform/governance/common/governanceAuditLog.js';
import { GovernanceGate } from '../../../../../platform/governance/common/governanceGate.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { LocalChatSessionUri } from '../../../chat/common/model/chatUri.js';
import { IToolData, IToolInvocation, ToolDataSource } from '../../../chat/common/tools/languageModelToolsService.js';
import { TerminalToolId } from '../../../chat/common/tools/terminalToolIds.js';
import { governedModelRequest, governedToolAction, UNSCOPED_SESSION_ID } from '../../common/governedActions.js';

function tool(id: string, source: ToolDataSource = ToolDataSource.Internal): IToolData {
	return { id, source, displayName: id, modelDescription: id };
}

function invocation(toolId: string, parameters: Record<string, unknown>, sessionId?: string): IToolInvocation {
	return {
		callId: 'call-1',
		toolId,
		parameters,
		context: sessionId ? { sessionResource: LocalChatSessionUri.forSession(sessionId) } : undefined,
	};
}

suite('Governed actions', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('describes tool calls, reading the command line only from tools that run one', () => {
		const extensionTool = tool('extTool', { type: 'extension', label: 'Ext', extensionId: new ExtensionIdentifier('pub.ext') });

		assert.deepStrictEqual(
			[
				governedToolAction(invocation(TerminalToolId.RunInTerminal, { command: 'kubectl --context prod apply -f .' }, 's1'), tool(TerminalToolId.RunInTerminal)),
				governedToolAction(invocation(TerminalToolId.SendToTerminal, { id: 't1', command: 'terraform apply' }), tool(TerminalToolId.SendToTerminal)),
				governedToolAction(invocation('extTool', { command: 'rm -rf /' }), extensionTool),
			].map(a => ({ kind: a.kind, name: a.name, origin: a.origin, commandLine: a.commandLine, scoped: a.sessionId !== UNSCOPED_SESSION_ID })),
			[
				{ kind: GovernedActionKind.Tool, name: TerminalToolId.RunInTerminal, origin: 'internal', commandLine: 'kubectl --context prod apply -f .', scoped: true },
				{ kind: GovernedActionKind.Tool, name: TerminalToolId.SendToTerminal, origin: 'internal', commandLine: 'terraform apply', scoped: false },
				{ kind: GovernedActionKind.Tool, name: 'extTool', origin: 'pub.ext', commandLine: undefined, scoped: false },
			]
		);
	});

	test('describes model requests', () => {
		assert.deepStrictEqual(
			governedModelRequest('claude-opus-5', new ExtensionIdentifier('pub.ext'), 3),
			{ kind: GovernedActionKind.Model, name: 'claude-opus-5', origin: 'pub.ext', sessionId: UNSCOPED_SESSION_ID, detail: { messages: 3 } }
		);
	});

	// Guards the combination that matters most: an agent's terminal command
	// against a remote cluster must reach the gate as a remote action, so it
	// cannot run without approval.
	test('a terminal command against a remote cluster needs approval at the gate', async () => {
		const sink = new InMemoryAuditSink();
		const gate = store.add(new GovernanceGate(sink, new TestConfigurationService(), new NullLogService()));

		const decision = await gate.authorize(
			governedToolAction(invocation(TerminalToolId.RunInTerminal, { command: 'kubectl --context prod apply -f deploy.yaml' }, 's1'), tool(TerminalToolId.RunInTerminal)),
			CancellationToken.None
		);

		assert.deepStrictEqual(
			{ outcome: decision.outcome, tier: decision.tier, recorded: sink.entries.length },
			{ outcome: GovernanceOutcome.Denied, tier: GovernanceRiskTier.RemoteInfra, recorded: 1 }
		);
	});
});
