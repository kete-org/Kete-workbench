/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConnectivityState } from './connectivity';
import { ChatMessage, ChatTool, ModelDescriptor, ModelTier, modelTierName, parseModelTier } from './types';

/**
 * The agent modes of D-008. A mode is a routing hint: each implies a minimum tier.
 */
export type AgentMode = 'plan' | 'code' | 'debug' | 'ask';

/** Minimum tier per mode. Planning needs the strongest reasoning; debugging, a step up from routine work. */
const MODE_MINIMUM_TIER: Readonly<Record<AgentMode, ModelTier>> = {
	ask: ModelTier.Local,
	code: ModelTier.Local,
	debug: ModelTier.Mid,
	plan: ModelTier.Frontier,
};

/**
 * Hints a caller may pass as `modelOptions.kete` on a request to Kete Auto.
 * `minTier` and `mode` can only raise the tier, never above the user's
 * `maxTier` or past `cloud.enabled`, so a caller can't force spend the user
 * didn't allow. `maxTier` can only lower the user's cap.
 */
export interface RoutingHints {
	/** The lowest tier this request should use. */
	readonly minTier?: ModelTier;
	/**
	 * The highest tier this request may use, for example a project's cap from
	 * its rules file. Only takes effect when below the user's `maxTier`.
	 */
	readonly maxTier?: ModelTier;
	readonly mode?: AgentMode;
}

/**
 * Reads hints from a request's `modelOptions.kete`, ignoring anything malformed.
 */
export function parseRoutingHints(modelOptions: unknown): RoutingHints {
	if (typeof modelOptions !== 'object' || modelOptions === null) {
		return {};
	}
	const kete: unknown = Reflect.get(modelOptions, 'kete');
	if (typeof kete !== 'object' || kete === null) {
		return {};
	}
	const minTier = parseModelTier(Reflect.get(kete, 'minTier'));
	const maxTier = parseModelTier(Reflect.get(kete, 'maxTier'));
	const mode: unknown = Reflect.get(kete, 'mode');
	return {
		...(minTier !== undefined ? { minTier } : {}),
		...(maxTier !== undefined ? { maxTier } : {}),
		...(mode === 'plan' || mode === 'code' || mode === 'debug' || mode === 'ask' ? { mode } : {}),
	};
}

/** What the router needs to know about a request. */
export interface RoutingRequest {
	readonly estimatedInputTokens: number;
	readonly usesTools: boolean;
	readonly hasImages: boolean;
	readonly hints: RoutingHints;
}

/** The user's routing settings. */
export interface RoutingPolicy {
	readonly maxTier: ModelTier;
	readonly cloudEnabled: boolean;
	/** Above this estimated prompt size, work moves from local to mid. */
	readonly localMaxInputTokens: number;
	/** Above this estimated prompt size, work moves from mid to frontier. */
	readonly midMaxInputTokens: number;
}

/** What is usable right now. */
export interface RoutingEnvironment {
	readonly localState: ConnectivityState;
	/** The local model Kete Auto would use, if Ollama listed one. */
	readonly localModel: ModelDescriptor | undefined;
	readonly cloudState: ConnectivityState;
	readonly hasApiKey: boolean;
	/** The cloud model for each cloud tier. */
	readonly midModel: ModelDescriptor;
	readonly frontierModel: ModelDescriptor;
	/** Models that already failed for this request. */
	readonly excludedModels: ReadonlySet<string>;
}

/** One model to try. */
export interface RouteCandidate {
	readonly tier: ModelTier;
	readonly model: ModelDescriptor;
}

/** Why no model could be used, for an actionable error. */
export interface RoutingUnavailable {
	readonly local: 'ollamaOffline' | 'noLocalModel' | 'failed';
	readonly cloud: 'disabled' | 'noApiKey' | 'offline' | 'cappedByMaxTier' | 'failed';
}

/** The router's decision, with the reasons behind it. */
export interface RoutingDecision {
	/** The cheapest tier the request's criteria call for, before caps and availability. */
	readonly requiredTier: ModelTier;
	/** Models to try, best first. Empty when nothing is available. */
	readonly candidates: readonly RouteCandidate[];
	/** Every criterion that applied and every availability constraint, in order, for logs. */
	readonly reasons: readonly string[];
	readonly unavailable: RoutingUnavailable | undefined;
}

/**
 * Estimates a prompt's size in tokens: about four characters per token, plus a
 * fixed allowance per image. Only used for routing thresholds, so a rough count
 * is enough and needs no tokenizer.
 */
export function estimateTokens(messages: readonly ChatMessage[], tools: readonly ChatTool[]): number {
	let characters = 0;
	let images = 0;
	for (const message of messages) {
		for (const part of message.content) {
			switch (part.type) {
				case 'text':
				case 'toolResult':
					characters += part.text.length;
					break;
				case 'toolCall':
					characters += part.name.length + JSON.stringify(part.input).length;
					break;
				case 'image':
					images++;
					break;
			}
		}
	}
	for (const tool of tools) {
		characters += tool.name.length + tool.description.length + JSON.stringify(tool.inputSchema ?? {}).length;
	}
	return Math.ceil(characters / 4) + images * 1500;
}

