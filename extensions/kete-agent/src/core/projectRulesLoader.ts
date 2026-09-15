/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableLike } from './agentTypes';
import { parseProjectRules, ProjectRules, ProjectRulesProblem } from './projectRules';

/**
 * A workspace folder, identified by a URI string.
 */
export interface WorkspaceFolderRef {
	readonly uri: string;
	readonly name: string;
}

/**
 * File access the loader needs from its client. Reads only.
 */
export interface ProjectRulesHost {
	/** The text of the folder's rules file, or `undefined` when it has none. */
	readRulesFile(folder: WorkspaceFolderRef): Promise<string | undefined>;
	/** Calls `onChange` whenever the folder's rules file is created, changed or deleted. */
	watchRulesFile(folder: WorkspaceFolderRef, onChange: () => void): DisposableLike;
}

/**
 * One folder's rules. `rules` is `undefined` when the folder has no usable file.
 */
export interface FolderProjectRules {
	readonly folder: WorkspaceFolderRef;
	readonly rules: ProjectRules | undefined;
	readonly problems: readonly ProjectRulesProblem[];
}

interface FolderEntry {
	readonly folder: WorkspaceFolderRef;
	readonly watcher: DisposableLike;
	cached: Promise<FolderProjectRules> | undefined;
}

/**
 * Loads `.ide-config.json` from the root of every workspace folder, keeps the
 * parsed result until the file changes, and tells listeners when it does.
 */
export class ProjectRulesLoader implements DisposableLike {

	private readonly entries = new Map<string, FolderEntry>();
	private readonly listeners = new Set<() => void>();
	private disposed = false;

	constructor(private readonly host: ProjectRulesHost) { }

	/**
	 * Sets the folders to read, in order. Watchers of removed folders are disposed.
	 */
	setFolders(folders: readonly WorkspaceFolderRef[]): void {
		if (this.disposed) {
			return;
		}

		const wanted = new Map(folders.map(folder => [folder.uri, folder]));
		for (const [uri, entry] of this.entries) {
			if (!wanted.has(uri)) {
				entry.watcher.dispose();
				this.entries.delete(uri);
			}
		}

		// Rebuild the map so iteration follows the new folder order.
		const previous = new Map(this.entries);
		this.entries.clear();
		for (const folder of folders) {
			const existing = previous.get(folder.uri);
			if (existing) {
				this.entries.set(folder.uri, existing);
				continue;
			}
			const entry: FolderEntry = {
				folder,
				cached: undefined,
				watcher: this.host.watchRulesFile(folder, () => {
					entry.cached = undefined;
					this.fireChange();
				}),
			};
			this.entries.set(folder.uri, entry);
		}
		this.fireChange();
	}

	/**
	 * The rules of every folder, in folder order. Unchanged files aren't re-read.
	 */
	getRules(): Promise<readonly FolderProjectRules[]> {
		return Promise.all([...this.entries.values()].map(entry => {
			entry.cached ??= this.read(entry.folder);
			return entry.cached;
		}));
	}

	/**
	 * Registers a listener for changes to the folders or their rules files.
	 */
	onDidChange(listener: () => void): DisposableLike {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	dispose(): void {
		this.disposed = true;
		for (const entry of this.entries.values()) {
			entry.watcher.dispose();
		}
		this.entries.clear();
		this.listeners.clear();
	}

	private async read(folder: WorkspaceFolderRef): Promise<FolderProjectRules> {
		let text: string | undefined;
		try {
			text = await this.host.readRulesFile(folder);
		} catch {
			return { folder, rules: undefined, problems: [{ code: 'unreadable' }] };
		}
		if (text === undefined) {
			return { folder, rules: undefined, problems: [] };
		}
		return { folder, ...parseProjectRules(text) };
	}

	private fireChange(): void {
		for (const listener of [...this.listeners]) {
			listener();
		}
	}
}
