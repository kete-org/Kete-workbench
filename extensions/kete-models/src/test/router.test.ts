/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { CLAUDE_MODELS, ClaudeModelId } from '../core/anthropicProvider';
import { ConnectivityState } from '../core/connectivity';
import { CloudOption, estimateTokens, parseRoutingHints, RoutingEnvironment, RoutingPolicy, routeRequest, RoutingRequest } from '../core/router';
import { ModelDescriptor, ModelTier } from '../core/types';

const qwen: ModelDescriptor = { vendor: 'ollama', providerModelId: 'qwen2.5-coder:7b', displayName: 'qwen2.5-coder:7b', family: 'ollama/qwen2.5-coder:7b', tier: ModelTier.Local, maxInputTokens: 8000, maxOutputTokens: 4096, supportsToolCalling: true, supportsImages: false };
const noTools: ModelDescriptor = { ...qwen, providerModelId: 'phi3:mini', supportsToolCalling: false };
const haiku = CLAUDE_MODELS.find(model => model.providerModelId === ClaudeModelId.Haiku)!;
const sonnet = CLAUDE_MODELS.find(model => model.providerModelId === ClaudeModelId.Sonnet)!;

const online = (model: ModelDescriptor): CloudOption => ({ model, state: ConnectivityState.Online });

const policy: RoutingPolicy = { maxTier: ModelTier.Frontier, cloudEnabled: true, localMaxInputTokens: 8000, midMaxInputTokens: 50000 };
const environment: RoutingEnvironment = {
	localState: ConnectivityState.Online,
	localModel: qwen,
	hasApiKey: true,
	midModel: online(haiku),
	frontierModel: online(sonnet),
	excludedModels: new Set(),
};
const offline = (model: ModelDescriptor): CloudOption => ({ model, state: ConnectivityState.Offline });

const request: RoutingRequest = { estimatedInputTokens: 1200, usesTools: true, hasImages: false, hints: {} };

/** Summarizes a decision as `required: candidate ids | reasons`. */
function route(overrides: { request?: Partial<RoutingRequest>; policy?: Partial<RoutingPolicy>; environment?: Partial<RoutingEnvironment> }) {
	const decision = routeRequest({ ...request, ...overrides.request }, { ...policy, ...overrides.policy }, { ...environment, ...overrides.environment });
	return {
		required: ModelTier[decision.requiredTier],
		candidates: decision.candidates.map(c => c.model.providerModelId),
		reasons: decision.reasons,
		...(decision.unavailable ? { unavailable: decision.unavailable } : {}),
	};
}

