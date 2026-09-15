/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PROJECT_RULES_FILE_NAME } from '../core/projectRules';
import { ProjectRulesHost, ProjectRulesLoader, WorkspaceFolderRef } from '../core/projectRulesLoader';

/**
 * Reads and watches `.ide-config.json` through `vscode.workspace`. Reads only.
 */
class VsCodeProjectRulesHost implements ProjectRulesHost {

	private readonly decoder = new TextDecoder();

	async readRulesFile(folder: WorkspaceFolderRef): Promise<string | undefined> {
		const uri = rulesFileUri(folder);
		try {
			return this.decoder.decode(await vscode.workspace.fs.readFile(uri));
		} catch (error) {
			if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
				return undefined;
			}
			throw error;
		}
	}

	watchRulesFile(folder: WorkspaceFolderRef, onChange: () => void): vscode.Disposable {
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.parse(folder.uri), PROJECT_RULES_FILE_NAME));
		return vscode.Disposable.from(
			watcher,
			watcher.onDidCreate(onChange),
			watcher.onDidChange(onChange),
			watcher.onDidDelete(onChange),
		);
	}
}

/**
 * The URI of a folder's rules file.
 */
export function rulesFileUri(folder: WorkspaceFolderRef): vscode.Uri {
	return vscode.Uri.joinPath(vscode.Uri.parse(folder.uri), PROJECT_RULES_FILE_NAME);
}

/**
 * Creates a loader that follows the workspace folders. A repository's rules are
 * prompt content, so they are only read once the workspace is trusted.
 */
export function createProjectRulesLoader(): { readonly loader: ProjectRulesLoader; readonly disposable: vscode.Disposable } {
	const loader = new ProjectRulesLoader(new VsCodeProjectRulesHost());
	const update = () => loader.setFolders(vscode.workspace.isTrusted
		? (vscode.workspace.workspaceFolders ?? []).map(folder => ({ uri: folder.uri.toString(), name: folder.name }))
		: []);
	update();

	return {
		loader,
		disposable: vscode.Disposable.from(
			loader,
			vscode.workspace.onDidChangeWorkspaceFolders(update),
			vscode.workspace.onDidGrantWorkspaceTrust(update),
		),
	};
}
