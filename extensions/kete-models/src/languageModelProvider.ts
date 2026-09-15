/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderError, ProviderErrorKind } from './core/errors';
import { KETE_AUTO_MODEL_ID, ModelService, NoModelAvailableError, registeredModelId } from './core/modelService';
import { estimateTokens, parseRoutingHints, RoutingUnavailable } from './core/router';
import { ChatMessage, ChatRequest, ChatTool, ContentPart, ModelDescriptor, ModelTier, ResponsePart } from './core/types';

/** The vendor id registered with the editor, shared with the agent extension. */
export const KETE_VENDOR = 'kete';

/**
 * Set by Kete Auto on each attempt it sends back through the language model API,
 * so the concrete model's handler can hand the original `ProviderError` back.
 * Errors lose their type crossing the API, and the router needs the kind to
 * decide whether to fall back.
 */
const ATTEMPT_OPTION = 'kete.routeAttempt';

interface KeteModelInformation extends vscode.LanguageModelChatInformation {
	/** The provider model behind this entry; absent for Kete Auto. */
	readonly descriptor: ModelDescriptor | undefined;
}

/**
 * Registers Kete's models with the editor's language model registry.
 *
 * Every request, including each attempt Kete Auto makes, reaches this provider
 * through `ILanguageModelsService.sendChatRequest`, where the governance gate
 * records it (D-003). Kete Auto never calls a provider directly: it sends each
 * attempt back through `vscode.lm`, so the audit log names the model that
 * actually served the request, not only "kete-auto".
 */
export class KeteLanguageModelProvider implements vscode.LanguageModelChatProvider<KeteModelInformation>, vscode.Disposable {
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.onDidChangeEmitter.event;

	private readonly attemptErrors = new Map<string, ProviderError>();
	private attemptCounter = 0;
	private readonly disposables: vscode.Disposable[] = [this.onDidChangeEmitter];

	constructor(private readonly service: ModelService) {
		const subscription = service.onDidChangeModels(() => this.onDidChangeEmitter.fire());
		this.disposables.push({ dispose: () => subscription.dispose() });
	}

	async provideLanguageModelChatInformation(_options: vscode.PrepareLanguageModelChatModelOptions, token: vscode.CancellationToken): Promise<KeteModelInformation[]> {
		const controller = abortOnCancel(token);
		try {
			const [local, cloud] = await Promise.all([this.service.getLocalModels(controller.signal), this.service.getCloudModels()]);
			const available = [...local, ...cloud];
			return [autoModelInformation(available), ...available.map(toModelInformation)];
		} finally {
			controller.dispose();
		}
	}

