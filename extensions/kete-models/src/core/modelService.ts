/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConnectivityMonitor, ConnectivityState, Scheduler, systemScheduler } from './connectivity';
import { ProviderError, ProviderErrorKind } from './errors';
import { CloudOption, estimateTokens, RouteCandidate, RoutingDecision, RoutingHints, routeRequest, RoutingUnavailable } from './router';
import { ChatRequest, ChatUsage, Disposable, ModelDescriptor, ModelProvider, ModelTier, modelTierName, ModelVendor, ResponsePart } from './types';

/** The routed model's id and family, shared with the agent extension. */
export const KETE_AUTO_MODEL_ID = 'kete-auto';

/** How often the Ollama model list may be fetched again. */
const LOCAL_MODELS_TTL_MS = 30000;

/** At most this many models are tried for one routed request. */
const MAX_ROUTE_ATTEMPTS = 3;

/** The user's model settings. */
export interface ModelSettings {
	/** Preferred Ollama model; empty for the first one listed. */
	readonly ollamaModel: string;
	readonly cloudEnabled: boolean;
	readonly maxTier: ModelTier;
	/** Which cloud vendor Kete Auto tries first when both are set up. */
	readonly cloudVendor: ModelVendor;
	readonly localMaxInputTokens: number;
	readonly midMaxInputTokens: number;
}

/** Where the service writes its explanations. Never given prompt content or keys. */
export interface ModelLogger {
	info(message: string): void;
	warn(message: string): void;
}

/** A provider for cloud models that can tell whether it has credentials. */
export interface CloudModelProvider extends ModelProvider {
	hasApiKey(): Promise<boolean>;
}

/**
 * One cloud vendor: its provider, its connectivity and the models it offers.
 * Vendors are interchangeable to the router, which only compares tiers.
 */
export interface CloudProviderEntry {
	readonly vendor: ModelVendor;
	/** Names the vendor in logs and connectivity messages. */
	readonly label: string;
	readonly provider: CloudModelProvider;
	readonly monitor: ConnectivityMonitor;
	/** Every model this vendor offers, for the model picker. */
	readonly models: () => readonly ModelDescriptor[];
	/** The model this vendor serves a tier with, if any. */
	readonly modelForTier: (tier: ModelTier) => ModelDescriptor | undefined;
}

/** Dependencies of {@link ModelService}. */
export interface ModelServiceOptions {
	readonly local: ModelProvider;
	/** Cloud vendors, in their default order of preference. */
	readonly cloud: readonly CloudProviderEntry[];
	readonly localMonitor: ConnectivityMonitor;
	readonly getSettings: () => ModelSettings;
	readonly logger: ModelLogger;
	readonly scheduler?: Scheduler;
}

/**
 * Sends one routed attempt to a candidate model and streams its parts to the
 * caller, calling `markEmitted` before the first part. The VS Code adapter sends
 * it back through the language model API, so every attempt is its own governed,
 * audited request.
 */
export type RouteDispatch = (candidate: RouteCandidate, markEmitted: () => void) => Promise<void>;

/** Thrown when no model can serve a routed request. */
export class NoModelAvailableError extends Error {
	constructor(
		public readonly unavailable: RoutingUnavailable,
		public readonly lastError: ProviderError | undefined,
	) {
		super(`No Kete model is available (local: ${unavailable.local}, cloud: ${unavailable.cloud})${lastError ? `; last error: ${lastError.message}` : ''}`);
		this.name = 'NoModelAvailableError';
	}
}

/**
 * The id a model is registered under with the editor. Vendor-qualified, because
 * two vendors can serve the same model name — an OpenAI-compatible server and
 * Ollama both serve `llama3.2`, for instance.
 */
export function registeredModelId(model: ModelDescriptor): string {
	return `${model.vendor}/${model.providerModelId}`;
}

/**
 * Lists models, routes requests and runs them against providers, keeping the
 * connectivity monitors informed of every outcome.
 */
export class ModelService implements Disposable {
	private localModels: { readonly at: number; readonly models: readonly ModelDescriptor[] } | undefined;
	private readonly listeners = new Set<() => void>();
	private readonly disposables: Disposable[] = [];
	private readonly scheduler: Scheduler;

	constructor(private readonly options: ModelServiceOptions) {
		this.scheduler = options.scheduler ?? systemScheduler;
		const monitors: readonly (readonly [string, ConnectivityMonitor])[] = [
			['Ollama', options.localMonitor],
			...options.cloud.map(entry => [entry.label, entry.monitor] as const),
		];
		for (const [name, monitor] of monitors) {
			this.disposables.push(monitor.onDidChange(change => {
				options.logger.info(`${name} connectivity: ${change.previous} → ${change.current} (${change.reason})`);
				if (monitor === options.localMonitor) {
					this.localModels = undefined;
				}
				this.fireModelsChanged();
			}));
		}
	}

