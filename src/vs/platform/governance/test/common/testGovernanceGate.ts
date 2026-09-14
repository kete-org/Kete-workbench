/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { GovernanceOutcome, GovernanceRiskTier, IGovernanceApprover, IGovernanceDecision, IGovernanceGate, IGovernedAction } from '../../common/governance.js';

/**
 * A gate for testing code that calls {@link IGovernanceGate}: it records every
 * action it is asked to authorize and answers with a fixed outcome.
 */
export class TestGovernanceGate implements IGovernanceGate {

	declare readonly _serviceBrand: undefined;

	readonly actions: IGovernedAction[] = [];

	constructor(public outcome: GovernanceOutcome = GovernanceOutcome.Allowed) { }

	async authorize(action: IGovernedAction, _token: CancellationToken): Promise<IGovernanceDecision> {
		this.actions.push(action);
		return {
			outcome: this.outcome,
			tier: GovernanceRiskTier.Read,
			approvalRequested: false,
			reason: this.outcome === GovernanceOutcome.Allowed ? 'allowed by the test gate' : 'denied by the test gate',
			auditId: `test-${this.actions.length}`,
		};
	}

	registerApprover(_approver: IGovernanceApprover): IDisposable {
		return toDisposable(() => { });
	}
}
