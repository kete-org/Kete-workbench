/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PolicyCategory } from '../../../../base/common/policy.js';
import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { GovernanceConfigKeys, RISK_TIER_ORDER } from '../../../../platform/governance/common/governance.js';
import { DEFAULT_APPROVAL_THRESHOLD } from '../../../../platform/governance/common/governanceGate.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

// Shared by the setting and its policy so the settings editor and the
// administrator's policy templates describe each tier identically. In the same
// order as RISK_TIER_ORDER.
const tierDescriptions = [
	{ key: 'kete.governance.tier.read', value: localize('kete.governance.tier.read', "Reading files and describing state.") },
	{ key: 'kete.governance.tier.localWrite', value: localize('kete.governance.tier.localWrite', "Changes confined to your own working tree.") },
	{ key: 'kete.governance.tier.localInfra', value: localize('kete.governance.tier.localInfra', "Containers and services on your own machine.") },
	{ key: 'kete.governance.tier.remoteInfra', value: localize('kete.governance.tier.remoteInfra', "Anything addressing a remote or shared cluster.") },
	{ key: 'kete.governance.tier.production', value: localize('kete.governance.tier.production', "Deploys, pushes to protected branches, and production changes.") },
];

// Both settings are application-scoped, so values in a workspace or folder's
// settings are ignored: a repository cannot lower the bar for its own code.
//
// Both are also policy-backed (D-003). A policy value is applied after user
// settings, so an administrator can pin the threshold. The gate only lets a
// policy switch gating on, never off, and ignores the user's development
// switch while either setting is pinned; see GovernanceGate.
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'keteGovernance',
	title: localize('governanceConfigurationTitle', "Kete Governance"),
	type: 'object',
	properties: {
		[GovernanceConfigKeys.ApprovalThreshold]: {
			type: 'string',
			enum: [...RISK_TIER_ORDER],
			enumDescriptions: tierDescriptions.map(description => description.value),
			default: DEFAULT_APPROVAL_THRESHOLD,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('governanceApprovalThreshold', "The lowest risk tier at which an agent action needs your approval before it runs. Every action, allowed or denied, is recorded in the Kete Governance Audit log. Only user settings and your organization's policy can change this; workspace settings are ignored."),
			policy: {
				name: 'KeteGovernanceApprovalThreshold',
				category: PolicyCategory.InteractiveSession,
				minimumVersion: '1.139',
				localization: {
					description: {
						key: 'kete.governance.approvalThreshold.policy',
						value: localize('kete.governance.approvalThreshold.policy', "The lowest risk tier at which a Kete Workbench agent action needs human approval before it runs. Setting this policy also prevents users from turning approval gating off."),
					},
					enumDescriptions: tierDescriptions,
				},
			},
		},
		[GovernanceConfigKeys.Enabled]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			tags: ['advanced'],
			markdownDescription: localize('governanceEnabled', "For development only. When disabled, agent actions are still recorded in the Kete Governance Audit log but never require approval. Workspace settings are ignored, and so is this setting when your organization manages governance through policy."),
			policy: {
				name: 'KeteGovernanceEnabled',
				category: PolicyCategory.InteractiveSession,
				minimumVersion: '1.139',
				localization: {
					description: {
						key: 'kete.governance.enabled.policy',
						value: localize('kete.governance.enabled.policy', "Requires Kete Workbench agent actions at or above the approval threshold to be approved by a human, and prevents users from turning this off. Approval gating cannot be disabled through policy: a policy value of false is treated as true."),
					},
				},
			},
		},
	},
});
