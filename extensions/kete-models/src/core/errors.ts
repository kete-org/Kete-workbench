/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Why a provider call failed. The kind decides what the failure means for
 * connectivity; the router may try another model after any kind but
 * `Cancelled`.
 */
export enum ProviderErrorKind {
	/** No connection: DNS failure, connection refused or reset, or no response in time. */
	Unreachable = 'unreachable',
	/** The service answered but is unhealthy: 5xx, overloaded, rate limited, or a broken stream. */
	Unhealthy = 'unhealthy',
	/** The credentials are missing or were rejected. */
	Auth = 'auth',
	/** The model doesn't exist on this provider. */
	NotFound = 'notFound',
	/** The provider rejected the request itself. */
	BadRequest = 'badRequest',
	/** The caller cancelled. */
	Cancelled = 'cancelled',
}

/**
 * An error from a model provider. Messages never contain prompt content or
 * credentials, so they are safe to log.
 */
export class ProviderError extends Error {
	constructor(
		public readonly kind: ProviderErrorKind,
		message: string,
		public readonly status?: number,
	) {
		super(message);
		this.name = 'ProviderError';
	}
}

/**
 * Maps an HTTP status to a failure kind.
 */
export function errorKindForStatus(status: number): ProviderErrorKind {
	if (status === 401 || status === 403) {
		return ProviderErrorKind.Auth;
	}
	if (status === 404) {
		return ProviderErrorKind.NotFound;
	}
	if (status === 408 || status === 429 || status >= 500) {
		return ProviderErrorKind.Unhealthy;
	}
	return ProviderErrorKind.BadRequest;
}

/**
 * Converts anything thrown during a provider call into a `ProviderError`.
 * `fetch` rejects with a `TypeError` for connection failures and with an
 * `AbortError` when its signal fires.
 */
export function toProviderError(error: unknown, signal: AbortSignal, providerLabel: string): ProviderError {
	if (error instanceof ProviderError) {
		return error;
	}
	if (signal.aborted) {
		return new ProviderError(ProviderErrorKind.Cancelled, `${providerLabel} request was cancelled`);
	}
	if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
		return new ProviderError(ProviderErrorKind.Unreachable, `${providerLabel} did not respond in time`);
	}
	if (error instanceof TypeError) {
		return new ProviderError(ProviderErrorKind.Unreachable, `${providerLabel} is unreachable: ${error.message}`);
	}
	const message = error instanceof Error ? error.message : String(error);
	return new ProviderError(ProviderErrorKind.Unhealthy, `${providerLabel} request failed: ${message}`);
}
