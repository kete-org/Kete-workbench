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
import { classifyAction } from '../../../../../platform/governance/common/governanceClassifier.js';
import { GovernanceGate } from '../../../../../platform/governance/common/governanceGate.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { LocalChatSessionUri } from '../../../chat/common/model/chatUri.js';
import { AskQuestionsToolId } from '../../../chat/common/tools/builtinTools/askQuestionsTool.js';
import { ConfirmationToolId, ConfirmationToolWithOptionsId, ModifiedFilesConfirmationToolId } from '../../../chat/common/tools/builtinTools/confirmationTool.js';
import { InternalEditToolId } from '../../../chat/common/tools/builtinTools/editFileTool.js';
import { ManageTodoListToolToolId } from '../../../chat/common/tools/builtinTools/manageTodoListTool.js';
import { ResolveDebugEventDetailsToolId } from '../../../chat/common/tools/builtinTools/resolveDebugEventDetailsTool.js';
import { ReviewPlanToolId } from '../../../chat/common/tools/builtinTools/reviewPlanTool.js';
import { RunSubagentTool } from '../../../chat/common/tools/builtinTools/runSubagentTool.js';
import { SetArtifactRulesToolId } from '../../../chat/common/tools/builtinTools/setArtifactRulesTool.js';
import { SetArtifactsToolId } from '../../../chat/common/tools/builtinTools/setArtifactsTool.js';
import { TaskCompleteToolId } from '../../../chat/common/tools/builtinTools/taskCompleteTool.js';
import { InternalFetchWebPageToolId } from '../../../chat/common/tools/builtinTools/tools.js';
import { IToolData, IToolInvocation, ToolDataSource } from '../../../chat/common/tools/languageModelToolsService.js';
import { TerminalToolId } from '../../../chat/common/tools/terminalToolIds.js';
import { SearchExtensionsToolId } from '../../../extensions/common/searchExtensionsTool.js';
import { RunTestTool, TestFailureTool } from '../../../testing/common/testingChatAgentTool.js';
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

	// The classifier keeps these ids as string literals (the platform layer can't
	// import them), so this checks them against the constants that define them.
	// A renamed id would fall back to the local-write default and fail here.
	test('built-in tool ids map to their intended tiers', () => {
		const ids = [
			ManageTodoListToolToolId, AskQuestionsToolId, ReviewPlanToolId, TaskCompleteToolId, SetArtifactsToolId, SetArtifactRulesToolId,
			RunSubagentTool.Id, ResolveDebugEventDetailsToolId, TestFailureTool.ID,
			TerminalToolId.GetTerminalOutput, TerminalToolId.TerminalSelection, TerminalToolId.TerminalLastCommand, TerminalToolId.GetTaskOutput,
			InternalEditToolId, ConfirmationToolId, ConfirmationToolWithOptionsId, ModifiedFilesConfirmationToolId, InternalFetchWebPageToolId,
			SearchExtensionsToolId, RunTestTool.ID, TerminalToolId.KillTerminal, TerminalToolId.RunTask,
		];

		assert.deepStrictEqual(
			Object.fromEntries(ids.map(id => [id, classifyAction(governedToolAction(invocation(id, {}), tool(id)))])),
			{
				[ManageTodoListToolToolId]: GovernanceRiskTier.Read,
				[AskQuestionsToolId]: GovernanceRiskTier.Read,
				[ReviewPlanToolId]: GovernanceRiskTier.Read,
				[TaskCompleteToolId]: GovernanceRiskTier.Read,
				[SetArtifactsToolId]: GovernanceRiskTier.Read,
				[SetArtifactRulesToolId]: GovernanceRiskTier.Read,
				[RunSubagentTool.Id]: GovernanceRiskTier.Read,
				[ResolveDebugEventDetailsToolId]: GovernanceRiskTier.Read,
				[TestFailureTool.ID]: GovernanceRiskTier.Read,
				[TerminalToolId.GetTerminalOutput]: GovernanceRiskTier.Read,
				[TerminalToolId.TerminalSelection]: GovernanceRiskTier.Read,
				[TerminalToolId.TerminalLastCommand]: GovernanceRiskTier.Read,
				[TerminalToolId.GetTaskOutput]: GovernanceRiskTier.Read,
				[InternalEditToolId]: GovernanceRiskTier.LocalWrite,
				[ConfirmationToolId]: GovernanceRiskTier.LocalWrite,
				[ConfirmationToolWithOptionsId]: GovernanceRiskTier.LocalWrite,
				[ModifiedFilesConfirmationToolId]: GovernanceRiskTier.LocalWrite,
				[InternalFetchWebPageToolId]: GovernanceRiskTier.LocalWrite,
				[SearchExtensionsToolId]: GovernanceRiskTier.LocalWrite,
				[RunTestTool.ID]: GovernanceRiskTier.LocalWrite,
				[TerminalToolId.KillTerminal]: GovernanceRiskTier.LocalWrite,
				[TerminalToolId.RunTask]: GovernanceRiskTier.RemoteInfra,
			}
		);
	});

	test('task tools reach the gate classified by the task they run', () => {
		const gate = store.add(new GovernanceGate(new InMemoryAuditSink(), new TestConfigurationService(), new NullLogService()));
		const createAndRun = (task: Record<string, unknown>) => {
			const action = governedToolAction(invocation(TerminalToolId.CreateAndRunTask, { workspaceFolder: '/w', task: { label: 'x', type: 'shell', ...task } }, 's1'), tool(TerminalToolId.CreateAndRunTask));
			return { commandLine: action.commandLine, ...gate.assess(action) };
		};

		assert.deepStrictEqual(
			{
				remoteCluster: createAndRun({ command: 'kubectl', args: ['--context', 'prod', 'apply', '-f', 'deploy.yaml'] }),
				infrastructure: createAndRun({ command: 'terraform apply -auto-approve' }),
				quotedArguments: createAndRun({ command: { value: 'git', quoting: 'escape' }, args: [{ value: ['push', 'origin', 'main'], quoting: 'strong' }] }),
				editorCommandVariable: createAndRun({ command: 'echo', args: ['${command:git.push}'] }),
				local: createAndRun({ command: 'npm', args: ['run', 'build'] }),
				existingTask: gate.assess(governedToolAction(invocation(TerminalToolId.RunTask, { workspaceFolder: '/w', id: 'shell: build' }, 's1'), tool(TerminalToolId.RunTask))),
				mcpServerTool: gate.assess(governedToolAction(invocation('mcp_github_create_issue', {}), tool('mcp_github_create_issue', { type: 'mcp', label: 'GitHub', serverLabel: 'GitHub', instructions: undefined, collectionId: 'c', definitionId: 'd' }))),
			},
			{
				remoteCluster: { commandLine: 'kubectl --context prod apply -f deploy.yaml', tier: GovernanceRiskTier.RemoteInfra, approvalRequired: true },
				infrastructure: { commandLine: 'terraform apply -auto-approve', tier: GovernanceRiskTier.Production, approvalRequired: true },
				quotedArguments: { commandLine: 'git push origin main', tier: GovernanceRiskTier.Production, approvalRequired: true },
				editorCommandVariable: { commandLine: 'echo ${command:git.push}', tier: GovernanceRiskTier.RemoteInfra, approvalRequired: true },
				local: { commandLine: 'npm run build', tier: GovernanceRiskTier.LocalWrite, approvalRequired: false },
				existingTask: { tier: GovernanceRiskTier.RemoteInfra, approvalRequired: true },
				// An MCP server's tool says nothing about what it does, so it always reaches a person.
				mcpServerTool: { tier: GovernanceRiskTier.RemoteInfra, approvalRequired: true },
			}
		);
	});

	test('terminal tools are judged by every version of their command line', () => {
		const edited: IToolInvocation = {
			...invocation(TerminalToolId.RunInTerminal, { command: 'npm test' }, 's1'),
			toolSpecificData: {
				kind: 'terminal',
				language: 'sh',
				commandLine: { original: 'npm test', toolEdited: 'sandbox-exec npm test', userEdited: 'kubectl --context prod apply -f .' },
			},
		};
		const confirmation = invocation(TerminalToolId.ConfirmTerminalCommand, { command: 'terraform apply', explanation: '', goal: '', mode: 'sync' }, 's1');

		assert.deepStrictEqual(
			[
				governedToolAction(edited, tool(TerminalToolId.RunInTerminal)),
				governedToolAction(confirmation, tool(TerminalToolId.ConfirmTerminalCommand)),
			].map(action => ({ commandLine: action.commandLine, tier: classifyAction(action) })),
			[
				{ commandLine: 'kubectl --context prod apply -f .\nnpm test\nsandbox-exec npm test', tier: GovernanceRiskTier.RemoteInfra },
				{ commandLine: 'terraform apply', tier: GovernanceRiskTier.Production },
			]
		);
	});
});
