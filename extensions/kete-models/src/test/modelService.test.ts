/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { CLAUDE_MODELS, ClaudeModelId } from '../core/anthropicProvider';
import { ConnectivityMonitor, ConnectivityState } from '../core/connectivity';
import { ProviderError, ProviderErrorKind } from '../core/errors';
import { CloudModelProvider, ModelService, ModelSettings, NoModelAvailableError, registeredModelId } from '../core/modelService';
import { ChatRequest, ModelDescriptor, ModelProvider, ModelTier } from '../core/types';
import { FakeScheduler } from './fixtures';

const qwen: ModelDescriptor = { providerModelId: 'qwen2.5-coder:7b', displayName: 'qwen2.5-coder:7b', family: 'ollama/qwen2.5-coder:7b', tier: ModelTier.Local, maxInputTokens: 8000, maxOutputTokens: 4096, supportsToolCalling: true, supportsImages: false };

const defaultSettings: ModelSettings = { ollamaModel: '', cloudEnabled: true, maxTier: ModelTier.Frontier, frontierModelId: ClaudeModelId.Sonnet, localMaxInputTokens: 8000, midMaxInputTokens: 50000 };

const request: ChatRequest = { messages: [{ role: 'user', content: [{ type: 'text', text: 'Explain this function' }] }], tools: [], toolCallRequired: false };

interface Setup {
	readonly localModels?: readonly ModelDescriptor[];
	readonly localDown?: boolean;
	readonly hasKey?: boolean;
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
	const cloud: CloudModelProvider = {
		id: 'anthropic',
		hasApiKey: async () => options.hasKey ?? true,
		listModels: async () => CLAUDE_MODELS,
		chat: async model => behave(model),
		probe: async () => { },
	};
	const localMonitor = new ConnectivityMonitor({ name: 'Ollama', probe: local.probe, isEnabled: () => true, scheduler });
	const cloudMonitor = new ConnectivityMonitor({ name: 'Claude API', probe: cloud.probe, isEnabled: () => true, scheduler });
	const service = new ModelService({
		local, cloud, localMonitor, cloudMonitor, scheduler,
		getSettings: () => ({ ...defaultSettings, ...options.settings }),
		logger: { info: message => log.push(message), warn: message => log.push(`WARN ${message}`) },
	});
	const dispose = () => {
		service.dispose();
		localMonitor.dispose();
		cloudMonitor.dispose();
	};
	return { service, localMonitor, cloudMonitor, log, dispose };
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
			result: { attempts: ['ollama/qwen2.5-coder:7b', 'claude-haiku-4-5-20251001'], chosen: 'claude-haiku-4-5-20251001' },
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
			exhausted: { attempts: ['ollama/qwen2.5-coder:7b', 'claude-haiku-4-5-20251001'], error: { local: 'failed', cloud: 'failed' } },
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

		assert.deepStrictEqual({ cloud, localRouting, refused, disabledCloud }, {
			cloud: [ClaudeModelId.Haiku],
			localRouting: 'llama3.2:latest',
			refused: ProviderErrorKind.BadRequest,
			disabledCloud: 0,
		});
	});
});