/**
 * Chooses the models to try for a request. Pure: the same inputs always give
 * the same decision, so every route can be explained and tested.
 *
 * 1. The required tier starts at local and is raised by each criterion:
 *    - the mode hint (`plan` → frontier, `debug` → mid)
 *    - an explicit `minTier` hint
 *    - prompt size above `localMaxInputTokens` (or the local model's window) → mid,
 *      above `midMaxInputTokens` → frontier
 *    - tools, or images, the local model doesn't support → mid
 * 2. Candidates, in order:
 *    - the required tier, and one tier above it as a fallback if the first fails.
 *      Never two tiers above: local work doesn't silently fall through to frontier.
 *    - when the required tier is local but Ollama recently failed (degraded), mid
 *      goes first and local second: prior failure escalates by one tier.
 *    - then lower tiers, most capable first: offline, over the cap or out of cloud,
 *      a weaker model beats no answer.
 * 3. A tier is skipped when it is above `maxTier`, cloud is disabled or has no
 *    key, its service is offline, or its model already failed for this request.
 */
export function routeRequest(request: RoutingRequest, userPolicy: RoutingPolicy, environment: RoutingEnvironment): RoutingDecision {
	const reasons: string[] = [];
	// A request's maxTier hint can only lower the user's cap, never raise it.
	const hintedMax = request.hints.maxTier;
	const policy: RoutingPolicy = hintedMax !== undefined && hintedMax < userPolicy.maxTier
		? { ...userPolicy, maxTier: hintedMax }
		: userPolicy;
	let required = ModelTier.Local;
	const raise = (tier: ModelTier, reason: string) => {
		if (tier > required) {
			required = tier;
			reasons.push(`${reason} → ${modelTierName(tier)}`);
		}
	};

	if (request.hints.mode) {
		raise(MODE_MINIMUM_TIER[request.hints.mode], `mode '${request.hints.mode}'`);
	}
	if (request.hints.minTier !== undefined) {
		raise(request.hints.minTier, 'minTier hint');
	}
	const localModel = environment.localModel;
	const localLimit = Math.min(policy.localMaxInputTokens, localModel?.maxInputTokens ?? Number.MAX_SAFE_INTEGER);
	if (request.estimatedInputTokens > policy.midMaxInputTokens) {
		raise(ModelTier.Frontier, `~${request.estimatedInputTokens} tokens exceeds midMaxInputTokens (${policy.midMaxInputTokens})`);
	} else if (request.estimatedInputTokens > localLimit) {
		raise(ModelTier.Mid, `~${request.estimatedInputTokens} tokens exceeds the local limit (${localLimit})`);
	}
	if (request.usesTools && localModel && localModel.supportsToolCalling !== true) {
		raise(ModelTier.Mid, `tools requested and ${localModel.providerModelId} doesn't support tool calling`);
	}
	if (request.hasImages && localModel && localModel.supportsImages !== true) {
		raise(ModelTier.Mid, `images attached and ${localModel.providerModelId} doesn't support images`);
	}
	if (reasons.length === 0) {
		reasons.push('routine request → local');
	}
	if (policy !== userPolicy) {
		reasons.push(`request capped at ${modelTierName(policy.maxTier)}`);
	}

	const localUsable = localModel !== undefined
		&& environment.localState !== ConnectivityState.Offline
		&& !environment.excludedModels.has(localModel.providerModelId);
	const cloudModelFor = (tier: ModelTier) => tier === ModelTier.Mid ? environment.midModel : environment.frontierModel;
	const cloudUsable = (tier: ModelTier) => tier <= policy.maxTier
		&& policy.cloudEnabled
		&& environment.hasApiKey
		&& environment.cloudState !== ConnectivityState.Offline
		&& !environment.excludedModels.has(cloudModelFor(tier).providerModelId);
	const usable = (tier: ModelTier) => tier === ModelTier.Local ? localUsable : cloudUsable(tier);

	const order: ModelTier[] = [];
	if (required === ModelTier.Local && environment.localState === ConnectivityState.Degraded && environment.localModel && usable(ModelTier.Mid)) {
		reasons.push('Ollama recently failed (degraded) → mid first, local as fallback');
		order.push(ModelTier.Mid, ModelTier.Local);
	} else {
		order.push(required);
		if (required < ModelTier.Frontier) {
			order.push(required + 1);
		}
	}
	for (let tier = required - 1; tier >= ModelTier.Local; tier--) {
		order.push(tier);
	}

	const candidates: RouteCandidate[] = [];
	for (const tier of order) {
		if (!usable(tier)) {
			continue;
		}
		if (tier !== ModelTier.Local) {
			candidates.push({ tier, model: cloudModelFor(tier) });
		} else if (localModel) {
			candidates.push({ tier, model: localModel });
		}
	}
	if (candidates.length > 0 && candidates[0].tier < required) {
		reasons.push(`${modelTierName(required)} unavailable (${describeCloud(required, policy, environment)}) → downgraded to ${modelTierName(candidates[0].tier)}`);
	}

	return {
		requiredTier: required,
		candidates,
		reasons,
		unavailable: candidates.length > 0 ? undefined : {
			local: localModel === undefined
				? (environment.localState === ConnectivityState.Offline ? 'ollamaOffline' : 'noLocalModel')
				: environment.localState === ConnectivityState.Offline ? 'ollamaOffline' : 'failed',
			cloud: !policy.cloudEnabled ? 'disabled'
				: !environment.hasApiKey ? 'noApiKey'
					: policy.maxTier === ModelTier.Local ? 'cappedByMaxTier'
						: environment.cloudState === ConnectivityState.Offline ? 'offline'
							: 'failed',
		},
	};
}

function describeCloud(tier: ModelTier, policy: RoutingPolicy, environment: RoutingEnvironment): string {
	if (tier > policy.maxTier) {
		return `capped by maxTier ${modelTierName(policy.maxTier)}`;
	}
	if (!policy.cloudEnabled) {
		return 'cloud disabled';
	}
	if (!environment.hasApiKey) {
		return 'no Claude API key';
	}
	if (environment.cloudState === ConnectivityState.Offline) {
		return 'offline';
	}
	return 'failed for this request';
}
