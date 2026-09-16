/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Usage: node apply-product-json.ts [path/to/product.json]
//
// Re-applies Kete Workbench's product identity after an upstream sync has
// overwritten product.json. Patches by key, not by line, so it works however
// upstream's surrounding keys change. Running it on an already-branded file
// changes nothing.
//
// These values are the ones recorded in DECISIONS.md (D-004). They are written
// to users' machines, so once builds are distributed, changing one needs a
// migration path, not just an edit here.

import fs from 'fs';

const productPath = process.argv[2] ?? 'product.json';
const repository = 'https://github.com/kete-org/Kete-workbench';

const identity: Record<string, unknown> = {
	nameShort: 'Kete Workbench',
	nameLong: 'Kete Workbench',
	applicationName: 'kete-workbench',
	dataFolderName: '.kete-workbench',
	sharedDataFolderName: '.kete-workbench-shared',
	win32MutexName: 'keteworkbench',
	licenseUrl: `${repository}/blob/main/LICENSE.txt`,
	serverLicenseUrl: `${repository}/blob/main/LICENSE.txt`,
	serverApplicationName: 'kete-workbench-server',
	serverDataFolderName: '.kete-workbench-server',
	tunnelApplicationName: 'kete-workbench-tunnel',
	win32DirName: 'Kete Workbench',
	win32NameVersion: 'Kete Workbench',
	win32RegValueName: 'KeteWorkbench',
	win32x64AppId: '{{6A662063-9A33-46C7-927E-F36ECFB08984}',
	win32arm64AppId: '{{E406A207-DEF6-4257-8B92-27898CDD1936}',
	win32x64UserAppId: '{{E1EA357E-8A6B-46B4-A67E-061AB88316D5}',
	win32arm64UserAppId: '{{A4100697-B6D9-4BDC-B37A-04B65F1F7D98}',
	win32AppUserModelId: 'KeteWorkbench.KeteWorkbench',
	win32ShellNameShort: '&Kete Workbench',
	win32TunnelServiceMutex: 'keteworkbench-tunnelservice',
	win32TunnelMutex: 'keteworkbench-tunnel',
	darwinBundleIdentifier: 'dev.keteworkbench.desktop',
	darwinProfileUUID: '76C33317-B5A7-49B6-92AE-CBBB03651AD1',
	darwinProfilePayloadUUID: '53DF3A6B-3BA5-4CD9-9DDC-BDFBC94383FF',
	linuxIconName: 'kete-workbench',
	reportIssueUrl: `${repository}/issues/new`,
	urlProtocol: 'kete-workbench',
	// Microsoft's marketplace terms don't permit forks (D-002).
	extensionsGallery: {
		serviceUrl: 'https://open-vsx.org/vscode/gallery',
		itemUrl: 'https://open-vsx.org/vscode/item',
	},
	enableTelemetry: false,
};

// Microsoft-specific endpoints that must not come back (CLAUDE.md hard rules),
// and the Copilot default chat agent, whose absence switches off Copilot's
// setup, sign-in and entitlement flows so @kete is the default (D-019).
//
// `voiceWsUrl` pointed at a Microsoft voice service and `webviewContentExternalBaseUrlTemplate`
// at Microsoft's CDN. Both are optional: without them the voice feature reports
// that no endpoint is configured, and desktop webviews are served locally as
// before. A web build would still fall back to the CDN through a default in
// `environmentService.ts`, which is upstream code, not our configuration —
// replacing that is part of shipping a web surface (D-022, Phase 6).
const removedKeys = ['aiConfig', 'crashReporter', 'updateUrl', 'defaultChatAgent', 'voiceWsUrl', 'webviewContentExternalBaseUrlTemplate'];

const original = fs.readFileSync(productPath, 'utf8');
const product: Record<string, unknown> = JSON.parse(original);
const changes: string[] = [];

for (const [key, value] of Object.entries(identity)) {
	if (JSON.stringify(product[key]) !== JSON.stringify(value)) {
		product[key] = value;
		changes.push(`set ${key}`);
	}
}
for (const key of removedKeys) {
	if (Object.hasOwn(product, key)) {
		delete product[key];
		changes.push(`removed ${key}`);
	}
}

if (changes.length === 0) {
	console.log(`${productPath} already carries the Kete Workbench identity; nothing to do.`);
} else {
	fs.writeFileSync(`${productPath}.bak`, original);
	// Upstream writes product.json as JSON.stringify(obj, null, '\t'); keeping that
	// format keeps upstream merges small (D-001).
	fs.writeFileSync(productPath, JSON.stringify(product, null, '\t') + '\n');
	console.log(`Patched ${productPath} (original saved to ${productPath}.bak):`);
	for (const change of changes) {
		console.log(`  ${change}`);
	}
}

console.log('Icons are generated from resources/kete-icon.svg: run `node generate-icons.ts` if they need rebuilding (D-021).');
