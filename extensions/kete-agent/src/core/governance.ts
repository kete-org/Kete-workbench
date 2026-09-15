/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the agent core knows about governance: how to recognise a refusal, and
// the risk tiers it may describe to the model. It enforces nothing. Enforcement
// is the platform gate's job (D-003), reached through the tool and model APIs.

/**
 * The start of the tool result the governance gate returns in place of a denied
 * call. It must match `governanceDenialMessage` in
 * `src/vs/workbench/contrib/governance/common/governedActions.ts`.
 */
export const GOVERNANCE_DENIAL_PREFIX = 'Kete Workbench\'s governance gate did not allow this action';

/**
 * True when a tool result is the governance gate's refusal rather than the
 * tool's own output.
 */
export function isGovernanceDenial(toolResultText: string): boolean {
	return toolResultText.trimStart().startsWith(GOVERNANCE_DENIAL_PREFIX);
}

/**
 * The gate's risk tiers, lowest first. Mirrors `RISK_TIER_ORDER` in
 * `src/vs/platform/governance/common/governance.ts`.
 */
export const GOVERNANCE_RISK_TIERS = ['read', 'localWrite', 'localInfra', 'remoteInfra', 'production'] as const;

/**
 * A governance risk tier.
 */
export type GovernanceRiskTier = typeof GOVERNANCE_RISK_TIERS[number];

/**
 * The gate's default approval threshold, used when the setting can't be read.
 */
export const DEFAULT_GOVERNANCE_APPROVAL_THRESHOLD: GovernanceRiskTier = 'remoteInfra';

/**
 * Setting ids the agent reads, never writes. Both are application-scoped and
 * policy-backed, so a workspace can't change them.
 */
export const GovernanceSettings = {
	approvalThreshold: 'kete.governance.approvalThreshold',
} as const;

/**
 * Narrows a setting value to a known risk tier.
 */
export function toGovernanceRiskTier(value: unknown): GovernanceRiskTier | undefined {
	return GOVERNANCE_RISK_TIERS.find(tier => tier === value);
}
