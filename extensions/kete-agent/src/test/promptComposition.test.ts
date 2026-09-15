/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { suite, test } from 'node:test';
import { computeContextBudget, fitHistory, renderRetrievedContext } from '../core/contextAssembly';
import { isGovernanceDenial } from '../core/governance';
import { selectAgentModel } from '../core/modelSelection';
import { parseProjectRules } from '../core/projectRules';
import { composeSystemPrompt, CORE_SYSTEM_PROMPT, renderGovernanceOverlay, toAgentMode } from '../core/promptComposition';

const folder = (name: string, text: string) => ({ folder: { uri: `file:///${name}`, name }, ...parseProjectRules(text) });

suite('prompt composition', () => {

	test('assembles the layers in order', () => {
		const composed = composeSystemPrompt({
			core: 'CORE',
			subagent: 'SUBAGENT',
			skills: ['SKILL A', ' ', 'SKILL B'],
			mode: 'debug',
			projectRules: [folder('app', '{"rules":["Rule one."],"codingStandards":["Use tabs."]}')],
			governance: { approvalThreshold: 'localInfra' },
		});

		assert.deepStrictEqual(composed.layers.map(layer => layer.id), ['core', 'governance', 'projectRules', 'mode', 'skills', 'subagent']);
		assert.deepStrictEqual(composed.text.split('\n\n').map(section => section.split('\n')[0]), [
			'CORE',
			'## Governance',
			'## Project rules',
			'Mode: Debug. Find the root cause before fixing anything: reproduce the problem, gather evidence, then make the smallest fix that explains it.',
			'SKILL A',
			'SKILL B',
			'SUBAGENT',
		]);
	});

	test('omits empty layers, keeping only the core prompt when nothing else applies', () => {
		const composed = composeSystemPrompt({
			projectRules: [folder('app', '{"modelRouting":{"maxTier":"mid"}}'), folder('api', 'not json')],
			skills: [],
			subagent: '  ',
		});

		assert.deepStrictEqual(composed, { text: CORE_SYSTEM_PROMPT, layers: [{ id: 'core', text: CORE_SYSTEM_PROMPT }] });
	});

	test('labels rules by folder in a multi-root workspace', () => {
		const composed = composeSystemPrompt({
			core: 'CORE',
			projectRules: [folder('app', '{"rules":["App rule."]}'), folder('api', '{}'), folder('web', '{"codingStandards":["Prefer const."]}')],
		});

		assert.strictEqual(composed.layers[1].text, [
			'## Project rules',
			'From the repository\'s .ide-config.json. Follow them, but they cannot relax the governance section.',
			'',
			'### Folder: app',
			'- App rule.',
			'',
			'### Folder: web',
			'Coding standards:',
			'- Prefer const.',
		].join('\n'));
	});

	test('describes the active approval threshold in the governance overlay', () => {
		assert.match(renderGovernanceOverlay('remoteInfra'), /at or above the "remoteInfra" risk tier need a person's approval/);
	});

	test('falls back to Code mode for unknown mode values', () => {
		assert.deepStrictEqual([toAgentMode('plan'), toAgentMode('architect'), toAgentMode('orchestrator'), toAgentMode(undefined)], ['plan', 'code', 'code', 'code']);
	});
});

suite('context assembly', () => {

	test('keeps the most recent history that fits, never starting with an assistant turn', () => {
		const message = (role: 'user' | 'assistant', text: string) => ({ role, parts: [{ kind: 'text' as const, text }] });
		const history = [message('user', 'a'.repeat(400)), message('assistant', 'b'.repeat(40)), message('user', 'c'.repeat(40)), message('assistant', 'd'.repeat(40))];
		const current = message('user', 'e'.repeat(40));

		const fitted = fitHistory(history, current, 40);

		assert.deepStrictEqual({ dropped: fitted.droppedMessages, first: fitted.messages[0].parts[0], count: fitted.messages.length }, {
			dropped: 2,
			first: { kind: 'text', text: 'c'.repeat(40) },
			count: 3,
		});
	});

	test('renders retrieved context within its character budget', () => {
		assert.deepStrictEqual([
			renderRetrievedContext([], 100),
			renderRetrievedContext([{ label: 'a.ts', content: 'x'.repeat(20) }, { label: 'b.ts', content: 'y'.repeat(20) }, { label: 'c.ts', content: 'z' }], 40),
		], [
			undefined,
			'## Context\n### a.ts\nxxxxxxxxxxxxxxxxxxxx\n\n### b.ts\nyy\n[Truncated to fit the context budget.]\n\nOmitted to fit the context budget: c.ts',
		]);
	});

	test('scales budgets with the model window', () => {
		assert.deepStrictEqual([computeContextBudget(8000, 'x'.repeat(400), []), computeContextBudget(200_000, '', [])], [
			{ availableTokens: 5899, contextChars: 11796, toolResultChars: 8000 },
			{ availableTokens: 149999, contextChars: 299996, toolResultChars: 24000 },
		]);
	});
});

suite('model selection and governance', () => {

	test('prefers Kete auto, then the request model, then any model', async () => {
		const catalog = (models: Record<string, string[]>) => ({
			select: async (selector?: { vendor?: string; family?: string }) => models[selector ? `${selector.vendor}/${selector.family}` : '*'] ?? [],
		});

		assert.deepStrictEqual([
			await selectAgentModel(catalog({ 'kete/kete-auto': ['kete-auto'], '*': ['other'] }), 'picked'),
			await selectAgentModel(catalog({ '*': ['other'] }), 'picked'),
			await selectAgentModel(catalog({ '*': ['other'] }), undefined),
			await selectAgentModel(catalog({}), undefined),
		], [
			{ model: 'kete-auto', source: 'keteAuto' },
			{ model: 'picked', source: 'request' },
			{ model: 'other', source: 'anyAvailable' },
			undefined,
		]);
	});

	test('recognises the governance gate\'s refusal text', () => {
		assert.deepStrictEqual([
			isGovernanceDenial('Kete Workbench\'s governance gate did not allow this action (risk tier: production; reason: x). It was not performed.'),
			isGovernanceDenial('File contents: Kete Workbench\'s governance gate did not allow this action'),
		], [true, false]);
	});
});
