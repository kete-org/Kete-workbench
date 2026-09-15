/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AnthropicProvider, CLAUDE_MODELS, ClaudeModelId } from './core/anthropicProvider';
import { ConnectivityMonitor, ConnectivityState } from './core/connectivity';
import { ProviderError } from './core/errors';
import { CloudProviderEntry, ModelService, ModelSettings } from './core/modelService';
import { DEFAULT_OLLAMA_ENDPOINT, OllamaProvider } from './core/ollamaProvider';
import { DEFAULT_OPENAI_BASE_URL, DEFAULT_OPENAI_FRONTIER_MODEL, DEFAULT_OPENAI_MID_MODEL, openAiModels, OpenAIProvider } from './core/openaiProvider';
import { ModelDescriptor, ModelTier, ModelVendor, parseModelTier } from './core/types';
import { KETE_VENDOR, KeteLanguageModelProvider } from './languageModelProvider';

/** Where the API keys are kept. Secret storage only; never settings. */
const CLAUDE_API_KEY_SECRET = 'kete.models.claudeApiKey';
const OPENAI_API_KEY_SECRET = 'kete.models.openaiApiKey';

export function activate(context: vscode.ExtensionContext): void {
	const log = vscode.window.createOutputChannel(vscode.l10n.t('Kete Models'), { log: true });
	context.subscriptions.push(log);

	// Secret storage is asynchronous; keep a cached copy so routing doesn't read
	// it on every request.
	let claudeApiKey: Promise<string | undefined> = Promise.resolve(context.secrets.get(CLAUDE_API_KEY_SECRET));
	let openaiApiKey: Promise<string | undefined> = Promise.resolve(context.secrets.get(OPENAI_API_KEY_SECRET));
	const fetchFunction = (input: string, init: RequestInit) => fetch(input, init);
	const settings = () => readSettings();
	const configuration = () => vscode.workspace.getConfiguration('kete.models');

	const ollama = new OllamaProvider({
		fetch: fetchFunction,
		getEndpoint: () => configuration().get<string>('ollama.endpoint', DEFAULT_OLLAMA_ENDPOINT),
		getMaxInputTokens: () => settings().localMaxInputTokens,
	});
	const anthropic = new AnthropicProvider({ fetch: fetchFunction, getApiKey: () => claudeApiKey });
	const openai = new OpenAIProvider({
		fetch: fetchFunction,
		getApiKey: () => openaiApiKey,
		getBaseUrl: () => configuration().get<string>('openai.endpoint', DEFAULT_OPENAI_BASE_URL),
		getModelIds: () => ({
			mid: configuration().get<string>('openai.midModel', DEFAULT_OPENAI_MID_MODEL),
			frontier: configuration().get<string>('openai.frontierModel', DEFAULT_OPENAI_FRONTIER_MODEL),
		}),
	});

	let hasClaudeKey = false;
	let hasOpenAIKey = false;
	const refreshHasKeys = async () => {
		[hasClaudeKey, hasOpenAIKey] = [!!(await claudeApiKey), !!(await openaiApiKey)];
	};
	void refreshHasKeys();

	const cloudInUse = (hasKey: () => boolean) => () => {
		const current = settings();
		return current.cloudEnabled && current.maxTier !== ModelTier.Local && hasKey();
	};

	const localMonitor = new ConnectivityMonitor({ name: 'Ollama', probe: signal => ollama.probe(signal), isEnabled: () => true });
	const claudeMonitor = new ConnectivityMonitor({ name: 'Claude API', probe: signal => anthropic.probe(signal), isEnabled: cloudInUse(() => hasClaudeKey) });
	const openaiMonitor = new ConnectivityMonitor({ name: 'OpenAI API', probe: signal => openai.probe(signal), isEnabled: cloudInUse(() => hasOpenAIKey) });

	const claudeEntry: CloudProviderEntry = {
		vendor: 'anthropic',
		label: 'Claude API',
		provider: anthropic,
		monitor: claudeMonitor,
		models: () => CLAUDE_MODELS,
		modelForTier: tier => tier === ModelTier.Mid
			? CLAUDE_MODELS.find(model => model.providerModelId === ClaudeModelId.Haiku)
			: claudeFrontierModel(),
	};
	const openaiEntry: CloudProviderEntry = {
		vendor: 'openai',
		label: 'OpenAI API',
		provider: openai,
		monitor: openaiMonitor,
		models: () => openAiModels({
			mid: configuration().get<string>('openai.midModel', DEFAULT_OPENAI_MID_MODEL),
			frontier: configuration().get<string>('openai.frontierModel', DEFAULT_OPENAI_FRONTIER_MODEL),
		}),
		modelForTier: tier => openaiEntry.models().find(model => model.tier === tier),
	};

	const service = new ModelService({
		local: ollama,
		cloud: [claudeEntry, openaiEntry],
		localMonitor,
		getSettings: settings,
		logger: { info: message => log.info(message), warn: message => log.warn(message) },
	});
	const provider = new KeteLanguageModelProvider(service);
	context.subscriptions.push(localMonitor, claudeMonitor, openaiMonitor, service, provider);
	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(KETE_VENDOR, provider));

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('kete.models')) {
			log.info('Kete model settings changed');
			service.settingsChanged();
		}
	}));

	context.subscriptions.push(context.secrets.onDidChange(async e => {
		if (e.key === CLAUDE_API_KEY_SECRET || e.key === OPENAI_API_KEY_SECRET) {
			claudeApiKey = Promise.resolve(context.secrets.get(CLAUDE_API_KEY_SECRET));
			openaiApiKey = Promise.resolve(context.secrets.get(OPENAI_API_KEY_SECRET));
			await refreshHasKeys();
			service.settingsChanged();
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('kete.models.setClaudeApiKey', () => storeApiKey({
		secret: CLAUDE_API_KEY_SECRET,
		title: vscode.l10n.t('Set Claude API Key'),
		prompt: vscode.l10n.t('The key is kept in the operating system\'s secret storage and is only sent to the Claude API.'),
		placeHolder: 'sk-ant-…',
		verify: (key, signal) => anthropic.verifyApiKey(key, signal),
		rejected: vscode.l10n.t('Claude rejected this API key. It was not saved.'),
		saved: vscode.l10n.t('Claude API key saved.'),
		unchecked: vscode.l10n.t('Claude API key saved, but it could not be checked because the Claude API is unreachable.'),
		context,
		log,
	})));

	context.subscriptions.push(vscode.commands.registerCommand('kete.models.setOpenAIApiKey', () => storeApiKey({
		secret: OPENAI_API_KEY_SECRET,
		title: vscode.l10n.t('Set OpenAI API Key'),
		prompt: vscode.l10n.t('The key is kept in the operating system\'s secret storage and is only sent to the endpoint in "kete.models.openai.endpoint".'),
		placeHolder: 'sk-…',
		verify: (key, signal) => openai.verifyApiKey(key, signal),
		rejected: vscode.l10n.t('The OpenAI endpoint rejected this API key. It was not saved.'),
		saved: vscode.l10n.t('OpenAI API key saved.'),
		unchecked: vscode.l10n.t('OpenAI API key saved, but it could not be checked because the endpoint is unreachable.'),
		context,
		log,
	})));

	context.subscriptions.push(vscode.commands.registerCommand('kete.models.clearClaudeApiKey', async () => {
		await context.secrets.delete(CLAUDE_API_KEY_SECRET);
		vscode.window.showInformationMessage(vscode.l10n.t('Claude API key removed.'));
	}));

	context.subscriptions.push(vscode.commands.registerCommand('kete.models.clearOpenAIApiKey', async () => {
		await context.secrets.delete(OPENAI_API_KEY_SECRET);
		vscode.window.showInformationMessage(vscode.l10n.t('OpenAI API key removed.'));
	}));

	context.subscriptions.push(vscode.commands.registerCommand('kete.models.checkConnectivity', async () => {
		const [local, claude, openaiState] = await Promise.all([localMonitor.check(true), claudeMonitor.check(true), openaiMonitor.check(true)]);
		const notInUse = vscode.l10n.t('not in use');
		vscode.window.showInformationMessage(vscode.l10n.t(
			'Ollama: {0}. Claude API: {1}. OpenAI API: {2}.',
			stateLabel(local),
			claudeMonitor.known ? stateLabel(claude) : notInUse,
			openaiMonitor.known ? stateLabel(openaiState) : notInUse,
		));
	}));

	context.subscriptions.push(vscode.commands.registerCommand('kete.models.showLog', () => log.show()));
}

export function deactivate(): void { }

/** Everything {@link storeApiKey} needs to ask for, check and store one key. */
interface StoreApiKeyOptions {
	readonly secret: string;
	readonly title: string;
	readonly prompt: string;
	readonly placeHolder: string;
	readonly verify: (key: string, signal: AbortSignal) => Promise<boolean>;
	readonly rejected: string;
	readonly saved: string;
	readonly unchecked: string;
	readonly context: vscode.ExtensionContext;
	readonly log: vscode.LogOutputChannel;
}

/**
 * Asks for an API key, checks it against its service and stores it in secret
 * storage. A key that can't be checked because the service is unreachable is
 * still stored, so it can be set up offline.
 */
async function storeApiKey(options: StoreApiKeyOptions): Promise<void> {
	const value = await vscode.window.showInputBox({
		title: options.title,
		prompt: options.prompt,
		placeHolder: options.placeHolder,
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
		verified = await options.verify(key, controller.signal);
	} catch (error) {
		options.log.warn(`Could not verify the API key: ${error instanceof ProviderError ? error.message : String(error)}`);
	}
	if (verified === false) {
		vscode.window.showErrorMessage(options.rejected);
		return;
	}
	await options.context.secrets.store(options.secret, key);
	if (verified) {
		vscode.window.showInformationMessage(options.saved);
	} else {
		vscode.window.showWarningMessage(options.unchecked);
	}
}

/** The Claude model used for the frontier tier, per the routing setting. */
function claudeFrontierModel(): ModelDescriptor | undefined {
	const configured = vscode.workspace.getConfiguration('kete.models').get<string>('routing.frontierModel', ClaudeModelId.Sonnet);
	const id = configured === ClaudeModelId.Opus ? ClaudeModelId.Opus : ClaudeModelId.Sonnet;
	return CLAUDE_MODELS.find(model => model.providerModelId === id);
}

function readSettings(): ModelSettings {
	const configuration = vscode.workspace.getConfiguration('kete.models');
	return {
		ollamaModel: configuration.get<string>('ollama.model', ''),
		cloudEnabled: configuration.get<boolean>('cloud.enabled', true),
		maxTier: parseModelTier(configuration.get<string>('routing.maxTier')) ?? ModelTier.Frontier,
		cloudVendor: parseCloudVendor(configuration.get<string>('cloud.vendor')),
		localMaxInputTokens: positiveNumber(configuration.get<number>('routing.localMaxInputTokens'), 8000),
		midMaxInputTokens: positiveNumber(configuration.get<number>('routing.midMaxInputTokens'), 50000),
	};
}

function parseCloudVendor(value: string | undefined): ModelVendor {
	return value === 'openai' ? 'openai' : 'anthropic';
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
