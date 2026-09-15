/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AnthropicProvider, ClaudeModelId } from './core/anthropicProvider';
import { ConnectivityMonitor, ConnectivityState } from './core/connectivity';
import { ProviderError } from './core/errors';
import { ModelService, ModelSettings } from './core/modelService';
import { DEFAULT_OLLAMA_ENDPOINT, OllamaProvider } from './core/ollamaProvider';
import { ModelTier, parseModelTier } from './core/types';
import { KETE_VENDOR, KeteLanguageModelProvider } from './languageModelProvider';

/** Where the Claude API key is kept. Secret storage only; never settings. */
const API_KEY_SECRET = 'kete.models.claudeApiKey';

export function activate(context: vscode.ExtensionContext): void {
	const log = vscode.window.createOutputChannel(vscode.l10n.t('Kete Models'), { log: true });
	context.subscriptions.push(log);

	// Secret storage is asynchronous; keep a cached copy so routing doesn't read
	// it on every request.
	let apiKey: Promise<string | undefined> = Promise.resolve(context.secrets.get(API_KEY_SECRET));
	const fetchFunction = (input: string, init: RequestInit) => fetch(input, init);
	const settings = () => readSettings();

	const ollama = new OllamaProvider({
		fetch: fetchFunction,
		getEndpoint: () => vscode.workspace.getConfiguration('kete.models').get<string>('ollama.endpoint', DEFAULT_OLLAMA_ENDPOINT),
		getMaxInputTokens: () => settings().localMaxInputTokens,
	});
	const anthropic = new AnthropicProvider({ fetch: fetchFunction, getApiKey: () => apiKey });

	let hasKey = false;
	const refreshHasKey = async () => { hasKey = !!(await apiKey); };
	void refreshHasKey();

	const localMonitor = new ConnectivityMonitor({ name: 'Ollama', probe: signal => ollama.probe(signal), isEnabled: () => true });
	const cloudMonitor = new ConnectivityMonitor({
		name: 'Claude API',
		probe: signal => anthropic.probe(signal),
		isEnabled: () => {
			const current = settings();
			return current.cloudEnabled && current.maxTier !== ModelTier.Local && hasKey;
		},
	});
	const service = new ModelService({
		local: ollama,
		cloud: anthropic,
		localMonitor,
		cloudMonitor,
		getSettings: settings,
		logger: { info: message => log.info(message), warn: message => log.warn(message) },
	});
	const provider = new KeteLanguageModelProvider(service);
	context.subscriptions.push(localMonitor, cloudMonitor, service, provider);
	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(KETE_VENDOR, provider));

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('kete.models')) {
			log.info('Kete model settings changed');
			service.settingsChanged();
		}
	}));

	context.subscriptions.push(context.secrets.onDidChange(async e => {
		if (e.key === API_KEY_SECRET) {
			apiKey = Promise.resolve(context.secrets.get(API_KEY_SECRET));
			await refreshHasKey();
			service.settingsChanged();
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('kete.models.setClaudeApiKey', async () => {
		const value = await vscode.window.showInputBox({
			title: vscode.l10n.t('Set Claude API Key'),
			prompt: vscode.l10n.t('The key is kept in the operating system\'s secret storage and is only sent to the Claude API.'),
			placeHolder: 'sk-ant-…',
			password: true,
			ignoreFocusOut: true,
			validateInput: input => /^\S+$/.test(input.trim()) ? undefined : vscode.l10n.t('Enter an API key without spaces.'),
		});
		const key = value?.trim();
		if (!key) {
			return;
		}
		const controller = new AbortController();
		let verified: boolean | undefined;
		try {
			verified = await anthropic.verifyApiKey(key, controller.signal);
		} catch (error) {
			log.warn(`Could not verify the Claude API key: ${error instanceof ProviderError ? error.message : String(error)}`);
		}
		if (verified === false) {
			vscode.window.showErrorMessage(vscode.l10n.t('Claude rejected this API key. It was not saved.'));
			return;
		}
		await context.secrets.store(API_KEY_SECRET, key);
		if (verified) {
			vscode.window.showInformationMessage(vscode.l10n.t('Claude API key saved.'));
		} else {
			vscode.window.showWarningMessage(vscode.l10n.t('Claude API key saved, but it could not be checked because the Claude API is unreachable.'));
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('kete.models.clearClaudeApiKey', async () => {
		await context.secrets.delete(API_KEY_SECRET);
		vscode.window.showInformationMessage(vscode.l10n.t('Claude API key removed. Kete Auto will use local models only.'));
	}));

	context.subscriptions.push(vscode.commands.registerCommand('kete.models.checkConnectivity', async () => {
		const [local, cloud] = await Promise.all([localMonitor.check(true), cloudMonitor.check(true)]);
		const cloudText = cloudMonitor.known ? stateLabel(cloud) : vscode.l10n.t('not in use');
		vscode.window.showInformationMessage(vscode.l10n.t('Ollama: {0}. Claude API: {1}.', stateLabel(local), cloudText));
	}));

	context.subscriptions.push(vscode.commands.registerCommand('kete.models.showLog', () => log.show()));
}

export function deactivate(): void { }

function readSettings(): ModelSettings {
	const configuration = vscode.workspace.getConfiguration('kete.models');
	const frontier = configuration.get<string>('routing.frontierModel', ClaudeModelId.Sonnet);
	return {
		ollamaModel: configuration.get<string>('ollama.model', ''),
		cloudEnabled: configuration.get<boolean>('cloud.enabled', true),
		maxTier: parseModelTier(configuration.get<string>('routing.maxTier')) ?? ModelTier.Frontier,
		frontierModelId: frontier === ClaudeModelId.Opus ? ClaudeModelId.Opus : ClaudeModelId.Sonnet,
		localMaxInputTokens: positiveNumber(configuration.get<number>('routing.localMaxInputTokens'), 8000),
		midMaxInputTokens: positiveNumber(configuration.get<number>('routing.midMaxInputTokens'), 50000),
	};
}

function positiveNumber(value: number | undefined, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 1000 ? Math.floor(value) : fallback;
}

function stateLabel(state: ConnectivityState): string {
	switch (state) {
		case ConnectivityState.Online: return vscode.l10n.t('online');
		case ConnectivityState.Degraded: return vscode.l10n.t('degraded');
		case ConnectivityState.Offline: return vscode.l10n.t('offline');
	}
}
