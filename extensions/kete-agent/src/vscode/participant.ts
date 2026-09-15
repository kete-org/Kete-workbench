/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { runAgentLoop } from '../core/agentLoop';
import { AgentMessage } from '../core/agentTypes';
import { computeContextBudget, ContextItem, fitHistory, renderRetrievedContext } from '../core/contextAssembly';
import { DEFAULT_GOVERNANCE_APPROVAL_THRESHOLD, GovernanceRiskTier, GovernanceSettings, toGovernanceRiskTier } from '../core/governance';
import { KETE_ROUTING_MODEL_OPTION, mergeRoutingHints, selectAgentModel, toRouterHints } from '../core/modelSelection';
import { ProjectRulesProblem } from '../core/projectRules';
import { FolderProjectRules, ProjectRulesLoader } from '../core/projectRulesLoader';
import { composeSystemPrompt, DEFAULT_AGENT_MODE } from '../core/promptComposition';
import { selectTools, toAgentHistory, VsCodeAgentModel, VsCodeToolInvoker } from './languageModelAdapter';
import { rulesFileUri } from './projectRulesHost';

/**
 * Participant ids contributed in package.json: `@kete`, which people mention
 * explicitly, and the default participant that answers un-addressed requests in
 * the chat panel. Both run the same agent.
 */
const PARTICIPANT_IDS = ['kete.agent', 'kete.agent.default'];

/** Most tools offered to the model in one request; some providers reject more. */
const MAX_TOOLS = 128;

/** Largest attached file read into the request's context. */
const MAX_REFERENCE_BYTES = 256 * 1024;

/** Command that opens the language model management editor. */
const MANAGE_MODELS_COMMAND = 'workbench.action.chat.manage';

/**
 * Registers Kete's chat participants.
 */
export function registerKeteParticipants(loader: ProjectRulesLoader): vscode.Disposable {
	const disposables: vscode.Disposable[] = [];

	// Rules file problems are reported once per change, not on every request.
	const reportedProblems = new Set<string>();
	disposables.push(loader.onDidChange(() => reportedProblems.clear()));

	const handler: vscode.ChatRequestHandler = (request, context, stream, token) => handleRequest(request, context, stream, token, loader, reportedProblems);
	for (const id of PARTICIPANT_IDS) {
		const participant = vscode.chat.createChatParticipant(id, handler);
		participant.iconPath = new vscode.ThemeIcon('sparkle');
		disposables.push(participant);
	}
	return vscode.Disposable.from(...disposables);
}

async function handleRequest(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, loader: ProjectRulesLoader, reportedProblems: Set<string>): Promise<vscode.ChatResult> {
	const selection = await selectAgentModel({ select: selector => vscode.lm.selectChatModels(selector) }, request.model);
	if (!selection) {
		stream.markdown(vscode.l10n.t('Kete needs a language model, but none is available. Add a model provider or enable one of your models, then try again.'));
		stream.button({ command: MANAGE_MODELS_COMMAND, title: vscode.l10n.t('Manage Language Models') });
		return { metadata: { stopReason: 'noModel' } };
	}

	const folderRules = await loader.getRules();
	reportRulesProblems(folderRules, stream, reportedProblems);

	const system = composeSystemPrompt({
		governance: { approvalThreshold: readApprovalThreshold() },
		projectRules: folderRules,
		// Modes (`kete.mode`, D-008) are planned; until then every request runs in Code mode.
		mode: DEFAULT_AGENT_MODE,
	}).text;

	const tools = selectTools(request, MAX_TOOLS);
	const budget = computeContextBudget(selection.model.maxInputTokens, system, tools);
	const retrieved = renderRetrievedContext(await collectReferences(request.references), budget.contextChars);
	const current: AgentMessage = { role: 'user', parts: [{ kind: 'text', text: retrieved ? `${request.prompt}\n\n${retrieved}` : request.prompt }] };
	const { messages } = fitHistory(toAgentHistory(context.history), current, budget.availableTokens);

	// Routing hints only mean something to Kete's own router, and a project may
	// only cap the tier, not raise it.
	const routing = selection.source === 'keteAuto' ? toRouterHints(mergeRoutingHints(folderRules)) : undefined;

	const result = await runAgentLoop({
		model: new VsCodeAgentModel(selection.model, token, routing && { [KETE_ROUTING_MODEL_OPTION]: routing }),
		invoker: new VsCodeToolInvoker(request.toolInvocationToken, token),
		system,
		messages,
		tools,
		progress: { text: chunk => stream.markdown(chunk) },
		signal: token,
		maxToolResultChars: budget.toolResultChars,
	});

	switch (result.stopReason) {
		case 'maxIterations':
			stream.markdown('\n\n' + vscode.l10n.t('Kete stopped after {0} steps without finishing. Send a follow-up message to let it continue.', result.iterations));
			break;
		case 'modelError':
			stream.markdown('\n\n' + vscode.l10n.t('The request to {0} failed: {1}', selection.model.name, result.error ?? ''));
			break;
	}

	return {
		metadata: {
			stopReason: result.stopReason,
			iterations: result.iterations,
			toolCalls: result.toolCalls.length,
			modelSource: selection.source,
		},
	};
}

