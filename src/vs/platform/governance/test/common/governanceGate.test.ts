/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import {
	GovernanceConfigKeys,
	GovernanceOutcome,
	GovernanceRiskTier,
	GovernedActionKind,
	IApprovalRequest,
	IGovernanceApprover,
	IGovernedAction,
} from '../../common/governance.js';
import { IAuditEntry, IAuditSink, InMemoryAuditSink } from '../../common/governanceAuditLog.js';
import { classifyAction, classifyCommandLine } from '../../common/governanceClassifier.js';
import { GovernanceGate } from '../../common/governanceGate.js';

class StubApprover implements IGovernanceApprover {
	readonly seen: IApprovalRequest[] = [];
	constructor(private readonly answer: boolean | Error) { }
	async requestApproval(request: IApprovalRequest): Promise<boolean> {
		this.seen.push(request);
		if (this.answer instanceof Error) {
			throw this.answer;
		}
		return this.answer;
	}
}

class FailingAuditSink implements IAuditSink {
	async append(_entry: IAuditEntry): Promise<void> {
		throw new Error('disk full');
	}
}

function action(overrides: Partial<IGovernedAction> = {}): IGovernedAction {
	return {
		kind: GovernedActionKind.Tool,
		name: 'run_in_terminal',
		origin: 'kete.agent',
		sessionId: 'session-1',
		...overrides,
	};
}

