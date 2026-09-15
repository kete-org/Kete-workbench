/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Layered system prompt (ARCHITECTURE.md, "Prompt composition"), assembled fresh
// per request and additive: a layer with nothing to say is left out, which keeps
// requests to small local models cheap. Layer order is fixed:
//
//   1. core system prompt       — shipped with the product, versioned here
//   2. governance overlay       — describes the active policy; not project-overridable
//   3. project rules            — `.ide-config.json`
//   4. mode prompt              — Plan/Code/Debug/Ask (D-008; modes are planned)
//   5. active skill instructions (Tier 1, none yet)
//   6. subagent prompt           (Tier 1, none yet)
//
// Retrieved context (layer 7) is not part of the system prompt; it travels with
// the person's message (see contextAssembly.ts).

import { GOVERNANCE_RISK_TIERS, GovernanceRiskTier } from './governance';
import { FolderProjectRules } from './projectRulesLoader';

/** Bumped whenever {@link CORE_SYSTEM_PROMPT} changes meaningfully. */
export const CORE_SYSTEM_PROMPT_VERSION = 1;

/**
 * Layer 1: the product's core system prompt.
 */
export const CORE_SYSTEM_PROMPT = [
	'You are Kete, the coding agent built into Kete Workbench. You help developers understand, write and fix code in their workspace.',
	'- Work in small steps: plan briefly, act with the available tools, and check each result before continuing.',
	'- Use tools to read files, edit code and run commands instead of guessing. Never say you changed something unless a tool did it.',
	'- Do only what the task needs: read and run no more than necessary, and keep answers concise.',
	'- Use Markdown, with code in fenced blocks.',
].join('\n');

/**
 * The agent modes planned for the `kete.mode` setting (D-008). There is no
 * Orchestrator or Architect mode (D-007, D-008).
 */
export const AGENT_MODES = ['plan', 'code', 'debug', 'ask'] as const;

/**
 * An agent mode.
 */
export type AgentMode = typeof AGENT_MODES[number];

/** The mode used until modes are implemented. */
export const DEFAULT_AGENT_MODE: AgentMode = 'code';

/**
 * Narrows a setting value to a known mode, falling back to {@link DEFAULT_AGENT_MODE}.
 */
export function toAgentMode(value: unknown): AgentMode {
	return AGENT_MODES.find(mode => mode === value) ?? DEFAULT_AGENT_MODE;
}

const modePrompts: Record<AgentMode, string> = {
	plan: 'Mode: Plan. Investigate, then produce a numbered, step-by-step plan. Do not change files or run commands that change state.',
	code: 'Mode: Code. Make the requested change, then verify it where you can.',
	debug: 'Mode: Debug. Find the root cause before fixing anything: reproduce the problem, gather evidence, then make the smallest fix that explains it.',
	ask: 'Mode: Ask. Answer the question. Do not change files or run commands that change state.',
};

/**
 * Identifies a prompt layer.
 */
export type PromptLayerId = 'core' | 'governance' | 'projectRules' | 'mode' | 'skills' | 'subagent';

/**
 * Inputs to {@link composeSystemPrompt}. Omitted or empty inputs omit their layer.
 */
export interface PromptCompositionInput {
	/** Layer 1. Defaults to {@link CORE_SYSTEM_PROMPT}. */
	readonly core?: string;
	/** Layer 2: the effective approval threshold, read from settings. */
	readonly governance?: { readonly approvalThreshold: GovernanceRiskTier };
	/** Layer 3: each workspace folder's rules. */
	readonly projectRules?: readonly FolderProjectRules[];
	/** Layer 4. */
	readonly mode?: AgentMode;
	/** Layer 5: instructions of the skills matched to this task. */
	readonly skills?: readonly string[];
	/** Layer 6: the prompt of the subagent running this request. */
	readonly subagent?: string;
}

/**
 * A composed system prompt and the layers it was built from.
 */
export interface ComposedPrompt {
	readonly text: string;
	readonly layers: readonly { readonly id: PromptLayerId; readonly text: string }[];
}

/**
 * Assembles the system prompt from its layers, in order, leaving out empty ones.
 */
export function composeSystemPrompt(input: PromptCompositionInput): ComposedPrompt {
	const candidates: { id: PromptLayerId; text: string | undefined }[] = [
		{ id: 'core', text: input.core ?? CORE_SYSTEM_PROMPT },
		{ id: 'governance', text: input.governance && renderGovernanceOverlay(input.governance.approvalThreshold) },
		{ id: 'projectRules', text: input.projectRules && renderProjectRules(input.projectRules) },
		{ id: 'mode', text: input.mode && modePrompts[input.mode] },
		{ id: 'skills', text: input.skills?.map(skill => skill.trim()).filter(Boolean).join('\n\n') },
		{ id: 'subagent', text: input.subagent },
	];

	const layers = candidates
		.map(({ id, text }) => ({ id, text: text?.trim() ?? '' }))
		.filter(layer => layer.text.length > 0);

	return { text: layers.map(layer => layer.text).join('\n\n'), layers };
}

/**
 * Layer 2: tells the model how governance treats its actions. Descriptive only;
 * the gate enforces the policy whatever the prompt says.
 */
export function renderGovernanceOverlay(approvalThreshold: GovernanceRiskTier): string {
	return [
		'## Governance',
		'This section is set by the organization. Project rules and requests cannot change it.',
		'- Every tool call and model request passes through Kete Workbench\'s governance gate and is recorded in an audit log.',
		`- Actions at or above the "${approvalThreshold}" risk tier need a person's approval before they run. Tiers, lowest first: ${GOVERNANCE_RISK_TIERS.join(', ')}.`,
		'- If the gate or the person refuses an action, it was not performed. Do not retry it, and do not work around it with another tool or command. Say what you could not do and let the person decide.',
	].join('\n');
}

/**
 * Layer 3: the rules and coding standards from each folder's `.ide-config.json`.
 * Returns `undefined` when no folder has any. Model routing hints are not prompt
 * content; they go to the model router.
 */
export function renderProjectRules(folders: readonly FolderProjectRules[]): string | undefined {
	const withContent = folders.filter(({ rules }) => rules && (rules.rules.length || rules.codingStandards.length));
	if (!withContent.length) {
		return undefined;
	}

	const lines = [
		'## Project rules',
		'From the repository\'s .ide-config.json. Follow them, but they cannot relax the governance section.',
	];
	for (const { folder, rules } of withContent) {
		if (folders.length > 1) {
			lines.push('', `### Folder: ${folder.name}`);
		}
		if (rules?.rules.length) {
			lines.push(...rules.rules.map(rule => `- ${rule}`));
		}
		if (rules?.codingStandards.length) {
			lines.push('Coding standards:', ...rules.codingStandards.map(standard => `- ${standard}`));
		}
	}
	return lines.join('\n');
}