/**
 * The approval threshold in effect, for the governance prompt layer. The setting
 * is application-scoped and policy-backed, so a workspace can't change it.
 */
function readApprovalThreshold(): GovernanceRiskTier {
	return toGovernanceRiskTier(vscode.workspace.getConfiguration().get(GovernanceSettings.approvalThreshold)) ?? DEFAULT_GOVERNANCE_APPROVAL_THRESHOLD;
}

/**
 * Reads what the person attached to the request, including the instruction
 * files (such as AGENTS.md) the workbench attaches automatically. Reads only.
 */
async function collectReferences(references: readonly vscode.ChatPromptReference[]): Promise<ContextItem[]> {
	const items: ContextItem[] = [];
	const decoder = new TextDecoder();
	for (const reference of references) {
		const { value } = reference;
		if (typeof value === 'string') {
			items.push({ label: reference.modelDescription ?? reference.id, content: value });
			continue;
		}

		const uri = value instanceof vscode.Uri ? value : value instanceof vscode.Location ? value.uri : undefined;
		if (!uri) {
			continue;
		}
		try {
			const stat = await vscode.workspace.fs.stat(uri);
			if (stat.type !== vscode.FileType.File || stat.size > MAX_REFERENCE_BYTES) {
				continue;
			}
			let content = decoder.decode(await vscode.workspace.fs.readFile(uri));
			if (content.includes('\u0000')) {
				continue; // binary
			}
			if (value instanceof vscode.Location) {
				content = content.split(/\r?\n/).slice(value.range.start.line, value.range.end.line + 1).join('\n');
			}
			items.push({ label: vscode.workspace.asRelativePath(uri), content });
		} catch {
			// Unreadable attachments are left out.
		}
	}
	return items;
}

function reportRulesProblems(folders: readonly FolderProjectRules[], stream: vscode.ChatResponseStream, reported: Set<string>): void {
	for (const { folder, problems } of folders) {
		for (const problem of problems) {
			const message = describeProblem(problem, vscode.workspace.asRelativePath(rulesFileUri(folder)));
			const key = `${folder.uri}|${problem.code}|${problem.path ?? ''}`;
			if (message && !reported.has(key)) {
				reported.add(key);
				stream.warning(message);
			}
		}
	}
}

/**
 * The message shown in chat for a rules file problem. Problems the JSON schema
 * already underlines in the editor aren't repeated.
 */
function describeProblem(problem: ProjectRulesProblem, file: string): string | undefined {
	switch (problem.code) {
		case 'unreadable':
			return vscode.l10n.t('{0} could not be read, so its project rules were not applied.', file);
		case 'tooLarge':
			return vscode.l10n.t('{0} is too large, so its project rules were not applied.', file);
		case 'invalidJson':
		case 'notAnObject':
			return vscode.l10n.t('{0} is not a valid JSON object, so its project rules were not applied.', file);
		case 'governanceKeyIgnored':
			return vscode.l10n.t('{0}: "{1}" was ignored. Governance settings cannot be changed by a project file.', file, problem.path ?? '');
		default:
			return undefined;
	}
}