	async provideLanguageModelChatResponse(model: KeteModelInformation, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<void> {
		const controller = abortOnCancel(token);
		try {
			const request = toChatRequest(messages, options);
			if (model.descriptor) {
				await this.runConcrete(model.descriptor, request, options, progress, controller.signal);
			} else {
				await this.runAuto(messages, request, options, progress, token, controller.signal);
			}
		} catch (error) {
			throw toEditorError(error);
		} finally {
			controller.dispose();
		}
	}

	async provideTokenCount(_model: KeteModelInformation, text: string | vscode.LanguageModelChatRequestMessage): Promise<number> {
		if (typeof text === 'string') {
			return Math.ceil(text.length / 4);
		}
		return estimateTokens([toChatMessage(text)], []);
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	private async runConcrete(descriptor: ModelDescriptor, request: ChatRequest, options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, signal: AbortSignal): Promise<void> {
		const attemptId: unknown = options.modelOptions?.[ATTEMPT_OPTION];
		try {
			await this.service.runModel(descriptor, request, part => progress.report(toResponsePart(part)), signal);
		} catch (error) {
			if (typeof attemptId === 'string' && error instanceof ProviderError) {
				this.attemptErrors.set(attemptId, error);
			}
			throw error;
		}
	}

	private async runAuto(messages: readonly vscode.LanguageModelChatRequestMessage[], request: ChatRequest, options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken, signal: AbortSignal): Promise<void> {
		const forwarded = messages.map(message => new vscode.LanguageModelChatMessage(message.role, message.content.filter(isInputPart), message.name));
		await this.service.runRouted(request, parseRoutingHints(options.modelOptions), async (candidate, markEmitted) => {
			const id = registeredModelId(candidate.model);
			const [chat] = await vscode.lm.selectChatModels({ vendor: KETE_VENDOR, id });
			if (!chat || chat.id === KETE_AUTO_MODEL_ID) {
				throw new ProviderError(ProviderErrorKind.NotFound, `${id} is not registered`);
			}
			const attemptId = `${++this.attemptCounter}`;
			try {
				const response = await chat.sendRequest(forwarded, {
					modelOptions: { [ATTEMPT_OPTION]: attemptId },
					tools: options.tools ? [...options.tools] : undefined,
					toolMode: options.toolMode,
				}, token);
				for await (const part of response.stream) {
					if (part instanceof vscode.LanguageModelTextPart || part instanceof vscode.LanguageModelToolCallPart || part instanceof vscode.LanguageModelDataPart) {
						markEmitted();
						progress.report(part);
					}
				}
			} catch (error) {
				// Prefer the typed error the concrete handler recorded. Anything else,
				// such as a governance refusal, was not a model failure: no fallback.
				throw this.attemptErrors.get(attemptId) ?? error;
			} finally {
				this.attemptErrors.delete(attemptId);
			}
		}, signal);
	}
}

function autoModelInformation(available: readonly ModelDescriptor[]): KeteModelInformation {
	const hasCloud = available.some(model => model.tier !== ModelTier.Local);
	const largest = available.reduce((max, model) => Math.max(max, model.maxInputTokens), 0);
	return {
		id: KETE_AUTO_MODEL_ID,
		family: KETE_AUTO_MODEL_ID,
		name: 'Kete Auto',
		version: '1',
		detail: vscode.l10n.t('Cheapest capable model'),
		tooltip: vscode.l10n.t('Uses a local Ollama model for routine work and a cloud model only when a request needs it. The routing log explains each choice.'),
		maxInputTokens: largest || 8000,
		maxOutputTokens: hasCloud ? 32000 : 4096,
		capabilities: {
			toolCalling: true,
			imageInput: available.some(model => model.supportsImages === true),
		},
		descriptor: undefined,
	};
}

function toModelInformation(model: ModelDescriptor): KeteModelInformation {
	return {
		id: registeredModelId(model),
		family: model.family,
		name: model.displayName,
		version: model.providerModelId,
		detail: model.tier === ModelTier.Local ? vscode.l10n.t('Local') : model.tier === ModelTier.Mid ? vscode.l10n.t('Cloud, mid tier') : vscode.l10n.t('Cloud, frontier tier'),
		maxInputTokens: model.maxInputTokens,
		maxOutputTokens: model.maxOutputTokens,
		capabilities: {
			toolCalling: model.supportsToolCalling === true,
			imageInput: model.supportsImages === true,
		},
		descriptor: model,
	};
}

function isInputPart(part: unknown): part is vscode.LanguageModelInputPart {
	return part instanceof vscode.LanguageModelTextPart
		|| part instanceof vscode.LanguageModelToolCallPart
		|| part instanceof vscode.LanguageModelToolResultPart
		|| part instanceof vscode.LanguageModelDataPart;
}

function toChatRequest(messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions): ChatRequest {
	const tools: ChatTool[] = (options.tools ?? []).map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
	return {
		messages: messages.map(toChatMessage),
		tools,
		toolCallRequired: options.toolMode === vscode.LanguageModelChatToolMode.Required,
	};
}

function toChatMessage(message: vscode.LanguageModelChatRequestMessage): ChatMessage {
	const role = message.role === vscode.LanguageModelChatMessageRole.System ? 'system'
		: message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant'
			: 'user';
	const content: ContentPart[] = [];
	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			content.push({ type: 'text', text: part.value });
		} else if (part instanceof vscode.LanguageModelToolCallPart) {
			content.push({ type: 'toolCall', callId: part.callId, name: part.name, input: part.input });
		} else if (part instanceof vscode.LanguageModelToolResultPart) {
			content.push({ type: 'toolResult', callId: part.callId, text: toolResultText(part.content) });
		} else if (part instanceof vscode.LanguageModelDataPart) {
			if (part.mimeType.startsWith('image/')) {
				content.push({ type: 'image', mimeType: part.mimeType, data: part.data });
			} else if (part.mimeType.startsWith('text/') || part.mimeType === 'application/json') {
				content.push({ type: 'text', text: new TextDecoder().decode(part.data) });
			}
			// Other data parts, such as another vendor's cache markers, don't apply here.
		}
	}
	return { role, content };
}

