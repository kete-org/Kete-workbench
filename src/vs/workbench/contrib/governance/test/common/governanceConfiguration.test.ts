/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Schemas } from '../../../../../base/common/network.js';
import { PolicyCategory } from '../../../../../base/common/policy.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { ConfigurationService } from '../../../../../platform/configuration/common/configurationService.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { GovernanceConfigKeys, GovernedActionKind, IGovernedAction } from '../../../../../platform/governance/common/governance.js';
import { InMemoryAuditSink } from '../../../../../platform/governance/common/governanceAuditLog.js';
import { GovernanceGate } from '../../../../../platform/governance/common/governanceGate.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { FilePolicyService } from '../../../../../platform/policy/common/filePolicyService.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import '../../common/governanceConfiguration.js';

function commandLine(line: string): IGovernedAction {
	return { kind: GovernedActionKind.Tool, name: 'run_in_terminal', origin: 'kete.agent', sessionId: 'session-1', commandLine: line };
}

suite('Governance configuration', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * Builds a gate over the real configuration service, reading user settings
	 * and an administrator's policy file the way the product does on Linux.
	 */
	async function createGate(userSettings: Record<string, unknown>, policies: Record<string, unknown> | undefined): Promise<GovernanceGate> {
		const logService = new NullLogService();
		const fileService = store.add(new FileService(logService));
		store.add(fileService.registerProvider(Schemas.file, store.add(new InMemoryFileSystemProvider())));

		const settingsResource = URI.file('/user/settings.json');
		await fileService.writeFile(settingsResource, VSBuffer.fromString(JSON.stringify(userSettings)));
		const policyResource = URI.file('/etc/kete/policy.json');
		if (policies) {
			await fileService.writeFile(policyResource, VSBuffer.fromString(JSON.stringify(policies)));
		}

		const policyService = store.add(new FilePolicyService(policyResource, fileService, logService));
		const configurationService = store.add(new ConfigurationService(settingsResource, fileService, policyService, logService));
		await configurationService.initialize();
		return store.add(new GovernanceGate(new InMemoryAuditSink(), configurationService, logService));
	}

	test('both settings are application-scoped and backed by a policy', () => {
		const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
		const properties = registry.getConfigurationProperties();

		assert.deepStrictEqual(
			[GovernanceConfigKeys.ApprovalThreshold, GovernanceConfigKeys.Enabled].map(key => {
				const policy = properties[key]?.policy;
				return {
					key,
					scope: properties[key]?.scope,
					policy: policy && { name: policy.name, category: policy.category, minimumVersion: policy.minimumVersion, enumDescriptions: policy.localization.enumDescriptions?.length },
					ownsPolicy: policy && registry.getPolicyConfigurations().get(policy.name) === key,
				};
			}),
			[
				{
					key: GovernanceConfigKeys.ApprovalThreshold,
					scope: ConfigurationScope.APPLICATION,
					policy: { name: 'KeteGovernanceApprovalThreshold', category: PolicyCategory.InteractiveSession, minimumVersion: '1.139', enumDescriptions: 5 },
					ownsPolicy: true,
				},
				{
					key: GovernanceConfigKeys.Enabled,
					scope: ConfigurationScope.APPLICATION,
					policy: { name: 'KeteGovernanceEnabled', category: PolicyCategory.InteractiveSession, minimumVersion: '1.139', enumDescriptions: undefined },
					ownsPolicy: true,
				},
			]
		);
	});

	test('a policy value overrides the user\'s settings for the gate, and can switch gating on but not off', async () => {
		const localDocker = commandLine('docker compose up -d');
		const remoteCluster = commandLine('kubectl --context staging apply -f x.yaml');
		const lenientUser = { [GovernanceConfigKeys.ApprovalThreshold]: 'production', [GovernanceConfigKeys.Enabled]: false };

		const needsApproval = async (userSettings: Record<string, unknown>, policies: Record<string, unknown> | undefined) => {
			const gate = await createGate(userSettings, policies);
			return { localDocker: gate.assess(localDocker).approvalRequired, remoteCluster: gate.assess(remoteCluster).approvalRequired };
		};

		assert.deepStrictEqual(
			{
				userAlone: await needsApproval(lenientUser, undefined),
				thresholdPinned: await needsApproval(lenientUser, { KeteGovernanceApprovalThreshold: 'localInfra' }),
				lenientThresholdPinned: await needsApproval({ [GovernanceConfigKeys.ApprovalThreshold]: 'read' }, { KeteGovernanceApprovalThreshold: 'production' }),
				enabledPinned: await needsApproval({ [GovernanceConfigKeys.Enabled]: false }, { KeteGovernanceEnabled: true }),
				disabledByPolicy: await needsApproval({}, { KeteGovernanceEnabled: false }),
			},
			{
				// The user's development switch turns gating off.
				userAlone: { localDocker: false, remoteCluster: false },
				// The administrator's threshold wins, and the user's switch is ignored.
				thresholdPinned: { localDocker: true, remoteCluster: true },
				// A pinned threshold also wins over a stricter user value.
				lenientThresholdPinned: { localDocker: false, remoteCluster: false },
				// Pinning gating on overrides the user's switch.
				enabledPinned: { localDocker: false, remoteCluster: true },
				// A policy cannot turn gating off.
				disabledByPolicy: { localDocker: false, remoteCluster: true },
			}
		);
	});
});
