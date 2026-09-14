/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Sequencer } from '../../../base/common/async.js';
import { encodeHex, VSBuffer } from '../../../base/common/buffer.js';
import { joinPath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { FileOperationResult, FileSystemProviderCapabilities, IFileService, toFileOperationResult } from '../../files/common/files.js';
import { IAuditEntry, IAuditSink } from './governanceAuditLog.js';

/**
 * The folder, under the default profile's global storage, that holds the
 * durable audit log. Global storage rather than the logs folder because logs
 * rotate away after a few sessions; the default profile rather than the
 * current one because switching profiles must not start a fresh audit trail.
 */
export const GOVERNANCE_AUDIT_FOLDER_NAME = 'keteGovernanceAudit';

/** The `prevHash` of the first record in every audit file. */
export const AUDIT_CHAIN_GENESIS = '0'.repeat(64);

/** Bumped if the stored record shape ever changes. */
export const AUDIT_RECORD_VERSION = 1;

/**
 * One line of an audit file: the entry, wrapped with what is needed to notice
 * if lines are later edited, removed or reordered.
 */
export interface IAuditRecord {
	readonly v: typeof AUDIT_RECORD_VERSION;
	/** Position of the record in its file, from 0. */
	readonly seq: number;
	/**
	 * SHA-256, hex, of the previous line of the file exactly as stored (UTF-8,
	 * without its newline); {@link AUDIT_CHAIN_GENESIS} for the first line.
	 */
	readonly prevHash: string;
	readonly entry: IAuditEntry;
}

/** Where a chain first stops holding. */
export interface IAuditChainBreak {
	/** 1-based line number. */
	readonly line: number;
	readonly reason: string;
}

export interface IAuditChainVerification {
	/** Records verified before the first break, or all of them. */
	readonly records: number;
	/** Hash of the last verified line; the genesis value if there was none. */
	readonly lastHash: string;
	/** `undefined` when the whole file verifies. */
	readonly firstBreak: IAuditChainBreak | undefined;
}

/** Hashes one stored line (without its newline) as SHA-256, returning hex. */
export async function hashAuditLine(line: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(line));
	return encodeHex(VSBuffer.wrap(new Uint8Array(digest)));
}

function isAuditRecord(value: unknown): value is IAuditRecord {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as Partial<IAuditRecord>;
	return candidate.v === AUDIT_RECORD_VERSION
		&& typeof candidate.seq === 'number'
		&& typeof candidate.prevHash === 'string'
		&& typeof candidate.entry === 'object' && candidate.entry !== null;
}

