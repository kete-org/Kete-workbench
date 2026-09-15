/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ProviderError, ProviderErrorKind } from './errors';
import { Disposable } from './types';

/**
 * How reachable a model service is.
 */
export enum ConnectivityState {
	/** The last probe or request succeeded. */
	Online = 'online',
	/**
	 * Reachable but unreliable: a recent request failed with a server error,
	 * overload, rate limit or broken stream, or a probe was slow. Also the state
	 * before the first check.
	 */
	Degraded = 'degraded',
	/** The last probe or request couldn't connect at all. */
	Offline = 'offline',
}

/** A state change. */
export interface ConnectivityChange {
	readonly previous: ConnectivityState;
	readonly current: ConnectivityState;
	/** Why the state changed, for logs. */
	readonly reason: string;
}

/** Time and timers, injectable so tests don't wait. */
export interface Scheduler {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): Disposable;
}

/** The real clock. */
export const systemScheduler: Scheduler = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => {
		const handle = setTimeout(callback, delayMs);
		return { dispose: () => clearTimeout(handle) };
	},
};

/** Options for {@link ConnectivityMonitor}. */
export interface ConnectivityMonitorOptions {
	/** Names the service in change reasons. */
	readonly name: string;
	/** A cheap request that throws a `ProviderError` when the service is not usable. */
	readonly probe: (signal: AbortSignal) => Promise<void>;
	/**
	 * Whether probing makes sense at all, e.g. `false` while cloud use is switched
	 * off or no key is set. A disabled monitor never touches the network.
	 */
	readonly isEnabled: () => boolean;
	readonly scheduler?: Scheduler;
	/** A successful probe slower than this counts as degraded. */
	readonly slowProbeMs?: number;
	/** Calls to `check` within this long of the last probe reuse its result. */
	readonly minCheckIntervalMs?: number;
	/** First delay before re-probing a degraded or offline service; doubles up to the maximum. */
	readonly initialRecheckDelayMs?: number;
	readonly maxRecheckDelayMs?: number;
}

/**
 * What a failure of a given kind says about connectivity: `unreachable` means
 * offline, `unhealthy` means degraded, and anything else (a rejected key, a
 * missing model, a bad request, a cancellation) says nothing.
 */
export function connectivityImpact(kind: ProviderErrorKind): 'unreachable' | 'unhealthy' | undefined {
	switch (kind) {
		case ProviderErrorKind.Unreachable: return 'unreachable';
		case ProviderErrorKind.Unhealthy: return 'unhealthy';
		default: return undefined;
	}
}

/**
 * Tracks one service's connectivity as a state machine:
 *
 * - any success (probe or real request) → `Online`
 * - a failure to connect → `Offline`
 * - a server error, overload, rate limit, broken stream or slow probe → `Degraded`
 * - other failures leave the state unchanged
 *
 * Real request outcomes are reported by the caller, so a working service is
 * never probed. Only while `Degraded` or `Offline` does the monitor re-probe, on
 * a backoff from 15 seconds doubling to 5 minutes, and only while enabled.
 */
export class ConnectivityMonitor implements Disposable {
	private _state = ConnectivityState.Degraded;
	private _known = false;
	private lastProbeAt: number | undefined;
	private inFlight: Promise<ConnectivityState> | undefined;
	private recheck: Disposable | undefined;
	private recheckDelayMs: number;
	private readonly listeners = new Set<(change: ConnectivityChange) => void>();
	private readonly abort = new AbortController();
	private disposed = false;

	private readonly scheduler: Scheduler;
	private readonly slowProbeMs: number;
	private readonly minCheckIntervalMs: number;
	private readonly initialRecheckDelayMs: number;
	private readonly maxRecheckDelayMs: number;

	constructor(private readonly options: ConnectivityMonitorOptions) {
		this.scheduler = options.scheduler ?? systemScheduler;
		this.slowProbeMs = options.slowProbeMs ?? 2500;
		this.minCheckIntervalMs = options.minCheckIntervalMs ?? 10000;
		this.initialRecheckDelayMs = options.initialRecheckDelayMs ?? 15000;
		this.maxRecheckDelayMs = options.maxRecheckDelayMs ?? 300000;
		this.recheckDelayMs = this.initialRecheckDelayMs;
	}

	/** The current state. */
	get state(): ConnectivityState {
		return this._state;
	}

	/** Whether any probe or request outcome has been observed yet. */
	get known(): boolean {
		return this._known;
	}

