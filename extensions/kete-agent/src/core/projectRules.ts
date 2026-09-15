/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// `.ide-config.json`: a project's structured agent configuration, versioned with
// the repository. It adds rules to the prompt and hints to model routing. It can
// never change governance: only the keys below are read, and governance-like
// keys are reported and dropped. The schema contributed for editing is
// `schemas/ide-config.schema.json`; keep the two in step.

/** The rules file's name, looked up at the root of each workspace folder. */
export const PROJECT_RULES_FILE_NAME = '.ide-config.json';

/** The only schema version this client understands. */
export const PROJECT_RULES_VERSION = 1;

/** Largest rules file read, in characters. Larger files are ignored. */
export const MAX_PROJECT_RULES_FILE_CHARS = 64 * 1024;

/** Most entries read from each list. */
export const MAX_RULE_ENTRIES = 100;

/** Longest entry kept, in characters. */
export const MAX_RULE_ENTRY_CHARS = 1000;

/**
 * Model tiers a project can hint at, cheapest first: a small local model, a mid
 * tier, and a frontier model.
 */
export const MODEL_TIERS = ['local', 'mid', 'frontier'] as const;

/**
 * A model tier.
 */
export type ModelTier = typeof MODEL_TIERS[number];

/**
 * Model routing hints. The router may ignore them, for example when offline.
 */
export interface ModelRoutingHints {
	readonly preferredTier?: ModelTier;
	readonly maxTier?: ModelTier;
}

/**
 * The validated contents of a rules file.
 */
export interface ProjectRules {
	readonly rules: readonly string[];
	readonly codingStandards: readonly string[];
	readonly modelRouting?: ModelRoutingHints;
}

/**
 * A problem found while reading a rules file. Carries a code rather than a
 * message so each client can localize it.
 */
export interface ProjectRulesProblem {
	readonly code:
	| 'unreadable'
	| 'tooLarge'
	| 'invalidJson'
	| 'notAnObject'
	| 'unsupportedVersion'
	| 'governanceKeyIgnored'
	| 'unknownKeyIgnored'
	| 'invalidValue'
	| 'entriesTruncated'
	| 'preferredTierAboveMaxTier';
	/** The JSON path of the key concerned, e.g. `modelRouting.maxTier`. */
	readonly path?: string;
}

/**
 * The result of reading a rules file. `rules` is `undefined` when the file
 * couldn't be used at all.
 */
export interface ProjectRulesParseResult {
	readonly rules: ProjectRules | undefined;
	readonly problems: readonly ProjectRulesProblem[];
}

// Keys that look like an attempt to configure approval, audit or permissions.
// They are never honoured; they are reported separately from other unknown keys
// so the person sees that governance can't be set from a repository.
const governanceLikeKey = /govern|approv|threshold|audit|polic|permission|confirm|trust|sandbox|allow|deny|yolo|autopilot/i;

const topLevelKeys = new Set(['$schema', 'version', 'rules', 'codingStandards', 'modelRouting']);
const modelRoutingKeys = new Set(['preferredTier', 'maxTier']);

/**
 * Parses and validates the text of a rules file.
 */
export function parseProjectRules(text: string): ProjectRulesParseResult {
	if (text.length > MAX_PROJECT_RULES_FILE_CHARS) {
		return { rules: undefined, problems: [{ code: 'tooLarge' }] };
	}

	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return { rules: undefined, problems: [{ code: 'invalidJson' }] };
	}
	if (!isPlainObject(json)) {
		return { rules: undefined, problems: [{ code: 'notAnObject' }] };
	}

	const problems: ProjectRulesProblem[] = [];
	reportIgnoredKeys(json, topLevelKeys, '', problems);

	if (json.version !== undefined && json.version !== PROJECT_RULES_VERSION) {
		problems.push({ code: 'unsupportedVersion', path: 'version' });
	}

	const rules = readStringList(json.rules, 'rules', problems);
	const codingStandards = readStringList(json.codingStandards, 'codingStandards', problems);
	const modelRouting = readModelRouting(json.modelRouting, problems);

	return {
		rules: { rules, codingStandards, ...(modelRouting ? { modelRouting } : {}) },
		problems,
	};
}

/**
 * True when the rules add nothing to the prompt or routing.
 */
export function isEmptyProjectRules(rules: ProjectRules): boolean {
	return !rules.rules.length && !rules.codingStandards.length && !rules.modelRouting;
}

function readStringList(value: unknown, path: string, problems: ProjectRulesProblem[]): string[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		problems.push({ code: 'invalidValue', path });
		return [];
	}

	const entries: string[] = [];
	for (const [index, entry] of value.entries()) {
		if (typeof entry !== 'string') {
			problems.push({ code: 'invalidValue', path: `${path}[${index}]` });
			continue;
		}
		// One line per entry, so an entry can't open a prompt section of its own.
		const trimmed = entry.replace(/\s+/g, ' ').trim();
		if (trimmed) {
			entries.push(trimmed.length > MAX_RULE_ENTRY_CHARS ? trimmed.slice(0, MAX_RULE_ENTRY_CHARS) : trimmed);
		}
	}

	if (entries.length > MAX_RULE_ENTRIES) {
		problems.push({ code: 'entriesTruncated', path });
		return entries.slice(0, MAX_RULE_ENTRIES);
	}
	return entries;
}

function readModelRouting(value: unknown, problems: ProjectRulesProblem[]): ModelRoutingHints | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isPlainObject(value)) {
		problems.push({ code: 'invalidValue', path: 'modelRouting' });
		return undefined;
	}
	reportIgnoredKeys(value, modelRoutingKeys, 'modelRouting.', problems);

	const maxTier = readTier(value.maxTier, 'modelRouting.maxTier', problems);
	let preferredTier = readTier(value.preferredTier, 'modelRouting.preferredTier', problems);
	if (preferredTier && maxTier && MODEL_TIERS.indexOf(preferredTier) > MODEL_TIERS.indexOf(maxTier)) {
		problems.push({ code: 'preferredTierAboveMaxTier', path: 'modelRouting.preferredTier' });
		preferredTier = maxTier;
	}

	if (!preferredTier && !maxTier) {
		return undefined;
	}
	return { ...(preferredTier ? { preferredTier } : {}), ...(maxTier ? { maxTier } : {}) };
}

function readTier(value: unknown, path: string, problems: ProjectRulesProblem[]): ModelTier | undefined {
	if (value === undefined) {
		return undefined;
	}
	const tier = MODEL_TIERS.find(candidate => candidate === value);
	if (!tier) {
		problems.push({ code: 'invalidValue', path });
	}
	return tier;
}

function reportIgnoredKeys(object: Record<string, unknown>, known: ReadonlySet<string>, pathPrefix: string, problems: ProjectRulesProblem[]): void {
	for (const key of Object.keys(object)) {
		if (known.has(key)) {
			continue;
		}
		problems.push({ code: governanceLikeKey.test(key) ? 'governanceKeyIgnored' : 'unknownKeyIgnored', path: `${pathPrefix}${key}` });
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
