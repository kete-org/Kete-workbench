/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ModelRoutingHints, ModelTier, MODEL_TIERS } from './projectRules';
import { FolderProjectRules } from './projectRulesLoader';

/**
 * The model the agent asks for first: Kete's tiered router, which picks a local,
 * mid or frontier model per request. Shared contract with the model provider
 * extension (`kete-models`).
 */
export const KETE_AUTO_MODEL_SELECTOR = { vendor: 'kete', family: 'kete-auto' } as const;

/**
 * The model option key under which routing hints are passed to Kete's router
 * (`kete-models` reads `modelOptions.kete`), as
 * `{ [KETE_ROUTING_MODEL_OPTION]: RouterHints }`. Other vendors don't receive it.
 */
export const KETE_ROUTING_MODEL_OPTION = 'kete';

/**
 * The hints the router accepts from a project: only a cap. The router can only
 * lower its tier for a `maxTier` hint, never raise it.
 */
export interface RouterHints {
	readonly maxTier: ModelTier;
}

/**
 * Turns a project's routing hints into router hints. Only `maxTier` is
 * forwarded: a repository's rules file may keep work on cheaper models, but it
 * must not make the person spend more on cloud models than the router would
 * choose, so `preferredTier` is not sent. Returns `undefined` when there is no cap.
 */
export function toRouterHints(hints: ModelRoutingHints | undefined): RouterHints | undefined {
	return hints?.maxTier ? { maxTier: hints.maxTier } : undefined;
}

/**
 * Combines the routing hints of several workspace folders. The lowest `maxTier`
 * wins, so no folder's cap is exceeded, and the cheapest `preferredTier` wins,
 * clamped to that cap. Returns `undefined` when no folder has hints.
 */
export function mergeRoutingHints(folders: readonly FolderProjectRules[]): ModelRoutingHints | undefined {
	const lowest = (tiers: (ModelTier | undefined)[]): ModelTier | undefined => {
		const indexes = tiers.filter((tier): tier is ModelTier => !!tier).map(tier => MODEL_TIERS.indexOf(tier));
		return indexes.length ? MODEL_TIERS[Math.min(...indexes)] : undefined;
	};

	const hints = folders.map(folder => folder.rules?.modelRouting);
	const maxTier = lowest(hints.map(hint => hint?.maxTier));
	const preferred = lowest(hints.map(hint => hint?.preferredTier));
	const preferredTier = preferred && maxTier ? lowest([preferred, maxTier]) : preferred;
	if (!maxTier && !preferredTier) {
		return undefined;
	}
	return { ...(preferredTier ? { preferredTier } : {}), ...(maxTier ? { maxTier } : {}) };
}

/**
 * Where the selected model came from.
 *
 * - `keteAuto`: Kete's tiered router ({@link KETE_AUTO_MODEL_SELECTOR}).
 * - `request`: the model selected for the chat request.
 * - `anyAvailable`: the first model any provider offers.
 */
export type ModelSource = 'keteAuto' | 'request' | 'anyAvailable';

/**
 * A model selector, structurally compatible with `vscode.LanguageModelChatSelector`.
 */
export interface ModelSelector {
	readonly vendor?: string;
	readonly family?: string;
}

/**
 * The model lookups {@link selectAgentModel} needs.
 */
export interface ModelCatalog<M> {
	select(selector?: ModelSelector): PromiseLike<readonly M[]>;
}

/**
 * Picks the model for a request: Kete's router if it is registered, otherwise
 * the chat request's model, otherwise any available model. Returns `undefined`
 * when there is no model at all, so the client can say what to do about it.
 */
export async function selectAgentModel<M>(catalog: ModelCatalog<M>, requestModel: M | undefined): Promise<{ readonly model: M; readonly source: ModelSource } | undefined> {
	const [keteAuto] = await catalog.select(KETE_AUTO_MODEL_SELECTOR);
	if (keteAuto) {
		return { model: keteAuto, source: 'keteAuto' };
	}
	if (requestModel) {
		return { model: requestModel, source: 'request' };
	}
	const [anyModel] = await catalog.select();
	return anyModel ? { model: anyModel, source: 'anyAvailable' } : undefined;
}
