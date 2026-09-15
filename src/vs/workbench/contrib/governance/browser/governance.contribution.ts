/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isDefined } from '../../../../base/common/types.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IApprovalRequest, IGovernanceApprover, IGovernanceGate } from '../../../../platform/governance/common/governance.js';
import { IAuditEntry, IAuditSink } from '../../../../platform/governance/common/governanceAuditLog.js';
import { AuthoritativeAuditSink, FileAuditStore, GOVERNANCE_AUDIT_FOLDER_NAME } from '../../../../platform/governance/common/governanceAuditStore.js';
import { GovernanceGate } from '../../../../platform/governance/common/governanceGate.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogger, ILoggerService, ILogService } from '../../../../platform/log/common/log.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
// The governance settings and their policies.
import '../common/governanceConfiguration.js';

/**
 * Writes each audit entry as one JSON line to the "Kete Governance Audit" log,
 * which is kept in the session's logs folder and shown in the Output panel.
 *
 * A convenience view only: logs rotate away, and a logger write cannot report
 * failure. The durable record is the {@link FileAuditStore}.
 */
class LoggerAuditSink implements IAuditSink {

	constructor(private readonly logger: ILogger) { }

	async append(entry: IAuditEntry): Promise<void> {
		this.logger.info(JSON.stringify(entry));
	}
}

/** The governance gate as registered in the workbench. */
export class WorkbenchGovernanceGate extends GovernanceGate {

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
		@ILoggerService loggerService: ILoggerService,
		@IFileService fileService: IFileService,
		@IUserDataProfilesService userDataProfilesService: IUserDataProfilesService,
	) {
		// Audit entries must be written whatever the user's log level is.
		const logger = loggerService.createLogger('keteGovernanceAudit', {
			name: localize('governanceAuditLog', "Kete Governance Audit"),
			logLevel: 'always',
		});
		// The durable store decides whether a decision was recorded; if it cannot
		// write, the gate denies. See GOVERNANCE_AUDIT_FOLDER_NAME for the location.
		const store = new FileAuditStore(joinPath(userDataProfilesService.defaultProfile.globalStorageHome, GOVERNANCE_AUDIT_FOLDER_NAME), fileService);
		super(new AuthoritativeAuditSink(store, [new LoggerAuditSink(logger)]), configurationService, logService);
		this._register(logger);
	}
}

/**
 * Asks the user with a modal dialog. This is the fallback: a tool call that went
 * through a chat or dialog confirmation carries that decision to the gate
 * instead, so the user is asked once.
 */
class DialogGovernanceApprover implements IGovernanceApprover {

	readonly source = 'governance dialog';

	constructor(private readonly dialogService: IDialogService) { }

	async requestApproval(request: IApprovalRequest): Promise<boolean> {
		const { action } = request;
		const detail = [
			localize('governanceApprovalAction', "Action: {0}", action.name),
			action.commandLine ? localize('governanceApprovalCommand', "Command: {0}", action.commandLine) : undefined,
			localize('governanceApprovalOrigin', "Requested by: {0}", action.origin),
			localize('governanceApprovalTier', "Risk tier: {0}", request.tier),
		].filter(isDefined).join('\n');

		const result = await this.dialogService.confirm({
			type: 'warning',
			message: localize('governanceApprovalMessage', "Allow this action? Kete Workbench's governance policy requires human approval for it."),
			detail,
			primaryButton: localize({ key: 'governanceApprovalAllow', comment: ['&& denotes a mnemonic'] }, "&&Allow"),
			cancelButton: localize('governanceApprovalDeny', "Deny"),
		});
		return result.confirmed;
	}
}

class GovernanceApprovalContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.keteGovernanceApproval';

	constructor(
		@IGovernanceGate governanceGate: IGovernanceGate,
		@IDialogService dialogService: IDialogService,
	) {
		super();
		this._register(governanceGate.registerApprover(new DialogGovernanceApprover(dialogService)));
	}
}

registerSingleton(IGovernanceGate, WorkbenchGovernanceGate, InstantiationType.Delayed);

// Registered before chat can restore a session and invoke tools. Until an
// approver is registered, the gate denies every action that needs one.
registerWorkbenchContribution2(GovernanceApprovalContribution.ID, GovernanceApprovalContribution, WorkbenchPhase.BlockRestore);