function toolResultText(content: readonly unknown[]): string {
	const texts: string[] = [];
	for (const part of content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			texts.push(part.value);
		} else if (part instanceof vscode.LanguageModelPromptTsxPart) {
			texts.push(JSON.stringify(part.value));
		} else if (part instanceof vscode.LanguageModelDataPart && (part.mimeType.startsWith('text/') || part.mimeType === 'application/json')) {
			texts.push(new TextDecoder().decode(part.data));
		}
	}
	return texts.join('\n');
}

function toResponsePart(part: ResponsePart): vscode.LanguageModelResponsePart {
	return part.type === 'text'
		? new vscode.LanguageModelTextPart(part.text)
		: new vscode.LanguageModelToolCallPart(part.callId, part.name, part.input);
}

function abortOnCancel(token: vscode.CancellationToken): { readonly signal: AbortSignal; dispose(): void } {
	const controller = new AbortController();
	const listener = token.onCancellationRequested(() => controller.abort());
	if (token.isCancellationRequested) {
		controller.abort();
	}
	return { signal: controller.signal, dispose: () => listener.dispose() };
}

/**
 * Turns a failure into the error the person sees. Messages from providers are
 * technical, so they are wrapped in a localized sentence.
 */
function toEditorError(error: unknown): Error {
	if (error instanceof NoModelAvailableError) {
		return new Error(noModelMessage(error.unavailable));
	}
	if (error instanceof ProviderError) {
		switch (error.kind) {
			case ProviderErrorKind.Auth:
				return vscode.LanguageModelError.NoPermissions(vscode.l10n.t('The model provider rejected the API key. Run "Kete: Set Claude API Key" or "Kete: Set OpenAI API Key" to replace it. ({0})', error.message));
			case ProviderErrorKind.NotFound:
				return vscode.LanguageModelError.NotFound(vscode.l10n.t('The model is not available: {0}', error.message));
			case ProviderErrorKind.Cancelled:
				return new vscode.CancellationError();
			default:
				return new Error(vscode.l10n.t('The model request failed: {0}', error.message));
		}
	}
	return error instanceof Error ? error : new Error(String(error));
}

function noModelMessage(unavailable: RoutingUnavailable): string {
	const local = unavailable.local === 'ollamaOffline' ? vscode.l10n.t('Ollama is not running at the configured endpoint; start it, or check the "kete.models.ollama.endpoint" setting.')
		: unavailable.local === 'noLocalModel' ? vscode.l10n.t('Ollama has no chat models; pull one, for example with "ollama pull qwen2.5-coder:7b".')
			: vscode.l10n.t('The local model failed.');
	const cloud = unavailable.cloud === 'disabled' ? vscode.l10n.t('Cloud models are switched off in the "kete.models.cloud.enabled" setting.')
		: unavailable.cloud === 'noApiKey' ? vscode.l10n.t('No cloud API key is set; run "Kete: Set Claude API Key" or "Kete: Set OpenAI API Key".')
			: unavailable.cloud === 'cappedByMaxTier' ? vscode.l10n.t('The "kete.models.routing.maxTier" setting allows local models only.')
				: unavailable.cloud === 'offline' ? vscode.l10n.t('The cloud model provider cannot be reached from this network.')
					: vscode.l10n.t('The cloud model failed.');
	return vscode.l10n.t('No Kete model is available. {0} {1}', local, cloud);
}
