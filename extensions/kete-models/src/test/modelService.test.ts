/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { CLAUDE_MODELS, ClaudeModelId } from '../core/anthropicProvider';
import { ConnectivityMonitor, ConnectivityState } from '../core/connectivity';
import { ProviderError, ProviderErrorKind } from '../core/errors';
import { CloudModelProvider, CloudProviderEntry, ModelService, ModelSettings, NoModelAvailableError, registeredModelId } from '../core/modelService';
import { openAiModels } from '../core/openaiProvider';
import { ChatRequest, ModelDescriptor, ModelProvider, ModelTier, ModelVendor } from '../core/types';
import { FakeScheduler } from './fixtures';

const qwen: ModelDescriptor = { vendor: 'ollama', providerModelId: 'qwen2.5-coder:7b', displayName: 'qwen2.5-coder:7b', family: 'ollama/qwen2.5-coder:7b', tier: ModelTier.Local, maxInputTokens: 8000, maxOutputTokens: 4096, supportsToolCalling: true, supportsImages: false };

const defaultSettings: ModelSettings = { ollamaModel: '', cloudEnabled: true, maxTier: ModelTier.Frontier, cloudVendor: 'anthropic', localMaxInputTokens: 8000, midMaxInputTokens: 50000 };

const OPENAI_MODELS = openAiModels({ mid: 'gpt-5-mini', frontier: 'gpt-5-codex' });

const request: ChatRequest = { messages: [{ role: 'user', content: [{ type: 'text', text: 'Explain this function' }] }], tools: [], toolCallRequired: false };

interface Setup {
	readonly localModels?: readonly ModelDescriptor[];
	readonly localDown?: boolean;
	readonly hasKey?: boolean;
	/** Whether the OpenAI vendor is set up. Off unless a test asks for it. */
	readonly hasOpenAIKey?: boolean;
	readonly settings?: Partial<ModelSettings>;
	/** What each model does when run, by provider model id. */
	readonly behaviour?: Record<string, 'ok' | ProviderErrorKind>;
}

function setup(options: Setup = {}) {
	const scheduler = new FakeScheduler();
	const log: string[] = [];
	const behave = async (model: ModelDescriptor) => {
		const behaviour = options.behaviour?.[model.providerModelId] ?? 'ok';
		if (behaviour !== 'ok') {
			throw new ProviderError(behaviour, `${model.providerModelId} ${behaviour}`);
		}
		return { inputTokens: 10, outputTokens: 2 };
	};
	const local: ModelProvider = {
		id: 'ollama',
		listModels: async () => options.localModels ?? [qwen],
		chat: async model => behave(model),
		probe: async () => {
			if (options.localDown) {
				throw new ProviderError(ProviderErrorKind.Unreachable, 'connection refused');
			}
		},
	};
	const cloudProvider = (vendor: ModelVendor, hasKey: () => boolean, models: readonly ModelDescriptor[]): CloudModelProvider => ({
		id: vendor,
		hasApiKey: async () => hasKey(),
		listModels: async () => models,
		chat: async model => behave(model),
		probe: async () => { },
	});
	const cloudEntry = (vendor: ModelVendor, label: string, hasKey: () => boolean, models: readonly ModelDescriptor[]): CloudProviderEntry & { readonly monitor: ConnectivityMonitor } => {
		const provider = cloudProvider(vendor, hasKey, models);
		const monitor = new ConnectivityMonitor({ name: label, probe: provider.probe, isEnabled: () => true, scheduler });
		return { vendor, label, provider, monitor, models: () => models, modelForTier: tier => models.find(model => model.tier === tier) };
	};

	const anthropicEntry = cloudEntry('anthropic', 'Claude API', () => options.hasKey ?? true, CLAUDE_MODELS.filter(model => model.providerModelId !== ClaudeModelId.Opus));
	const openaiEntry = cloudEntry('openai', 'OpenAI API', () => options.hasOpenAIKey ?? false, OPENAI_MODELS);
	const localMonitor = new ConnectivityMonitor({ name: 'Ollama', probe: local.probe, isEnabled: () => true, scheduler });
	const service = new ModelService({
		local, cloud: [anthropicEntry, openaiEntry], localMonitor, scheduler,
		getSettings: () => ({ ...defaultSettings, ...options.settings }),
		logger: { info: message => log.push(message), warn: message => log.push(`WARN ${message}`) },
	});
	const dispose = () => {
		service.dispose();
		localMonitor.dispose();
		anthropicEntry.monitor.dispose();
		openaiEntry.monitor.dispose();
	};
	return { service, localMonitor, cloudMonitor: anthropicEntry.monitor, openaiMonitor: openaiEntry.monitor, log, dispose };
}

/** Runs a routed request whose attempts call `runModel` directly, as the adapter's nested request would. */
async function runRouted(context: ReturnType<typeof setup>, emitBeforeFailing = false) {
	const attempts: string[] = [];
	try {
		const chosen = await context.service.runRouted(request, {}, async (candidate, markEmitted) => {
			attempts.push(registeredModelId(candidate.model));
			if (emitBeforeFailing) {
				markEmitted();
			}
			await context.service.runModel(candidate.model, request, () => markEmitted(), new AbortController().signal);
		}, new AbortController().signal);
		return { attempts, chosen: registeredModelId(chosen.model) };
	} catch (error) {
		return { attempts, error: error instanceof NoModelAvailableError ? error.unavailable : error instanceof ProviderError ? error.kind : String(error) };
	}
}

