/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { suite, test } from 'node:test';
import { DisposableLike } from '../core/agentTypes';
import { mergeRoutingHints, toRouterHints } from '../core/modelSelection';
import { MAX_PROJECT_RULES_FILE_CHARS, parseProjectRules } from '../core/projectRules';
import { ProjectRulesHost, ProjectRulesLoader, WorkspaceFolderRef } from '../core/projectRulesLoader';

/** An in-memory file system with manually fired watchers. */
class FakeHost implements ProjectRulesHost {
	readonly files = new Map<string, string>();
	readonly reads: string[] = [];
	readonly watchers = new Map<string, () => void>();
	unreadable = new Set<string>();

	async readRulesFile(folder: WorkspaceFolderRef): Promise<string | undefined> {
		this.reads.push(folder.name);
		if (this.unreadable.has(folder.uri)) {
			throw new Error('EACCES');
		}
		return this.files.get(folder.uri);
	}

	watchRulesFile(folder: WorkspaceFolderRef, onChange: () => void): DisposableLike {
		this.watchers.set(folder.uri, onChange);
		return { dispose: () => this.watchers.delete(folder.uri) };
	}
}

const app: WorkspaceFolderRef = { uri: 'file:///app', name: 'app' };
const api: WorkspaceFolderRef = { uri: 'file:///api', name: 'api' };

suite('project rules file', () => {

	test('reads rules, coding standards and routing hints from a valid file', () => {
		const result = parseProjectRules(JSON.stringify({
			$schema: './schema.json',
			version: 1,
			rules: ['Never edit generated files.', '  Keep\nchanges small.  ', ''],
			codingStandards: ['Use tabs.'],
			modelRouting: { preferredTier: 'local', maxTier: 'mid' },
		}));

		assert.deepStrictEqual(result, {
			rules: {
				rules: ['Never edit generated files.', 'Keep changes small.'],
				codingStandards: ['Use tabs.'],
				modelRouting: { preferredTier: 'local', maxTier: 'mid' },
			},
			problems: [],
		});
	});

	test('ignores governance keys and unknown keys, reporting them separately', () => {
		const result = parseProjectRules(JSON.stringify({
			rules: ['Be careful.'],
			governance: { enabled: false },
			approvalThreshold: 'production',
			'kete.governance.approvalThreshold': 'production',
			autoApprove: true,
			theme: 'dark',
			modelRouting: { maxTier: 'frontier', permissions: 'allow' },
		}));

		assert.deepStrictEqual(result, {
			rules: { rules: ['Be careful.'], codingStandards: [], modelRouting: { maxTier: 'frontier' } },
			problems: [
				{ code: 'governanceKeyIgnored', path: 'governance' },
				{ code: 'governanceKeyIgnored', path: 'approvalThreshold' },
				{ code: 'governanceKeyIgnored', path: 'kete.governance.approvalThreshold' },
				{ code: 'governanceKeyIgnored', path: 'autoApprove' },
				{ code: 'unknownKeyIgnored', path: 'theme' },
				{ code: 'governanceKeyIgnored', path: 'modelRouting.permissions' },
			],
		});
	});

	test('reports invalid files and values', () => {
		assert.deepStrictEqual([
			parseProjectRules('{ "rules": [ // comment\n] }'),
			parseProjectRules('["a"]'),
			parseProjectRules(' '.repeat(MAX_PROJECT_RULES_FILE_CHARS + 1)),
			parseProjectRules(JSON.stringify({ version: 2, rules: 'one rule', codingStandards: ['ok', 3], modelRouting: { preferredTier: 'frontier', maxTier: 'local' } })),
			parseProjectRules(JSON.stringify({ modelRouting: { maxTier: 'huge' } })),
		], [
			{ rules: undefined, problems: [{ code: 'invalidJson' }] },
			{ rules: undefined, problems: [{ code: 'notAnObject' }] },
			{ rules: undefined, problems: [{ code: 'tooLarge' }] },
			{
				rules: { rules: [], codingStandards: ['ok'], modelRouting: { preferredTier: 'local', maxTier: 'local' } },
				problems: [
					{ code: 'unsupportedVersion', path: 'version' },
					{ code: 'invalidValue', path: 'rules' },
					{ code: 'invalidValue', path: 'codingStandards[1]' },
					{ code: 'preferredTierAboveMaxTier', path: 'modelRouting.preferredTier' },
				],
			},
			{ rules: { rules: [], codingStandards: [] }, problems: [{ code: 'invalidValue', path: 'modelRouting.maxTier' }] },
		]);
	});

	test('merges routing hints across folders, keeping the lowest tiers', () => {
		const folder = (name: string, text: string) => ({ folder: { uri: `file:///${name}`, name }, ...parseProjectRules(text) });

		assert.deepStrictEqual([
			mergeRoutingHints([folder('a', '{"modelRouting":{"preferredTier":"mid","maxTier":"frontier"}}'), folder('b', '{"modelRouting":{"maxTier":"local"}}')]),
			mergeRoutingHints([folder('a', '{"rules":["x"]}')]),
		], [
			{ preferredTier: 'local', maxTier: 'local' },
			undefined,
		]);
	});

	test('only a project\'s maxTier cap reaches the router, never its preferredTier', () => {
		assert.deepStrictEqual([
			toRouterHints({ preferredTier: 'frontier', maxTier: 'mid' }),
			toRouterHints({ preferredTier: 'frontier' }),
			toRouterHints(undefined),
		], [
			{ maxTier: 'mid' },
			undefined,
			undefined,
		]);
	});
});

suite('project rules loader', () => {

	test('loads each folder of a multi-root workspace, in order', async () => {
		const host = new FakeHost();
		host.files.set(app.uri, '{"rules":["App rule."]}');
		host.files.set(api.uri, 'not json');
		const loader = new ProjectRulesLoader(host);
		const docs: WorkspaceFolderRef = { uri: 'file:///docs', name: 'docs' };
		host.unreadable.add(docs.uri);

		loader.setFolders([app, api, docs, { uri: 'file:///empty', name: 'empty' }]);

		assert.deepStrictEqual(await loader.getRules(), [
			{ folder: app, rules: { rules: ['App rule.'], codingStandards: [] }, problems: [] },
			{ folder: api, rules: undefined, problems: [{ code: 'invalidJson' }] },
			{ folder: docs, rules: undefined, problems: [{ code: 'unreadable' }] },
			{ folder: { uri: 'file:///empty', name: 'empty' }, rules: undefined, problems: [] },
		]);
		loader.dispose();
	});

	test('caches rules until the file changes, and follows folder changes', async () => {
		const host = new FakeHost();
		host.files.set(app.uri, '{"rules":["First."]}');
		const loader = new ProjectRulesLoader(host);
		let changes = 0;
		loader.onDidChange(() => changes++);

		loader.setFolders([app]);
		await loader.getRules();
		await loader.getRules();
		host.files.set(app.uri, '{"rules":["Second."]}');
		host.watchers.get(app.uri)!();
		const afterChange = await loader.getRules();
		loader.setFolders([api]);
		const watchedAfterRemoval = [...host.watchers.keys()];
		loader.dispose();

		assert.deepStrictEqual({
			reads: host.reads,
			rules: afterChange.map(folder => folder.rules?.rules),
			changes,
			watchedAfterRemoval,
			watchedAfterDispose: [...host.watchers.keys()],
		}, {
			reads: ['app', 'app'],
			rules: [['Second.']],
			changes: 3,
			watchedAfterRemoval: [api.uri],
			watchedAfterDispose: [],
		});
	});
});