suite('routeRequest', () => {

	test('escalates by explicit criteria', () => {
		assert.deepStrictEqual({
			routine: route({}),
			large: route({ request: { estimatedInputTokens: 9000 } }),
			veryLarge: route({ request: { estimatedInputTokens: 60000 } }),
			toolsUnsupported: route({ environment: { localModel: noTools } }),
			images: route({ request: { hasImages: true } }),
			plan: route({ request: { hints: { mode: 'plan' } } }),
			debug: route({ request: { hints: { mode: 'debug' } } }),
			hint: route({ request: { hints: { minTier: ModelTier.Mid, mode: 'ask' } } }),
		}, {
			routine: { required: 'Local', candidates: ['qwen2.5-coder:7b', 'claude-haiku-4-5-20251001'], reasons: ['routine request → local'] },
			large: { required: 'Mid', candidates: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'qwen2.5-coder:7b'], reasons: ['~9000 tokens exceeds the local limit (8000) → mid'] },
			veryLarge: { required: 'Frontier', candidates: ['claude-sonnet-5', 'claude-haiku-4-5-20251001', 'qwen2.5-coder:7b'], reasons: ['~60000 tokens exceeds midMaxInputTokens (50000) → frontier'] },
			toolsUnsupported: { required: 'Mid', candidates: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'phi3:mini'], reasons: ['tools requested and phi3:mini doesn\'t support tool calling → mid'] },
			images: { required: 'Mid', candidates: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'qwen2.5-coder:7b'], reasons: ['images attached and qwen2.5-coder:7b doesn\'t support images → mid'] },
			plan: { required: 'Frontier', candidates: ['claude-sonnet-5', 'claude-haiku-4-5-20251001', 'qwen2.5-coder:7b'], reasons: ['mode \'plan\' → frontier'] },
			debug: { required: 'Mid', candidates: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'qwen2.5-coder:7b'], reasons: ['mode \'debug\' → mid'] },
			hint: { required: 'Mid', candidates: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'qwen2.5-coder:7b'], reasons: ['minTier hint → mid'] },
		});
	});

	test('falls back gracefully and explains downgrades', () => {
		assert.deepStrictEqual({
			cloudOffline: route({ request: { hints: { mode: 'plan' } }, environment: { midModel: offline(haiku), frontierModel: offline(sonnet) } }),
			noKey: route({ request: { estimatedInputTokens: 9000 }, environment: { hasApiKey: false, midModel: undefined, frontierModel: undefined } }),
			cappedAtMid: route({ request: { hints: { mode: 'plan' } }, policy: { maxTier: ModelTier.Mid } }),
			localOffline: route({ environment: { localState: ConnectivityState.Offline } }),
			localDegraded: route({ environment: { localState: ConnectivityState.Degraded } }),
			localFailedThisRequest: route({ environment: { excludedModels: new Set(['qwen2.5-coder:7b']) } }),
			cloudDegradedStillTried: route({ request: { estimatedInputTokens: 9000 }, environment: { midModel: { model: haiku, state: ConnectivityState.Degraded } } }),
		}, {
			cloudOffline: { required: 'Frontier', candidates: ['qwen2.5-coder:7b'], reasons: ['mode \'plan\' → frontier', 'frontier unavailable (offline) → downgraded to local'] },
			noKey: { required: 'Mid', candidates: ['qwen2.5-coder:7b'], reasons: ['~9000 tokens exceeds the local limit (8000) → mid', 'mid unavailable (no cloud API key) → downgraded to local'] },
			cappedAtMid: { required: 'Frontier', candidates: ['claude-haiku-4-5-20251001', 'qwen2.5-coder:7b'], reasons: ['mode \'plan\' → frontier', 'frontier unavailable (capped by maxTier mid) → downgraded to mid'] },
			localOffline: { required: 'Local', candidates: ['claude-haiku-4-5-20251001'], reasons: ['routine request → local'] },
			localDegraded: { required: 'Local', candidates: ['claude-haiku-4-5-20251001', 'qwen2.5-coder:7b'], reasons: ['routine request → local', 'Ollama recently failed (degraded) → mid first, local as fallback'] },
			localFailedThisRequest: { required: 'Local', candidates: ['claude-haiku-4-5-20251001'], reasons: ['routine request → local'] },
			cloudDegradedStillTried: { required: 'Mid', candidates: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'qwen2.5-coder:7b'], reasons: ['~9000 tokens exceeds the local limit (8000) → mid'] },
		});
	});

	test('hints never exceed the user\'s cloud settings', () => {
		assert.deepStrictEqual({
			cloudDisabled: route({ request: { hints: { minTier: ModelTier.Frontier } }, policy: { cloudEnabled: false } }).candidates,
			localOnly: route({ request: { hints: { mode: 'plan' } }, policy: { maxTier: ModelTier.Local } }).candidates,
		}, {
			cloudDisabled: ['qwen2.5-coder:7b'],
			localOnly: ['qwen2.5-coder:7b'],
		});
	});

	test('a maxTier hint can lower the user\'s cap but never raise it', () => {
		const largePrompt = { estimatedInputTokens: 60000 };
		assert.deepStrictEqual({
			lowered: route({ request: { ...largePrompt, hints: { maxTier: ModelTier.Local } } }),
			notRaised: route({ request: { ...largePrompt, hints: { maxTier: ModelTier.Frontier } }, policy: { maxTier: ModelTier.Mid } }).candidates,
		}, {
			lowered: {
				required: 'Frontier',
				candidates: ['qwen2.5-coder:7b'],
				reasons: [
					'~60000 tokens exceeds midMaxInputTokens (50000) → frontier',
					'request capped at local',
					'frontier unavailable (capped by maxTier local) → downgraded to local',
				],
			},
			notRaised: ['claude-haiku-4-5-20251001', 'qwen2.5-coder:7b'],
		});
	});

	test('reports why nothing is available', () => {
		assert.deepStrictEqual({
			offlineNoKey: route({ environment: { localState: ConnectivityState.Offline, localModel: undefined, hasApiKey: false, midModel: undefined, frontierModel: undefined } }).unavailable,
			noModelsCloudOffline: route({ environment: { localModel: undefined, midModel: offline(haiku), frontierModel: offline(sonnet) } }).unavailable,
			disabled: route({ environment: { localModel: undefined }, policy: { cloudEnabled: false } }).unavailable,
			localOnlyAndFailed: route({ environment: { excludedModels: new Set(['qwen2.5-coder:7b']) }, policy: { maxTier: ModelTier.Local } }).unavailable,
		}, {
			offlineNoKey: { local: 'ollamaOffline', cloud: 'noApiKey' },
			noModelsCloudOffline: { local: 'noLocalModel', cloud: 'offline' },
			disabled: { local: 'noLocalModel', cloud: 'disabled' },
			localOnlyAndFailed: { local: 'failed', cloud: 'cappedByMaxTier' },
		});
	});

	test('each tier can come from a different vendor', () => {
		const gpt: ModelDescriptor = { vendor: 'openai', providerModelId: 'gpt-5-codex', displayName: 'gpt-5-codex', family: 'openai/gpt-5-codex', tier: ModelTier.Frontier, maxInputTokens: 128000, maxOutputTokens: 64000, supportsToolCalling: true, supportsImages: true };
		assert.deepStrictEqual({
			mixed: route({ request: { hints: { mode: 'plan' } }, environment: { frontierModel: online(gpt) } }).candidates,
			claudeFrontierOffline: route({ request: { hints: { mode: 'plan' } }, environment: { frontierModel: offline(gpt) } }).candidates,
			noMidConfigured: route({ request: { estimatedInputTokens: 9000 }, environment: { midModel: undefined } }).candidates,
		}, {
			mixed: ['gpt-5-codex', 'claude-haiku-4-5-20251001', 'qwen2.5-coder:7b'],
			claudeFrontierOffline: ['claude-haiku-4-5-20251001', 'qwen2.5-coder:7b'],
			noMidConfigured: ['claude-sonnet-5', 'qwen2.5-coder:7b'],
		});
	});

	test('parses hints and estimates tokens', () => {
		assert.deepStrictEqual({
			hints: parseRoutingHints({ kete: { minTier: 'frontier', maxTier: 'mid', mode: 'debug' } }),
			malformed: parseRoutingHints({ kete: { minTier: 'max', mode: 'orchestrator' } }),
			missing: parseRoutingHints(undefined),
			tokens: estimateTokens([
				{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(400) }, { type: 'image', mimeType: 'image/png', data: new Uint8Array() }] },
			], [{ name: 'tool', description: 'd' }]),
		}, {
			hints: { minTier: ModelTier.Frontier, maxTier: ModelTier.Mid, mode: 'debug' },
			malformed: {},
			missing: {},
			tokens: Math.ceil((400 + 4 + 1 + 2) / 4) + 1500,
		});
	});
});