suite('Governance classifier', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('classifies command lines by their riskiest segment', () => {
		assert.deepStrictEqual(
			[
				'docker compose up -d',
				'kubectl --context kind-dev get pods',
				'kubectl --context staging get pods',
				'kubectl get pods',
				'cd infra && kubectl --context prod-eu apply -f .',
				'terraform plan',
				'terraform apply -auto-approve',
				'git push origin feature/thing',
				'git push origin main',
				'git commit -m wip',
				'sudo docker ps',
				'npm test',
			].map(classifyCommandLine),
			[
				GovernanceRiskTier.LocalInfra,
				GovernanceRiskTier.LocalInfra,
				GovernanceRiskTier.RemoteInfra,
				GovernanceRiskTier.RemoteInfra,
				GovernanceRiskTier.RemoteInfra,
				GovernanceRiskTier.RemoteInfra,
				GovernanceRiskTier.Production,
				GovernanceRiskTier.RemoteInfra,
				GovernanceRiskTier.Production,
				GovernanceRiskTier.LocalWrite,
				GovernanceRiskTier.LocalInfra,
				GovernanceRiskTier.LocalWrite,
			]
		);
	});

	test('a docker client pointed at a remote daemon is not a local action', () => {
		assert.strictEqual(classifyCommandLine('docker -H tcp://10.0.0.4:2375 ps'), GovernanceRiskTier.RemoteInfra);
	});

	test('sees through separators, wrappers, quoting and global options', () => {
		const commandLines = [
			'echo ok\nkubectl --context prod apply -f .',
			'npm run build & kubectl --context prod delete ns app',
			'echo $(terraform apply -auto-approve)',
			'bash -c "git push origin main"',
			'sudo -u deploy kubectl --context prod apply -f .',
			'env DOCKER_HOST=tcp://10.0.0.4:2375 docker ps',
			'DOCKER_HOST=ssh://prod docker ps',
			'git -C infra push origin main',
			'git push origin "main"',
			'git push origin +feature/thing',
			'terraform -chdir=infra apply',
			'C:\\tools\\KUBECTL.EXE --context prod get pods',
			'echo ${command:git.push}',
			// These stay local: flags that belong to the container, paths that aren't programs, local contexts.
			'docker run --rm alpine sh -c "echo hi"',
			'npx prettier --write infra/terraform',
			'helm --kube-context kind-dev upgrade app ./chart',
		];
		assert.deepStrictEqual(
			Object.fromEntries(commandLines.map(commandLine => [commandLine, classifyCommandLine(commandLine)])),
			{
				'echo ok\nkubectl --context prod apply -f .': GovernanceRiskTier.RemoteInfra,
				'npm run build & kubectl --context prod delete ns app': GovernanceRiskTier.RemoteInfra,
				'echo $(terraform apply -auto-approve)': GovernanceRiskTier.Production,
				'bash -c "git push origin main"': GovernanceRiskTier.Production,
				'sudo -u deploy kubectl --context prod apply -f .': GovernanceRiskTier.RemoteInfra,
				'env DOCKER_HOST=tcp://10.0.0.4:2375 docker ps': GovernanceRiskTier.RemoteInfra,
				'DOCKER_HOST=ssh://prod docker ps': GovernanceRiskTier.RemoteInfra,
				'git -C infra push origin main': GovernanceRiskTier.Production,
				'git push origin "main"': GovernanceRiskTier.Production,
				'git push origin +feature/thing': GovernanceRiskTier.Production,
				'terraform -chdir=infra apply': GovernanceRiskTier.Production,
				'C:\\tools\\KUBECTL.EXE --context prod get pods': GovernanceRiskTier.RemoteInfra,
				'echo ${command:git.push}': GovernanceRiskTier.RemoteInfra,
				'docker run --rm alpine sh -c "echo hi"': GovernanceRiskTier.LocalInfra,
				'npx prettier --write infra/terraform': GovernanceRiskTier.LocalWrite,
				'helm --kube-context kind-dev upgrade app ./chart': GovernanceRiskTier.LocalInfra,
			}
		);
	});

	test('recognises deploys, merges, publishing and remote databases', () => {
		const commandLines = [
			'gh pr merge 42 --squash',
			'gh pr view 42',
			'gcloud run deploy api --image app:1',
			'vercel --prod',
			'npm publish',
			'npm run deploy',
			'make deploy',
			'make test',
			'docker push registry.example.com/app:1',
			'psql -h prod-db.internal -c "DELETE FROM users"',
			'psql postgres://app@localhost:5432/app',
			'minikube start',
		];
		assert.deepStrictEqual(
			Object.fromEntries(commandLines.map(commandLine => [commandLine, classifyCommandLine(commandLine)])),
			{
				'gh pr merge 42 --squash': GovernanceRiskTier.Production,
				'gh pr view 42': GovernanceRiskTier.RemoteInfra,
				'gcloud run deploy api --image app:1': GovernanceRiskTier.Production,
				'vercel --prod': GovernanceRiskTier.Production,
				'npm publish': GovernanceRiskTier.Production,
				'npm run deploy': GovernanceRiskTier.RemoteInfra,
				'make deploy': GovernanceRiskTier.RemoteInfra,
				'make test': GovernanceRiskTier.LocalWrite,
				'docker push registry.example.com/app:1': GovernanceRiskTier.RemoteInfra,
				'psql -h prod-db.internal -c "DELETE FROM users"': GovernanceRiskTier.RemoteInfra,
				'psql postgres://app@localhost:5432/app': GovernanceRiskTier.LocalWrite,
				'minikube start': GovernanceRiskTier.LocalInfra,
			}
		);
	});

	test('classifies tools by id, trusting a known id only from the tool\'s owner', () => {
		const tool = (name: string, origin: string, commandLine?: string) => classifyAction({ kind: GovernedActionKind.Tool, name, origin, sessionId: 's', commandLine });

		assert.deepStrictEqual(
			{
				coreRead: tool('manage_todo_list', 'internal'),
				copilotRead: tool('copilot_readFile', 'GitHub.copilot-chat'),
				copilotReadFromAnotherExtension: tool('copilot_readFile', 'someone.else'),
				fetchesModelChosenUrl: tool('vscode_fetchWebPage_internal', 'internal'),
				runsExistingTask: tool('run_task', 'internal'),
				runsExistingTaskFromAnotherExtension: tool('run_task', 'someone.else'),
				runsAnyEditorCommand: tool('copilot_runVscodeCommand', 'GitHub.copilot-chat'),
				mcpTool: tool('create_issue', 'mcp:github'),
				placeholderNameThatIsNotARealId: tool('read_file', 'internal'),
				emptyCommandLine: tool('run_in_terminal', 'internal', ''),
				commandLineRaisesTheTier: tool('vscode_askQuestions', 'internal', 'terraform apply'),
			},
			{
				coreRead: GovernanceRiskTier.Read,
				copilotRead: GovernanceRiskTier.Read,
				copilotReadFromAnotherExtension: GovernanceRiskTier.LocalWrite,
				fetchesModelChosenUrl: GovernanceRiskTier.LocalWrite,
				runsExistingTask: GovernanceRiskTier.RemoteInfra,
				runsExistingTaskFromAnotherExtension: GovernanceRiskTier.RemoteInfra,
				runsAnyEditorCommand: GovernanceRiskTier.RemoteInfra,
				mcpTool: GovernanceRiskTier.LocalWrite,
				placeholderNameThatIsNotARealId: GovernanceRiskTier.LocalWrite,
				emptyCommandLine: GovernanceRiskTier.LocalWrite,
				commandLineRaisesTheTier: GovernanceRiskTier.Production,
			}
		);
	});
});

