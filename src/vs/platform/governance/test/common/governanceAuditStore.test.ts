/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { FileService } from '../../../files/common/fileService.js';
import { IFileWriteOptions } from '../../../files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../log/common/log.js';
import { GovernanceOutcome, GovernanceRiskTier, GovernedActionKind, IApprovalRequest, IGovernanceApprover } from '../../common/governance.js';
import { IAuditEntry, InMemoryAuditSink } from '../../common/governanceAuditLog.js';
import { AUDIT_CHAIN_GENESIS, AuthoritativeAuditSink, FileAuditStore, hashAuditLine, verifyAuditChain } from '../../common/governanceAuditStore.js';
import { GovernanceGate } from '../../common/governanceGate.js';

/** Fails writes on demand; with `partial`, writes half the bytes first, as a full disk might. */
class FlakyFileSystemProvider extends InMemoryFileSystemProvider {

	failWrites: 'no' | 'before' | 'partial' = 'no';

	override async writeFile(resource: URI, content: Uint8Array, opts: IFileWriteOptions): Promise<void> {
		if (this.failWrites === 'partial') {
			await super.writeFile(resource, content.slice(0, Math.floor(content.byteLength / 2)), opts);
		}
		if (this.failWrites !== 'no') {
			throw new Error('disk full');
		}
		return super.writeFile(resource, content, opts);
	}
}

function entry(index: number, overrides: Partial<IAuditEntry> = {}): IAuditEntry {
	return {
		id: `audit-${index}`,
		timestamp: `2026-09-14T10:00:${String(index % 60).padStart(2, '0')}.000Z`,
		sessionId: 'session-1',
		kind: GovernedActionKind.Tool,
		name: 'run_in_terminal',
		origin: 'kete.agent',
		tier: GovernanceRiskTier.LocalWrite,
		outcome: GovernanceOutcome.Allowed,
		approvalRequested: false,
		reason: 'below threshold',
		...overrides,
	};
}

const folder = URI.file('/globalStorage/keteGovernanceAudit');