suite('ModelService', () => {

	test('routes routine work to the local model and records success', async () => {
		const context = setup();
		const result = await runRouted(context);
		const states = { local: context.localMonitor.state, cloud: context.cloudMonitor.known };
		context.dispose();
		assert.deepStrictEqual({ result, states }, {
			result: { attempts: ['ollama/qwen2.5-coder:7b'], chosen: 'ollama/qwen2.5-coder:7b' },
			states: { local: ConnectivityState.Online, cloud: false },
		});
	});

	test('falls back to the next model when an attempt fails before any output', async () => {
		const context = setup({ behaviour: { 'qwen2.5-coder:7b': ProviderErrorKind.Unreachable } });
		const result = await runRouted(context);
		const localState = context.localMonitor.state;
		context.dispose();
		assert.deepStrictEqual({ result, localState }, {
			result: { attempts: ['ollama/qwen2.5-coder:7b', 'anthropic/claude-haiku-4-5-20251001'], chosen: 'anthropic/claude-haiku-4-5-20251001' },
			localState: ConnectivityState.Offline,
		});
	});

	test('does not fall back once output has been sent, or when the failure was not a model failure', async () => {
		const failing = setup({ behaviour: { 'qwen2.5-coder:7b': ProviderErrorKind.Unhealthy } });
		const afterOutput = await runRouted(failing, true);
		failing.dispose();

		const refused = setup();
		const governance = await refused.service.runRouted(request, {}, async () => {
			throw new Error('Kete governance did not allow the request');
		}, new AbortController().signal).then(() => 'resolved', (error: Error) => error.message);
		refused.dispose();

		assert.deepStrictEqual({ afterOutput, governance }, {
			afterOutput: { attempts: ['ollama/qwen2.5-coder:7b'], error: ProviderErrorKind.Unhealthy },
			governance: 'Kete governance did not allow the request',
		});
	});

	test('reports an actionable reason when nothing is available', async () => {
		const offline = setup({ localDown: true, hasKey: false });
		const noKey = await runRouted(offline);
		offline.dispose();

		const allFail = setup({ behaviour: { 'qwen2.5-coder:7b': ProviderErrorKind.Unhealthy, [ClaudeModelId.Haiku]: ProviderErrorKind.Auth }, settings: { maxTier: ModelTier.Mid } });
		const exhausted = await runRouted(allFail);
		allFail.dispose();

		assert.deepStrictEqual({ noKey, exhausted }, {
			noKey: { attempts: [], error: { local: 'ollamaOffline', cloud: 'noApiKey' } },
			exhausted: { attempts: ['ollama/qwen2.5-coder:7b', 'anthropic/claude-haiku-4-5-20251001'], error: { local: 'failed', cloud: 'failed' } },
		});
	});

	test('prefers the configured cloud vendor and falls back to the other', async () => {
		const bothVendors = { hasOpenAIKey: true, localModels: [] as readonly ModelDescriptor[], localDown: true };
		const claudeFirst = setup(bothVendors);
		const toClaude = await runRouted(claudeFirst);
		claudeFirst.dispose();

		const openaiFirst = setup({ ...bothVendors, settings: { cloudVendor: 'openai' } });
		const toOpenAI = await runRouted(openaiFirst);
		openaiFirst.dispose();

		const claudeFails = setup({ ...bothVendors, behaviour: { [ClaudeModelId.Haiku]: ProviderErrorKind.Unhealthy } });
		const acrossVendors = await runRouted(claudeFails);
		claudeFails.dispose();

		const onlyOpenAI = setup({ ...bothVendors, hasKey: false });
		const withoutClaude = await runRouted(onlyOpenAI);
		onlyOpenAI.dispose();

		assert.deepStrictEqual({ toClaude, toOpenAI, acrossVendors, withoutClaude }, {
			toClaude: { attempts: ['anthropic/claude-haiku-4-5-20251001'], chosen: 'anthropic/claude-haiku-4-5-20251001' },
			toOpenAI: { attempts: ['openai/gpt-5-mini'], chosen: 'openai/gpt-5-mini' },
			acrossVendors: { attempts: ['anthropic/claude-haiku-4-5-20251001', 'openai/gpt-5-mini'], chosen: 'openai/gpt-5-mini' },
			withoutClaude: { attempts: ['openai/gpt-5-mini'], chosen: 'openai/gpt-5-mini' },
		});
	});

	test('lists models within the settings and refuses a cloud model the settings no longer allow', async () => {
		const context = setup({ settings: { maxTier: ModelTier.Mid, ollamaModel: 'llama3.2' }, localModels: [qwen, { ...qwen, providerModelId: 'llama3.2:latest' }] });
		const signal = new AbortController().signal;
		const cloud = (await context.service.getCloudModels()).map(model => model.providerModelId);
		const localRouting = (await context.service.getLocalRoutingModel(signal))?.providerModelId;
		const sonnet = CLAUDE_MODELS.find(model => model.providerModelId === ClaudeModelId.Sonnet)!;
		const refused = await context.service.runModel(sonnet, request, () => { }, signal).then(() => 'resolved', (error: ProviderError) => error.kind);
		context.dispose();

		const disabled = setup({ settings: { cloudEnabled: false } });
		const disabledCloud = (await disabled.service.getCloudModels()).length;
		disabled.dispose();

		const bothVendors = setup({ hasOpenAIKey: true });
		const listed = (await bothVendors.service.getCloudModels()).map(registeredModelId);
		bothVendors.dispose();

		assert.deepStrictEqual({ cloud, localRouting, refused, disabledCloud, listed }, {
			listed: ['anthropic/claude-haiku-4-5-20251001', 'anthropic/claude-sonnet-5', 'openai/gpt-5-mini', 'openai/gpt-5-codex'],
			cloud: [ClaudeModelId.Haiku],
			localRouting: 'llama3.2:latest',
			refused: ProviderErrorKind.BadRequest,
			disabledCloud: 0,
		});
	});
});