	/** Subscribes to changes in the set of available models. */
	onDidChangeModels(listener: () => void): Disposable {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	/** Forgets cached models and connectivity, after settings or a key changed. */
	settingsChanged(): void {
		this.localModels = undefined;
		this.options.localMonitor.reset();
		for (const entry of this.options.cloud) {
			entry.monitor.reset();
		}
		this.fireModelsChanged();
	}

	/** Local models Ollama serves, cached briefly. Empty while Ollama is offline. */
	async getLocalModels(signal: AbortSignal): Promise<readonly ModelDescriptor[]> {
		const now = this.scheduler.now();
		if (this.localModels && now - this.localModels.at < LOCAL_MODELS_TTL_MS) {
			return this.localModels.models;
		}
		const state = await this.options.localMonitor.ensureKnown();
		if (state === ConnectivityState.Offline) {
			return [];
		}
		try {
			const models = await this.options.local.listModels(signal);
			this.localModels = { at: this.scheduler.now(), models };
			this.options.localMonitor.reportSuccess();
			return models;
		} catch (error) {
			if (error instanceof ProviderError) {
				this.options.localMonitor.reportFailure(error);
				if (error.kind !== ProviderErrorKind.Cancelled) {
					this.options.logger.warn(`Could not list Ollama models: ${error.message}`);
				}
			}
			return [];
		}
	}

	/** Cloud models from every vendor that is enabled and has a key. */
	async getCloudModels(): Promise<readonly ModelDescriptor[]> {
		const settings = this.options.getSettings();
		if (!settings.cloudEnabled || settings.maxTier === ModelTier.Local) {
			return [];
		}
		const models: ModelDescriptor[] = [];
		for (const entry of this.orderedCloudEntries(settings.cloudVendor)) {
			if (await entry.provider.hasApiKey()) {
				models.push(...entry.models().filter(model => model.tier <= settings.maxTier));
			}
		}
		return models;
	}

	/** Cloud vendors with the preferred one first. */
	private orderedCloudEntries(preferred: ModelVendor): readonly CloudProviderEntry[] {
		return [...this.options.cloud].sort((a, b) => Number(b.vendor === preferred) - Number(a.vendor === preferred));
	}

	/**
	 * Picks the vendor that serves a tier: the preferred one when it has a key,
	 * a model for the tier and hasn't already failed for this request, otherwise
	 * the next. An offline vendor is only chosen when no other can serve the
	 * tier, so the router can report it as offline rather than silently skipping
	 * a vendor that is merely degraded.
	 */
	private async selectCloudModel(tier: ModelTier, excludedModels: ReadonlySet<string>, preferred: ModelVendor): Promise<CloudOption | undefined> {
		let offlineFallback: CloudOption | undefined;
		for (const entry of this.orderedCloudEntries(preferred)) {
			const model = entry.modelForTier(tier);
			if (!model || excludedModels.has(model.providerModelId) || !(await entry.provider.hasApiKey())) {
				continue;
			}
			const option: CloudOption = { model, state: entry.monitor.state };
			if (entry.monitor.state !== ConnectivityState.Offline) {
				return option;
			}
			offlineFallback ??= option;
		}
		return offlineFallback;
	}

	/** The vendor that serves a model, by the model's own vendor id. */
	private cloudEntryFor(model: ModelDescriptor): CloudProviderEntry | undefined {
		return this.options.cloud.find(entry => entry.vendor === model.vendor);
	}

	/** The local model Kete Auto uses: the configured one if Ollama has it, else the first listed. */
	async getLocalRoutingModel(signal: AbortSignal): Promise<ModelDescriptor | undefined> {
		const models = await this.getLocalModels(signal);
		const preferred = this.options.getSettings().ollamaModel.trim();
		if (!preferred) {
			return models[0];
		}
		const match = models.find(model => model.providerModelId === preferred || model.providerModelId === `${preferred}:latest`);
		if (!match && models.length > 0) {
			this.options.logger.warn(`Ollama has no model '${preferred}'; using ${models[0].providerModelId}`);
		}
		return match ?? models[0];
	}

	/**
	 * Decides where a request goes. Probes the Claude API first if it would be
	 * tried and nothing is known about it yet.
	 */
	async decide(request: ChatRequest, hints: RoutingHints, excludedModels: ReadonlySet<string>, signal: AbortSignal): Promise<RoutingDecision> {
		const settings = this.options.getSettings();
		const preferred = settings.cloudVendor;
		const routingRequest = {
			estimatedInputTokens: estimateTokens(request.messages, request.tools),
			usesTools: request.tools.length > 0,
			hasImages: request.messages.some(message => message.content.some(part => part.type === 'image')),
			hints,
		};
		const policy = {
			maxTier: settings.maxTier,
			cloudEnabled: settings.cloudEnabled,
			localMaxInputTokens: settings.localMaxInputTokens,
			midMaxInputTokens: settings.midMaxInputTokens,
		};
		const localModel = await this.getLocalRoutingModel(signal);
		const readCloud = async () => ({
			midModel: await this.selectCloudModel(ModelTier.Mid, excludedModels, preferred),
			frontierModel: await this.selectCloudModel(ModelTier.Frontier, excludedModels, preferred),
			hasApiKey: (await Promise.all(this.options.cloud.map(entry => entry.provider.hasApiKey()))).some(Boolean),
		});

		let cloud = await readCloud();
		const environment = () => ({
			localState: this.options.localMonitor.state,
			localModel,
			...cloud,
			excludedModels,
		});

		let decision = routeRequest(routingRequest, policy, environment());
		const chosen = decision.candidates[0];
		if (chosen && chosen.tier !== ModelTier.Local) {
			// Probe the vendor that would serve the request, if nothing is known
			// about it yet.
			const entry = this.cloudEntryFor(chosen.model);
			if (entry && !entry.monitor.known) {
				await entry.monitor.ensureKnown();
				cloud = await readCloud();
				decision = routeRequest(routingRequest, policy, environment());
			}
		}
		return decision;
	}

	/**
	 * Routes a request to the cheapest capable model and falls back when an
	 * attempt fails before producing output. Once output has reached the caller,
	 * a failure is final: a second model can't continue someone else's answer.
	 */
	async runRouted(request: ChatRequest, hints: RoutingHints, dispatch: RouteDispatch, signal: AbortSignal): Promise<RouteCandidate> {
		const excluded = new Set<string>();
		let lastError: ProviderError | undefined;
		for (let attempt = 0; attempt < MAX_ROUTE_ATTEMPTS; attempt++) {
			const decision = await this.decide(request, hints, excluded, signal);
			const candidate = decision.candidates[0];
			if (!candidate) {
				this.options.logger.warn(`Kete Auto: no model available (local: ${decision.unavailable?.local}, cloud: ${decision.unavailable?.cloud}); ${decision.reasons.join('; ')}`);
				throw new NoModelAvailableError(decision.unavailable ?? { local: 'failed', cloud: 'failed' }, lastError);
			}
			this.options.logger.info(`Kete Auto → ${registeredModelId(candidate.model)} [${modelTierName(candidate.tier)}] (required ${modelTierName(decision.requiredTier)}): ${decision.reasons.join('; ')}`);

			let emitted = false;
			try {
				await dispatch(candidate, () => emitted = true);
				return candidate;
			} catch (error) {
				if (emitted || signal.aborted || !(error instanceof ProviderError) || error.kind === ProviderErrorKind.Cancelled) {
					throw error;
				}
				lastError = error;
				excluded.add(candidate.model.providerModelId);
				this.options.logger.warn(`Kete Auto: ${registeredModelId(candidate.model)} failed before responding (${error.message}); trying the next model`);
			}
		}
		throw lastError ?? new Error('Kete Auto: no attempt was made');
	}

	/**
	 * Runs a request against one model and reports the outcome to that
	 * provider's connectivity monitor.
	 */
	async runModel(model: ModelDescriptor, request: ChatRequest, onPart: (part: ResponsePart) => void, signal: AbortSignal): Promise<ChatUsage> {
		const isLocal = model.tier === ModelTier.Local;
		const settings = this.options.getSettings();
		if (!isLocal && (!settings.cloudEnabled || model.tier > settings.maxTier)) {
			// A model picked before the settings changed must not bypass them.
			throw new ProviderError(ProviderErrorKind.BadRequest, `${model.displayName} is not allowed by the Kete model settings (cloud enabled: ${settings.cloudEnabled}, max tier: ${modelTierName(settings.maxTier)})`);
		}
		const entry = isLocal ? undefined : this.cloudEntryFor(model);
		if (!isLocal && !entry) {
			throw new ProviderError(ProviderErrorKind.NotFound, `No provider is configured for ${model.displayName}`);
		}
		const provider = entry ? entry.provider : this.options.local;
		const monitor = entry ? entry.monitor : this.options.localMonitor;
		const started = this.scheduler.now();
		try {
			const usage = await provider.chat(model, request, onPart, signal);
			monitor.reportSuccess();
			this.options.logger.info(`${registeredModelId(model)} finished in ${this.scheduler.now() - started} ms: ${describeUsage(usage)}`);
			return usage;
		} catch (error) {
			if (error instanceof ProviderError) {
				monitor.reportFailure(error);
			}
			throw error;
		}
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.listeners.clear();
	}

	private fireModelsChanged(): void {
		for (const listener of [...this.listeners]) {
			listener();
		}
	}
}

/** Summarizes token usage, including prompt cache hits, for the log. */
export function describeUsage(usage: ChatUsage): string {
	const parts = [
		`input ${usage.inputTokens ?? '?'}`,
		`output ${usage.outputTokens ?? '?'}`,
	];
	if (usage.cacheReadInputTokens !== undefined || usage.cacheCreationInputTokens !== undefined) {
		parts.push(`cache read ${usage.cacheReadInputTokens ?? 0}`, `cache write ${usage.cacheCreationInputTokens ?? 0}`);
	}
	if (usage.stopReason) {
		parts.push(`stop ${usage.stopReason}`);
	}
	return parts.join(', ');
}