	/** Subscribes to state changes. */
	onDidChange(listener: (change: ConnectivityChange) => void): Disposable {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	/** Records a successful real request. */
	reportSuccess(): void {
		this.transition(ConnectivityState.Online, `${this.options.name} request succeeded`);
	}

	/** Records a failed real request. */
	reportFailure(error: ProviderError): void {
		const impact = connectivityImpact(error.kind);
		if (impact === 'unreachable') {
			this.transition(ConnectivityState.Offline, error.message);
		} else if (impact === 'unhealthy') {
			this.transition(ConnectivityState.Degraded, error.message);
		}
	}

	/** Probes once if nothing has been observed yet; otherwise returns the current state. */
	ensureKnown(): Promise<ConnectivityState> {
		return this._known ? Promise.resolve(this._state) : this.check(true);
	}

	/**
	 * Probes the service, unless it is disabled or (without `force`) was probed
	 * within the minimum interval. Concurrent calls share one probe.
	 */
	check(force = false): Promise<ConnectivityState> {
		if (this.disposed || !this.options.isEnabled()) {
			return Promise.resolve(this._state);
		}
		if (this.inFlight) {
			return this.inFlight;
		}
		if (!force && this.lastProbeAt !== undefined && this.scheduler.now() - this.lastProbeAt < this.minCheckIntervalMs) {
			return Promise.resolve(this._state);
		}
		this.inFlight = this.runProbe().finally(() => this.inFlight = undefined);
		return this.inFlight;
	}

	/**
	 * Forgets everything observed, e.g. after the endpoint or key changed.
	 */
	reset(): void {
		this.recheck?.dispose();
		this.recheck = undefined;
		this.recheckDelayMs = this.initialRecheckDelayMs;
		this.lastProbeAt = undefined;
		this._known = false;
		const previous = this._state;
		this._state = ConnectivityState.Degraded;
		if (previous !== this._state) {
			this.fire({ previous, current: this._state, reason: `${this.options.name} settings changed` });
		}
	}

	dispose(): void {
		this.disposed = true;
		this.abort.abort();
		this.recheck?.dispose();
		this.recheck = undefined;
		this.listeners.clear();
	}

	private async runProbe(): Promise<ConnectivityState> {
		const started = this.scheduler.now();
		try {
			await this.options.probe(this.abort.signal);
			this.lastProbeAt = this.scheduler.now();
			if (this.disposed) {
				return this._state;
			}
			const elapsed = this.lastProbeAt - started;
			if (elapsed > this.slowProbeMs) {
				this.transition(ConnectivityState.Degraded, `${this.options.name} responded slowly (${elapsed} ms)`);
			} else {
				this.transition(ConnectivityState.Online, `${this.options.name} is reachable`);
			}
		} catch (error) {
			this.lastProbeAt = this.scheduler.now();
			if (this.disposed) {
				return this._state;
			}
			if (error instanceof ProviderError && connectivityImpact(error.kind) === 'unhealthy') {
				this.transition(ConnectivityState.Degraded, error.message);
			} else if (error instanceof ProviderError && error.kind === ProviderErrorKind.Cancelled) {
				return this._state;
			} else {
				// Unreachable, or a failure that makes the service unusable, such as an invalid endpoint.
				this.transition(ConnectivityState.Offline, error instanceof Error ? error.message : `${this.options.name} probe failed`);
			}
		}
		return this._state;
	}

	private transition(next: ConnectivityState, reason: string): void {
		if (this.disposed) {
			return;
		}
		const previous = this._state;
		const wasKnown = this._known;
		this._known = true;
		this._state = next;

		if (next === ConnectivityState.Online) {
			this.recheck?.dispose();
			this.recheck = undefined;
			this.recheckDelayMs = this.initialRecheckDelayMs;
		} else {
			this.scheduleRecheck();
		}

		if (previous !== next || !wasKnown) {
			this.fire({ previous, current: next, reason });
		}
	}

	private scheduleRecheck(): void {
		if (this.recheck || !this.options.isEnabled()) {
			return;
		}
		const delay = this.recheckDelayMs;
		this.recheckDelayMs = Math.min(this.recheckDelayMs * 2, this.maxRecheckDelayMs);
		this.recheck = this.scheduler.setTimeout(() => {
			this.recheck = undefined;
			this.check(true).catch(() => undefined);
		}, delay);
	}

	private fire(change: ConnectivityChange): void {
		for (const listener of [...this.listeners]) {
			listener(change);
		}
	}
}