suite('Governance gate', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createGate(approver?: IGovernanceApprover, config: Record<string, unknown> = {}, sink: IAuditSink = new InMemoryAuditSink()) {
		const configurationService = new TestConfigurationService(config);
		const gate = store.add(new GovernanceGate(sink, configurationService, new NullLogService()));
		if (approver) {
			store.add(gate.registerApprover(approver));
		}
		return { gate, sink };
	}

	test('local Docker work runs without asking anyone', async () => {
		const approver = new StubApprover(true);
		const { gate } = createGate(approver);

		const decision = await gate.authorize(action({ commandLine: 'docker compose up -d' }), CancellationToken.None);

		assert.deepStrictEqual(
			{ outcome: decision.outcome, tier: decision.tier, asked: decision.approvalRequested, prompts: approver.seen.length },
			{ outcome: GovernanceOutcome.Allowed, tier: GovernanceRiskTier.LocalInfra, asked: false, prompts: 0 }
		);
	});

	// The Phase 1 exit criterion.
	test('a remote cluster action cannot run without recorded approval', async () => {
		const approver = new StubApprover(false);
		const { gate, sink } = createGate(approver);
		const remote = action({ commandLine: 'kubectl --context prod-eu apply -f deploy.yaml' });

		const denied = await gate.authorize(remote, CancellationToken.None);
		assert.strictEqual(denied.outcome, GovernanceOutcome.Denied);

		const approved = await (createGate(new StubApprover(true), {}, sink).gate).authorize(remote, CancellationToken.None);
		assert.strictEqual(approved.outcome, GovernanceOutcome.Allowed);

		assert.deepStrictEqual(
			(sink as InMemoryAuditSink).entries.map(e => ({ tier: e.tier, outcome: e.outcome, asked: e.approvalRequested })),
			[
				{ tier: GovernanceRiskTier.RemoteInfra, outcome: GovernanceOutcome.Denied, asked: true },
				{ tier: GovernanceRiskTier.RemoteInfra, outcome: GovernanceOutcome.Allowed, asked: true },
			]
		);
	});

	test('assess reports whether approval is needed without asking anyone or recording anything', () => {
		const approver = new StubApprover(true);
		const { gate, sink } = createGate(approver);
		const { gate: disabledGate } = createGate(undefined, { [GovernanceConfigKeys.Enabled]: false });

		assert.deepStrictEqual(
			{
				local: gate.assess(action({ commandLine: 'docker compose up -d' })),
				remote: gate.assess(action({ commandLine: 'kubectl --context prod apply -f x.yaml' })),
				disabled: disabledGate.assess(action({ commandLine: 'terraform apply' })),
				prompts: approver.seen.length,
				recorded: (sink as InMemoryAuditSink).entries.length,
			},
			{
				local: { tier: GovernanceRiskTier.LocalInfra, approvalRequired: false },
				remote: { tier: GovernanceRiskTier.RemoteInfra, approvalRequired: true },
				disabled: { tier: GovernanceRiskTier.Production, approvalRequired: false },
				prompts: 0,
				recorded: 0,
			}
		);
	});

	test('an approver passed for one call answers instead of the registered one, and is named in the audit entry', async () => {
		const registered = new StubApprover(false);
		const approvedInChat: IGovernanceApprover = { source: 'chat confirmation', requestApproval: async () => true };
		const { gate, sink } = createGate(registered);

		const decision = await gate.authorize(action({ commandLine: 'kubectl --context prod apply -f x.yaml' }), CancellationToken.None, approvedInChat);

		assert.deepStrictEqual(
			{
				outcome: decision.outcome,
				registeredPrompts: registered.seen.length,
				recorded: (sink as InMemoryAuditSink).entries.map(e => ({ outcome: e.outcome, asked: e.approvalRequested, reason: e.reason })),
			},
			{
				outcome: GovernanceOutcome.Allowed,
				registeredPrompts: 0,
				recorded: [{ outcome: GovernanceOutcome.Allowed, asked: true, reason: 'approved by a human in the chat confirmation' }],
			}
		);
	});

	test('denies when no approver is registered', async () => {
		const { gate } = createGate(undefined);

		const decision = await gate.authorize(action({ commandLine: 'kubectl --context prod get pods' }), CancellationToken.None);

		assert.deepStrictEqual(
			{ outcome: decision.outcome, reason: decision.reason },
			{ outcome: GovernanceOutcome.Denied, reason: 'approval required but no approver is registered' }
		);
	});

	test('denies when the approver throws', async () => {
		const { gate } = createGate(new StubApprover(new Error('ui gone')));

		const decision = await gate.authorize(action({ commandLine: 'terraform apply' }), CancellationToken.None);

		assert.strictEqual(decision.outcome, GovernanceOutcome.Denied);
	});

	test('denies when cancelled while awaiting approval', async () => {
		const source = store.add(new CancellationTokenSource());
		const approver: IGovernanceApprover = {
			async requestApproval() {
				source.cancel();
				return true;
			}
		};
		const { gate } = createGate(approver);

		const decision = await gate.authorize(action({ commandLine: 'kubectl --context prod delete ns app' }), source.token);

		assert.strictEqual(decision.outcome, GovernanceOutcome.Denied);
	});

	test('denies an approved action whose audit entry could not be written', async () => {
		const { gate } = createGate(new StubApprover(true), {}, new FailingAuditSink());

		const decision = await gate.authorize(action({ commandLine: 'kubectl --context prod apply -f x.yaml' }), CancellationToken.None);

		assert.deepStrictEqual(
			{ outcome: decision.outcome, reason: decision.reason },
			{ outcome: GovernanceOutcome.Denied, reason: 'denied because the decision could not be recorded' }
		);
	});

	test('an unrecognised threshold falls back to the default instead of disabling gating', async () => {
		const { gate } = createGate(new StubApprover(false), { [GovernanceConfigKeys.ApprovalThreshold]: 'nonsense' });

		const decision = await gate.authorize(action({ commandLine: 'kubectl --context prod apply -f x.yaml' }), CancellationToken.None);

		assert.strictEqual(decision.outcome, GovernanceOutcome.Denied);
	});

	test('model requests are recorded even though they are never gated', async () => {
		const { gate, sink } = createGate(new StubApprover(false));

		const decision = await gate.authorize(
			action({ kind: GovernedActionKind.Model, name: 'claude-opus-5', commandLine: undefined, detail: { promptTokens: 1200 } }),
			CancellationToken.None
		);

		assert.strictEqual(decision.outcome, GovernanceOutcome.Allowed);
		assert.deepStrictEqual(
			(sink as InMemoryAuditSink).entries.map(e => ({ kind: e.kind, name: e.name, detail: e.detail })),
			[{ kind: GovernedActionKind.Model, name: 'claude-opus-5', detail: { promptTokens: 1200 } }]
		);
	});
});