suite('Governance audit store', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const fileService = disposables.add(new FileService(new NullLogService()));
		const provider = disposables.add(new FlakyFileSystemProvider());
		disposables.add(fileService.registerProvider('file', provider));
		let writers = 0;
		const createStore = () => new FileAuditStore(folder, fileService, { createWriterId: () => `writer${++writers}` });
		const createStoreWithId = (writerId: string) => new FileAuditStore(folder, fileService, { createWriterId: () => writerId });
		const read = async (name: string) => (await fileService.readFile(joinPath(folder, name))).value.toString();
		const list = async () => ((await fileService.resolve(folder)).children ?? []).map(child => child.name).sort();
		return { fileService, provider, createStore, createStoreWithId, read, list };
	}

	test('entries round-trip as hash-chained records, one file per writer per UTC day, continued across sessions', async () => {
		const { createStoreWithId, read, list } = setup();
		const first = entry(1, { commandLine: 'kubectl get pods', detail: { toolId: 'run_in_terminal', attempt: 2, confirmed: true } });
		const second = entry(2, { outcome: GovernanceOutcome.Denied, reason: 'line one\nline two' });
		const nextDay = entry(3, { timestamp: '2026-09-15T00:00:01.000Z' });
		const lateArrival = entry(4, { timestamp: '2026-09-14T23:59:59.999Z' });

		const session1 = createStoreWithId('writerA');
		await session1.append(first);
		await session1.append(second);
		// A later session with the same writer id continues the chain rather than restarting it.
		await createStoreWithId('writerA').append(nextDay);
		const session3 = createStoreWithId('writerA');
		await session3.append(entry(5, { timestamp: '2026-09-15T00:00:02.000Z' }));
		await session3.append(lateArrival);

		const day1 = await read('2026-09-14.writerA.jsonl');
		const day1Lines = day1.split('\n');
		const day2 = await read('2026-09-15.writerA.jsonl');
		const day2Lines = day2.split('\n');

		assert.deepStrictEqual({
			files: await list(),
			day1: day1Lines.filter(Boolean).map(line => JSON.parse(line)),
			day2: day2Lines.filter(Boolean).map(line => JSON.parse(line)),
			verified: [await verifyAuditChain(day1), await verifyAuditChain(day2)].map(result => ({ records: result.records, firstBreak: result.firstBreak })),
		}, {
			files: ['2026-09-14.writerA.jsonl', '2026-09-15.writerA.jsonl'],
			day1: [
				{ v: 1, seq: 0, prevHash: AUDIT_CHAIN_GENESIS, entry: first },
				{ v: 1, seq: 1, prevHash: await hashAuditLine(day1Lines[0]), entry: second },
			],
			day2: [
				{ v: 1, seq: 0, prevHash: AUDIT_CHAIN_GENESIS, entry: nextDay },
				{ v: 1, seq: 1, prevHash: await hashAuditLine(day2Lines[0]), entry: entry(5, { timestamp: '2026-09-15T00:00:02.000Z' }) },
				// Never reopens an earlier day's file.
				{ v: 1, seq: 2, prevHash: await hashAuditLine(day2Lines[1]), entry: lateArrival },
			],
			verified: [{ records: 2, firstBreak: undefined }, { records: 3, firstBreak: undefined }],
		});
	});

	test('concurrent appends are all written, in call order, on an unbroken chain', async () => {
		const { createStore, read } = setup();
		const store = createStore();
		const entries = Array.from({ length: 50 }, (_, index) => entry(index));

		await Promise.all(entries.map(e => store.append(e)));

		const content = await read('2026-09-14.writer1.jsonl');
		const verification = await verifyAuditChain(content);
		assert.deepStrictEqual({
			ids: content.split('\n').filter(Boolean).map(line => JSON.parse(line).entry.id),
			records: verification.records,
			firstBreak: verification.firstBreak,
		}, {
			ids: entries.map(e => e.id),
			records: 50,
			firstBreak: undefined,
		});
	});

	test('a failed write rejects append, and later appends still chain correctly', async () => {
		const { provider, createStore, read, list } = setup();
		const store = createStore();
		await store.append(entry(1));

		provider.failWrites = 'before';
		const clean = await store.append(entry(2)).then(() => 'resolved', (error: Error) => error.message);

		provider.failWrites = 'partial';
		const partial = await store.append(entry(3)).then(() => 'resolved', (error: Error) => error.message);

		provider.failWrites = 'no';
		await store.append(entry(4));

		const abandoned = await read('2026-09-14.writer1.jsonl');
		const fresh = await read('2026-09-14.writer2.jsonl');
		assert.deepStrictEqual({
			clean: /disk full/.test(clean),
			partial: /disk full/.test(partial),
			files: await list(),
			// The half-written line is left in place and reported, not written after.
			abandoned: await verifyAuditChain(abandoned).then(result => ({ records: result.records, firstBreak: result.firstBreak })),
			fresh: await verifyAuditChain(fresh).then(result => ({ records: result.records, firstBreak: result.firstBreak })),
			freshIds: fresh.split('\n').filter(Boolean).map(line => JSON.parse(line).entry.id),
		}, {
			clean: true,
			partial: true,
			files: ['2026-09-14.writer1.jsonl', '2026-09-14.writer2.jsonl'],
			abandoned: { records: 1, firstBreak: { line: 2, reason: 'the final line is incomplete' } },
			fresh: { records: 1, firstBreak: undefined },
			freshIds: ['audit-4'],
		});
	});

	test('the gate denies an approved action when the durable store fails, even though the log mirror works', async () => {
		const { provider, createStore } = setup();
		provider.failWrites = 'before';
		const mirror = new InMemoryAuditSink();
		const gate = disposables.add(new GovernanceGate(new AuthoritativeAuditSink(createStore(), [mirror]), new TestConfigurationService({}), new NullLogService()));
		const approver: IGovernanceApprover = { requestApproval: async (_request: IApprovalRequest) => true };
		disposables.add(gate.registerApprover(approver));

		const decision = await gate.authorize({
			kind: GovernedActionKind.Tool,
			name: 'run_in_terminal',
			origin: 'kete.agent',
			sessionId: 'session-1',
			commandLine: 'kubectl --context prod apply -f x.yaml',
		}, CancellationToken.None);

		assert.deepStrictEqual(
			{ outcome: decision.outcome, reason: decision.reason, mirrored: mirror.entries.map(e => e.outcome) },
			{ outcome: GovernanceOutcome.Denied, reason: 'denied because the decision could not be recorded', mirrored: [GovernanceOutcome.Allowed] }
		);
	});

	test('the hash chain verifies an untouched file and finds edited, removed and reordered lines', async () => {
		const { createStore, read } = setup();
		const store = createStore();
		for (let index = 0; index < 4; index++) {
			await store.append(entry(index));
		}
		const content = await read('2026-09-14.writer1.jsonl');
		const lines = content.split('\n').filter(Boolean);
		const join = (parts: string[]) => parts.map(line => `${line}\n`).join('');
		const summarize = async (text: string) => {
			const result = await verifyAuditChain(text);
			return { records: result.records, firstBreak: result.firstBreak };
		};

		assert.deepStrictEqual({
			untouched: await summarize(content),
			edited: await summarize(join([lines[0], lines[1].replace('"outcome":"allowed"', '"outcome":"denied"'), lines[2], lines[3]])),
			removed: await summarize(join([lines[0], lines[2], lines[3]])),
			firstRemoved: await summarize(join([lines[1], lines[2], lines[3]])),
			reordered: await summarize(join([lines[0], lines[2], lines[1], lines[3]])),
			garbage: await summarize(join([lines[0], 'not json', lines[1]])),
		}, {
			untouched: { records: 4, firstBreak: undefined },
			edited: { records: 2, firstBreak: { line: 3, reason: 'prevHash does not match line 2; that line was changed, or lines were removed or reordered' } },
			removed: { records: 1, firstBreak: { line: 2, reason: 'prevHash does not match line 1; that line was changed, or lines were removed or reordered' } },
			firstRemoved: { records: 0, firstBreak: { line: 1, reason: 'the first record does not start the chain; earlier lines were removed' } },
			reordered: { records: 1, firstBreak: { line: 2, reason: 'prevHash does not match line 1; that line was changed, or lines were removed or reordered' } },
			garbage: { records: 1, firstBreak: { line: 2, reason: 'the line is not an audit record' } },
		});
	});
});