function parseAuditRecord(line: string): IAuditRecord | undefined {
	try {
		const parsed: unknown = JSON.parse(line);
		return isAuditRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Walks the content of one audit file and reports the first link in the hash
 * chain that does not hold.
 *
 * Editing or removing a line is reported at the line after it, whose
 * `prevHash` no longer matches. Two limits are inherent to a chain kept in the
 * same file it protects: changing or dropping the *last* lines, or deleting
 * the whole file, leaves nothing behind to disagree. Catching those needs the
 * latest hash to be anchored somewhere else.
 */
export async function verifyAuditChain(content: string): Promise<IAuditChainVerification> {
	let expectedPrevHash = AUDIT_CHAIN_GENESIS;
	let records = 0;
	const broken = (line: number, reason: string): IAuditChainVerification => ({ records, lastHash: expectedPrevHash, firstBreak: { line, reason } });

	if (content.length === 0) {
		return { records, lastHash: expectedPrevHash, firstBreak: undefined };
	}

	const lines = content.split('\n');
	const complete = content.endsWith('\n');
	if (complete) {
		lines.pop();
	}

	for (let index = 0; index < lines.length; index++) {
		const lineNumber = index + 1;
		const line = lines[index];
		if (!complete && index === lines.length - 1) {
			return broken(lineNumber, 'the final line is incomplete');
		}
		const record = parseAuditRecord(line);
		if (!record) {
			return broken(lineNumber, 'the line is not an audit record');
		}
		if (record.prevHash !== expectedPrevHash) {
			return broken(lineNumber, index === 0
				? 'the first record does not start the chain; earlier lines were removed'
				: `prevHash does not match line ${index}; that line was changed, or lines were removed or reordered`);
		}
		if (record.seq !== index) {
			return broken(lineNumber, `expected sequence number ${index} but found ${record.seq}`);
		}
		expectedPrevHash = await hashAuditLine(line);
		records++;
	}

	return { records, lastHash: expectedPrevHash, firstBreak: undefined };
}

/** Reads an audit file and verifies its hash chain. See {@link verifyAuditChain}. */
export async function verifyAuditFile(fileService: IFileService, resource: URI): Promise<IAuditChainVerification> {
	const content = await fileService.readFile(resource);
	return verifyAuditChain(content.value.toString());
}

/** Where the next record of a file goes, and what it chains from. */
interface IAuditFileTail {
	readonly nextSeq: number;
	readonly prevHash: string;
}

interface IAuditFileTarget extends IAuditFileTail {
	readonly day: string;
	readonly resource: URI;
}

/** How many fresh file names to try before giving up on an append. */
const MAX_FILE_ATTEMPTS = 3;

function utcDayOf(entry: IAuditEntry): string {
	return /^\d{4}-\d{2}-\d{2}T/.test(entry.timestamp) ? entry.timestamp.slice(0, 10) : new Date().toISOString().slice(0, 10);
}

export interface IFileAuditStoreOptions {
	/**
	 * Names this writer's files. Called once up front, and again whenever the
	 * current file cannot be continued. Defaults to a random UUID.
	 */
	readonly createWriterId?: () => string;
}

/**
 * An append-only, hash-chained audit log in JSON Lines, one {@link IAuditRecord}
 * per line.
 *
 * Files are named `<UTC day>.<writer id>.jsonl`. Every workbench window runs
 * its own gate, and two processes appending to one file would each chain from
 * the last line *they* wrote, so each writer keeps files of its own; the day
 * prefix keeps any one file bounded and makes the folder sort by date.
 *
 * {@link append} resolves only once the line has been handed to the file
 * system provider, and rejects if that fails, so the gate can refuse to let an
 * unrecorded action run. Appends are serialized: records land in call order
 * and no two chain from the same line.
 */
export class FileAuditStore implements IAuditSink {

	private readonly writeQueue = new Sequencer();
	private readonly createWriterId: () => string;
	private writerId: string;

	/** The day files are currently written for. Never moves backwards. */
	private day: string | undefined;
	/** `undefined` until the first append, and again after a failed one. */
	private target: IAuditFileTarget | undefined;

	constructor(
		readonly folder: URI,
		private readonly fileService: IFileService,
		options: IFileAuditStoreOptions = {},
	) {
		this.createWriterId = options.createWriterId ?? generateUuid;
		this.writerId = this.nextWriterId();
	}

	append(entry: IAuditEntry): Promise<void> {
		return this.writeQueue.queue(() => this.doAppend(entry));
	}

	private nextWriterId(): string {
		return this.createWriterId().replace(/[^A-Za-z0-9-]/g, '_');
	}

	private async doAppend(entry: IAuditEntry): Promise<void> {
		const target = await this.resolveTarget(utcDayOf(entry));
		const record: IAuditRecord = { v: AUDIT_RECORD_VERSION, seq: target.nextSeq, prevHash: target.prevHash, entry };
		const line = JSON.stringify(record);
		// Hashed before writing, so nothing can fail between a successful write
		// and remembering what the next record chains from.
		const hash = await hashAuditLine(line);

		try {
			await this.appendToFile(target.resource, VSBuffer.fromString(`${line}\n`));
		} catch (error) {
			// How much of the line reached the file is unknown. Forget the tail so
			// the next append reads it back before chaining from it.
			this.target = undefined;
			throw error;
		}

		this.target = { ...target, nextSeq: target.nextSeq + 1, prevHash: hash };
	}

	private async resolveTarget(entryDay: string): Promise<IAuditFileTarget> {
		// Timestamps are taken before the append is queued, so around midnight
		// an entry can arrive after one from the next day. It goes into the later
		// file rather than reopening the earlier one.
		const day = this.day !== undefined && this.day > entryDay ? this.day : entryDay;
		if (this.target?.day === day) {
			return this.target;
		}
		this.day = day;
		this.target = undefined;

		for (let attempt = 0; attempt < MAX_FILE_ATTEMPTS; attempt++) {
			const resource = joinPath(this.folder, `${day}.${this.writerId}.jsonl`);
			const tail = await this.readTail(resource);
			if (tail) {
				return this.target = { day, resource, ...tail };
			}
			// The file ends in a partial or unreadable line, most likely from a
			// write that failed part-way. Appending after it would bury a good
			// record behind a bad one, so start a file of our own instead.
			this.writerId = this.nextWriterId();
		}

		throw new Error(`could not find an audit file to continue in ${this.folder.toString()}`);
	}

	/**
	 * Reads what an existing file's next record must chain from. Returns
	 * `undefined` if the file cannot safely be continued.
	 */
	private async readTail(resource: URI): Promise<IAuditFileTail | undefined> {
		let content: string;
		try {
			content = (await this.fileService.readFile(resource)).value.toString();
		} catch (error) {
			if (toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND) {
				return { nextSeq: 0, prevHash: AUDIT_CHAIN_GENESIS };
			}
			throw error;
		}

		if (content.length === 0) {
			return { nextSeq: 0, prevHash: AUDIT_CHAIN_GENESIS };
		}
		if (!content.endsWith('\n')) {
			return undefined;
		}
		const lastLine = content.slice(content.lastIndexOf('\n', content.length - 2) + 1, -1);
		const record = parseAuditRecord(lastLine);
		if (!record) {
			return undefined;
		}
		return { nextSeq: record.seq + 1, prevHash: await hashAuditLine(lastLine) };
	}

	private async appendToFile(resource: URI, buffer: VSBuffer): Promise<void> {
		// Activates the provider, so the capability check below is accurate.
		await this.fileService.canHandleResource(resource);

		if (this.fileService.hasCapability(resource, FileSystemProviderCapabilities.FileAppend)) {
			await this.fileService.writeFile(resource, buffer, { append: true });
			return;
		}

		// Every provider that holds user data today can append (disk, IndexedDB,
		// in-memory). For one that cannot, rewrite the file: slower, but correct,
		// because appends are serialized.
		let existing = VSBuffer.alloc(0);
		try {
			existing = (await this.fileService.readFile(resource)).value;
		} catch (error) {
			if (toFileOperationResult(error) !== FileOperationResult.FILE_NOT_FOUND) {
				throw error;
			}
		}
		await this.fileService.writeFile(resource, VSBuffer.concat([existing, buffer]));
	}
}

/**
 * Writes each entry to one authoritative sink and, best effort, to others.
 *
 * Unlike {@link MultiplexAuditSink}, which fails only when every sink fails,
 * this rejects whenever the authoritative sink does: a decision shown in the
 * Output panel but missing from the durable log has not been recorded. The
 * other sinks still receive the entry, so a failed write stays visible there.
 */
export class AuthoritativeAuditSink implements IAuditSink {

	constructor(
		private readonly authoritative: IAuditSink,
		private readonly mirrors: readonly IAuditSink[],
	) { }

	async append(entry: IAuditEntry): Promise<void> {
		const mirrored = Promise.allSettled(this.mirrors.map(async mirror => mirror.append(entry)));
		try {
			await this.authoritative.append(entry);
		} finally {
			await mirrored;
		}
	}
}
