/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { registerKeteParticipants } from './vscode/participant';
import { createProjectRulesLoader } from './vscode/projectRulesHost';

/**
 * Activates the Kete agent: loads project rules and registers the chat
 * participants. The agent loop itself lives in `core/`, which has no VS Code
 * dependency (D-010).
 */
export function activate(context: vscode.ExtensionContext): void {
	const { loader, disposable } = createProjectRulesLoader();
	context.subscriptions.push(disposable, registerKeteParticipants(loader));
}

export function deactivate(): void { }
