/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_MODELS, ClaudeModelId } from './anthropicProvider';
import { ConnectivityMonitor, ConnectivityState, Scheduler, systemScheduler } from './connectivity';
import { ProviderError, ProviderErrorKind } from './errors';
import { estimateTokens, RouteCandidate, RoutingDecision, RoutingHints, routeRequest, RoutingUnavailable } from './router';
import { ChatRequest, ChatUsage, Disposable, ModelDescriptor, ModelProvider, ModelTier, modelTierName, ResponsePart } from './types';

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
	readonly frontierModelId: string;
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

/** Dependencies of {@link ModelService}. */
export interface ModelServiceOptions {
	readonly local: ModelProvider;
	readonly cloud: CloudModelProvider;
	readonly localMonitor: ConnectivityMonitor;
	readonly cloudMonitor: ConnectivityMonitor;
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

/** The id a model is registered under with the editor. */
export function registeredModelId(model: ModelDescriptor): string {
	return model.tier === ModelTier.Local ? `ollama/${model.providerModelId}` : model.providerModelId;
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
		for (const [name, monitor] of [['Ollama', options.localMonitor], ['Claude API', options.cloudMonitor]] as const) {
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

	/** Forgets cached models and connectivity, after settings or the key changed. */
	settingsChanged(): void {
		this.localModels = undefined;
		this.options.localMonitor.reset();
		this.options.cloudMonitor.reset();
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

	/** Claude models, when cloud use is enabled and a key is set. */
	async getCloudModels(): Promise<readonly ModelDescriptor[]> {
		const settings = this.options.getSettings();
		if (!settings.cloudEnabled || settings.maxTier === ModelTier.Local || !(await this.options.cloud.hasApiKey())) {
			return [];
		}
		return CLAUDE_MODELS.filter(model => model.tier <= settings.maxTier);
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
		const frontierModel = CLAUDE_MODELS.find(model => model.providerModelId === settings.frontierModelId && model.tier === ModelTier.Frontier)
			?? CLAUDE_MODELS.find(model => model.providerModelId === ClaudeModelId.Sonnet)!;
		const midModel = CLAUDE_MODELS.find(model => model.providerModelId === ClaudeModelId.Haiku)!;
		const localModel = await this.getLocalRoutingModel(signal);
		const hasApiKey = await this.options.cloud.hasApiKey();

		const environment = () => ({
			localState: this.options.localMonitor.state,
			localModel,
			cloudState: this.options.cloudMonitor.state,
			hasApiKey,
			midModel,
			frontierModel,
			excludedModels,
		});

		let decision = routeRequest(routingRequest, policy, environment());
		if (decision.candidates[0] && decision.candidates[0].tier !== ModelTier.Local && !this.options.cloudMonitor.known) {
			await this.options.cloudMonitor.ensureKnown();
			decision = routeRequest(routingRequest, policy, environment());
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
		const provider = isLocal ? this.options.local : this.options.cloud;
		const monitor = isLocal ? this.options.localMonitor : this.options.cloudMonitor;
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
