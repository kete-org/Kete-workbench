/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { ConnectivityMonitor, ConnectivityState } from '../core/connectivity';
import { ProviderError, ProviderErrorKind } from '../core/errors';
import { FakeScheduler } from './fixtures';

type ProbeResult = 'ok' | 'slow' | ProviderErrorKind;

function monitor(results: ProbeResult[], enabled = () => true) {
	const scheduler = new FakeScheduler();
	const log: string[] = [];
	let probes = 0;
	const instance = new ConnectivityMonitor({
		name: 'Test',
		scheduler,
		isEnabled: enabled,
		probe: async () => {
			probes++;
			const result = results.shift() ?? 'ok';
			if (result === 'slow') {
				scheduler.advance(3000);
			} else if (result !== 'ok') {
				throw new ProviderError(result, `probe ${result}`);
			}
		},
	});
	instance.onDidChange(change => log.push(`${change.previous}→${change.current}`));
	return { instance, scheduler, log, probes: () => probes };
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
	}
}

suite('ConnectivityMonitor', () => {

	test('transitions on request outcomes', () => {
		const { instance, log } = monitor([]);
		const initial = { state: instance.state, known: instance.known };
		instance.reportFailure(new ProviderError(ProviderErrorKind.Auth, 'bad key'));
		const afterAuth = instance.known;
		instance.reportSuccess();
		instance.reportFailure(new ProviderError(ProviderErrorKind.Unhealthy, '529'));
		instance.reportFailure(new ProviderError(ProviderErrorKind.Unreachable, 'ENOTFOUND'));
		instance.reportFailure(new ProviderError(ProviderErrorKind.NotFound, 'no model'));
		instance.reportSuccess();
		instance.dispose();

		assert.deepStrictEqual({ initial, afterAuth, log }, {
			initial: { state: ConnectivityState.Degraded, known: false },
			afterAuth: false,
			log: ['degraded→online', 'online→degraded', 'degraded→offline', 'offline→online'],
		});
	});

	test('probes classify reachability, slowness and failures', async () => {
		const { instance, log } = monitor(['ok', 'slow', ProviderErrorKind.Unhealthy, ProviderErrorKind.Unreachable, ProviderErrorKind.BadRequest]);
		const states: ConnectivityState[] = [];
		for (let i = 0; i < 5; i++) {
			states.push(await instance.check(true));
		}
		instance.dispose();

		assert.deepStrictEqual({ states, log }, {
			states: [ConnectivityState.Online, ConnectivityState.Degraded, ConnectivityState.Degraded, ConnectivityState.Offline, ConnectivityState.Offline],
			log: ['degraded→online', 'online→degraded', 'degraded→offline'],
		});
	});

	test('re-probes an offline service on a doubling backoff and stops once online', async () => {
		const { instance, scheduler, probes } = monitor([ProviderErrorKind.Unreachable, ProviderErrorKind.Unreachable, ProviderErrorKind.Unreachable, 'ok']);
		await instance.ensureKnown();
		const delays: number[][] = [scheduler.pendingDelays()];
		for (const wait of [15000, 30000, 60000]) {
			scheduler.advance(wait);
			await settle();
			delays.push(scheduler.pendingDelays());
		}
		const result = { state: instance.state, probes: probes(), delays };
		instance.dispose();

		assert.deepStrictEqual(result, {
			state: ConnectivityState.Online,
			probes: 4,
			delays: [[15000], [30000], [60000], []],
		});
	});

	test('does not probe when disabled, shares concurrent probes and rate-limits checks', async () => {
		let enabled = false;
		const { instance, scheduler, probes } = monitor([], () => enabled);
		await instance.check(true);
		instance.reportFailure(new ProviderError(ProviderErrorKind.Unreachable, 'offline'));
		const disabled = { probes: probes(), timers: scheduler.pendingDelays().length };

		enabled = true;
		await Promise.all([instance.check(true), instance.check(true)]);
		const concurrent = probes();
		await instance.check();
		const rateLimited = probes();
		scheduler.advance(10000);
		await instance.check();
		const afterInterval = probes();
		instance.reset();
		const afterReset = { state: instance.state, known: instance.known };
		instance.dispose();

		assert.deepStrictEqual({ disabled, concurrent, rateLimited, afterInterval, afterReset }, {
			disabled: { probes: 0, timers: 0 },
			concurrent: 1,
			rateLimited: 1,
			afterInterval: 2,
			afterReset: { state: ConnectivityState.Degraded, known: false },
		});
	});
});
