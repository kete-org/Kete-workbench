/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Usage: node generate-icons.ts
//
// Regenerates every application icon in resources/ from the single master at
// resources/kete-icon.svg, and the per-language document icons from the table
// below, so the artwork is edited in one place and never per-platform by hand. Run it after changing that file, and commit what it
// writes — CI builds packages from the committed icons, it does not run this.
//
// Two masters: kete-icon.svg, and kete-icon-small.svg for targets 32 px and
// under, where the full weave silts up.
//
// Rasterizing: Chromium, from the repo's own node_modules, because no SVG
// rasterizer (rsvg, ImageMagick, Inkscape) is assumed to be installed and
// Chromium renders the SVG the same way the editor would. macOS only, for the
// moment: .icns needs `iconutil`, and the installer bitmaps use `sips`. Set
// CHROME_PATH to override the browser binary.

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium, type Browser, type Page } from 'playwright-core';

const root = import.meta.dirname;
const master = path.join(root, 'resources', 'kete-icon.svg');
const masterSmall = path.join(root, 'resources', 'kete-icon-small.svg');

/**
 * At and below this size the full weave has more edges than pixels to draw
 * them, so the simplified mark is used instead.
 */
const SMALL_SIZE_LIMIT = 32;
const GROUND = '#14161C';

/** Sizes macOS wants in an .iconset, as `<file name>: <pixels>`. */
const ICONSET: ReadonlyArray<readonly [string, number]> = [
	['icon_16x16.png', 16],
	['icon_16x16@2x.png', 32],
	['icon_32x32.png', 32],
	['icon_32x32@2x.png', 64],
	['icon_128x128.png', 128],
	['icon_128x128@2x.png', 256],
	['icon_256x256.png', 256],
	['icon_256x256@2x.png', 512],
	['icon_512x512.png', 512],
	['icon_512x512@2x.png', 1024],
];

/** Sizes inside a Windows .ico. 256 is the largest Windows reads. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const FAVICON_SIZES = [16, 32, 48];

/** Document icons stop at 512: nothing shows a file icon larger than that. */
const FILE_ICONSET = ICONSET.filter(([, size]) => size <= 512);

/**
 * The document icons, one per file type the fork registers. Each is the
 * language's own colour — the one its community already uses — over a plain
 * sheet, with Kete's mark as the badge. Upstream's versions carry the VS Code
 * logo in that corner, which is Microsoft's trademark and not ours to ship.
 *
 * `bat` has no .ico upstream, so it gets no .ico here: these replace what the
 * fork already ships rather than adding assets nothing references.
 */
const FILE_TYPES: ReadonlyArray<{ readonly name: string; readonly label: string; readonly colour: string; readonly windows?: false }> = [
	{ name: 'bat', label: 'BAT', colour: '#4EAA25', windows: false },
	{ name: 'bower', label: 'BOW', colour: '#EF5734' },
	{ name: 'c', label: 'C', colour: '#5C6BC0' },
	{ name: 'config', label: 'CFG', colour: '#8E9BA6' },
	{ name: 'cpp', label: 'C++', colour: '#00599C' },
	{ name: 'csharp', label: 'C#', colour: '#68217A' },
	{ name: 'css', label: 'CSS', colour: '#2965F1' },
	{ name: 'default', label: '', colour: '#8E9BA6' },
	{ name: 'go', label: 'GO', colour: '#00ADD8' },
	{ name: 'html', label: 'HTML', colour: '#E34F26' },
	{ name: 'jade', label: 'PUG', colour: '#A86454' },
	{ name: 'java', label: 'JAVA', colour: '#EA2D2E' },
	{ name: 'javascript', label: 'JS', colour: '#C9A227' },
	{ name: 'json', label: 'JSON', colour: '#A08B2A' },
	{ name: 'less', label: 'LESS', colour: '#1D365D' },
	{ name: 'markdown', label: 'MD', colour: '#42A5F5' },
	{ name: 'php', label: 'PHP', colour: '#777BB4' },
	{ name: 'powershell', label: 'PS', colour: '#1B4F8A' },
	{ name: 'python', label: 'PY', colour: '#3776AB' },
	{ name: 'react', label: 'JSX', colour: '#149ECA' },
	{ name: 'ruby', label: 'RB', colour: '#CC342D' },
	{ name: 'sass', label: 'SASS', colour: '#CF649A' },
	{ name: 'shell', label: 'SH', colour: '#4EAA25' },
	{ name: 'sql', label: 'SQL', colour: '#E38C00' },
	{ name: 'typescript', label: 'TS', colour: '#3178C6' },
	{ name: 'vue', label: 'VUE', colour: '#41B883' },
	{ name: 'xml', label: 'XML', colour: '#F1662A' },
	{ name: 'yaml', label: 'YAML', colour: '#CB171E' },
];

/**
 * The Inno Setup wizard bitmaps, per DPI scaling. Inno takes no alpha, so these
 * render on an opaque ground.
 */
const INNO_BIG: ReadonlyArray<readonly [string, number, number]> = [
	['inno-big-100.bmp', 164, 314],
	['inno-big-125.bmp', 192, 386],
	['inno-big-150.bmp', 246, 459],
	['inno-big-175.bmp', 273, 556],
	['inno-big-200.bmp', 328, 604],
	['inno-big-225.bmp', 355, 700],
	['inno-big-250.bmp', 410, 797],
];
const INNO_SMALL: ReadonlyArray<readonly [string, number, number]> = [
	['inno-small-100.bmp', 55, 55],
	['inno-small-125.bmp', 64, 68],
	['inno-small-150.bmp', 83, 80],
	['inno-small-175.bmp', 92, 97],
	['inno-small-200.bmp', 110, 106],
	['inno-small-225.bmp', 119, 123],
	['inno-small-250.bmp', 138, 140],
];

/** Renders SVG markup to PNG files at exact pixel sizes. */
class Renderer {
	private browser!: Browser;
	private page!: Page;

	async start(): Promise<void> {
		this.browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
		this.page = await this.browser.newPage();
	}

	async stop(): Promise<void> {
		await this.browser.close();
	}

	/** Writes `svg` to `out` at `width`×`height`, keeping transparency. */
	async toPng(svg: string, width: number, height: number, out: string, opaque = false): Promise<void> {
		await this.page.setViewportSize({ width, height });
		await this.page.setContent(
			`<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>${svg}`,
			{ waitUntil: 'load' },
		);
		await this.page.screenshot({ path: out, omitBackground: !opaque, clip: { x: 0, y: 0, width, height } });
	}
}

/** The master mark, sized to fill a square of `size`. */
function squareMark(svgSource: string, size: number): string {
	return svgSource.replace('width="1024" height="1024"', `width="${size}" height="${size}"`);
}

/**
 * A document icon: a sheet with a folded corner, the file type's label, and
 * Kete's mark badged in the corner.
 *
 * Below 64 px the label and the badge are dropped for a colour band. Four
 * letters cannot be drawn in 16 pixels, and a smear of grey where text should
 * be reads worse than no text at all; the colour is what people actually pick
 * the file out by at that size.
 */
function documentIcon(label: string, colour: string, size: number): string {
	const detailed = size >= 64;
	const sheet = `
		<path d="M 168 72 h 448 l 240 240 v 640 a 48 48 0 0 1 -48 48 H 168 a 48 48 0 0 1 -48 -48 V 120 a 48 48 0 0 1 48 -48 Z" fill="#F4F1EA"/>
		<path d="M 616 72 l 240 240 H 664 a 48 48 0 0 1 -48 -48 Z" fill="#D9D3C7"/>`;

	if (!detailed) {
		// One band of the language's colour, sized to stay visible at 16 px.
		return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="${size}" height="${size}">
			${sheet}
			<rect x="120" y="560" width="736" height="264" fill="${colour}"/>
			<rect x="120" y="824" width="736" height="136" fill="#14161C"/>
		</svg>`;
	}

	// The label sits above the badge, never beside it: four letters at this
	// weight are wider than the space left of the badge, and an overlapping
	// badge silently ate the last character of HTML, JSON and JAVA.
	const text = label
		? `<text x="488" y="430" font-family="system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif" font-weight="700" font-size="${label.length >= 4 ? 190 : label.length === 3 ? 235 : 290}" fill="${colour}" text-anchor="middle" dominant-baseline="middle">${label}</text>`
		: `<rect x="250" y="390" width="400" height="60" rx="30" fill="${colour}"/>
		<rect x="250" y="500" width="290" height="60" rx="30" fill="${colour}" opacity="0.55"/>`;

	// Kete's mark, badged where upstream badges the VS Code logo.
	const badge = `
		<g transform="translate(580 612) scale(0.40)">
			<rect x="0" y="0" width="1024" height="1024" rx="180" fill="#14161C"/>
			<rect x="288" y="150" width="176" height="724" rx="30" fill="#E9A73C"/>
			<rect x="560" y="150" width="176" height="724" rx="30" fill="#E9A73C"/>
			<rect x="150" y="288" width="724" height="176" rx="30" fill="#0F8A62"/>
			<rect x="150" y="560" width="724" height="176" rx="30" fill="#0F8A62"/>
			<rect x="288" y="288" width="176" height="176" fill="#E9A73C"/>
			<rect x="560" y="560" width="176" height="176" fill="#E9A73C"/>
		</g>`;

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="${size}" height="${size}">
		${sheet}
		${text}
		${badge}
	</svg>`;
}

/**
 * The mark centred on an opaque ground, for the installer bitmaps, which are
 * not square and cannot carry transparency.
 */
function bannerMark(svgSource: string, width: number, height: number): string {
	const mark = Math.round(Math.min(width, height) * 0.62);
	const x = Math.round((width - mark) / 2);
	const y = Math.round((height - mark) / 2);
	const inner = svgSource
		.replace(/<\?xml[^>]*\?>/, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace('<svg', `<svg x="${x}" y="${y}"`)
		.replace('width="1024" height="1024"', `width="${mark}" height="${mark}"`);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
		<rect x="0" y="0" width="${width}" height="${height}" fill="${GROUND}"/>
		${inner}
	</svg>`;
}

/**
 * Packs PNGs into an .ico. Windows has read PNG-compressed icon entries since
 * Vista, which keeps the 256 px entry from dominating the file size.
 */
function buildIco(pngs: readonly Buffer[], sizes: readonly number[]): Buffer {
	const header = Buffer.alloc(6);
	header.writeUInt16LE(0, 0);             // reserved
	header.writeUInt16LE(1, 2);             // 1 = icon
	header.writeUInt16LE(pngs.length, 4);

	const directory = Buffer.alloc(16 * pngs.length);
	let offset = header.length + directory.length;
	pngs.forEach((png, index) => {
		const size = sizes[index];
		const entry = index * 16;
		directory.writeUInt8(size >= 256 ? 0 : size, entry);      // 0 means 256
		directory.writeUInt8(size >= 256 ? 0 : size, entry + 1);
		directory.writeUInt8(0, entry + 2);                       // palette colours
		directory.writeUInt8(0, entry + 3);                       // reserved
		directory.writeUInt16LE(1, entry + 4);                    // colour planes
		directory.writeUInt16LE(32, entry + 6);                   // bits per pixel
		directory.writeUInt32LE(png.length, entry + 8);
		directory.writeUInt32LE(offset, entry + 12);
		offset += png.length;
	});

	return Buffer.concat([header, directory, ...pngs]);
}

async function main(): Promise<void> {
	const svgSource = fs.readFileSync(master, 'utf8');
	const smallSource = fs.readFileSync(masterSmall, 'utf8');
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kete-icons-'));
	const renderer = new Renderer();
	await renderer.start();
	const written: string[] = [];

	const png = async (size: number, out: string, opaque = false) => {
		const source = size <= SMALL_SIZE_LIMIT ? smallSource : svgSource;
		await renderer.toPng(squareMark(source, size), size, size, out, opaque);
	};
	const record = (file: string) => written.push(path.relative(root, file));

	try {
		// macOS .icns, assembled by iconutil from an .iconset directory.
		const iconset = path.join(temp, 'code.iconset');
		fs.mkdirSync(iconset);
		for (const [name, size] of ICONSET) {
			await png(size, path.join(iconset, name));
		}
		const icns = path.join(root, 'resources', 'darwin', 'code.icns');
		execFileSync('iconutil', ['--convert', 'icns', '--output', icns, iconset]);
		record(icns);

		// Windows .ico, tiles and the Linux and server PNGs.
		const icoPngs: Buffer[] = [];
		for (const size of ICO_SIZES) {
			const file = path.join(temp, `ico-${size}.png`);
			await png(size, file);
			icoPngs.push(fs.readFileSync(file));
		}
		const ico = path.join(root, 'resources', 'win32', 'code.ico');
		fs.writeFileSync(ico, buildIco(icoPngs, ICO_SIZES));
		record(ico);

		const faviconPngs: Buffer[] = [];
		for (const size of FAVICON_SIZES) {
			const file = path.join(temp, `favicon-${size}.png`);
			await png(size, file);
			faviconPngs.push(fs.readFileSync(file));
		}
		const favicon = path.join(root, 'resources', 'server', 'favicon.ico');
		fs.writeFileSync(favicon, buildIco(faviconPngs, FAVICON_SIZES));
		record(favicon);

		const squares: ReadonlyArray<readonly [string, number]> = [
			[path.join(root, 'resources', 'win32', 'code_70x70.png'), 70],
			[path.join(root, 'resources', 'win32', 'code_150x150.png'), 150],
			[path.join(root, 'resources', 'linux', 'code.png'), 1024],
			[path.join(root, 'resources', 'server', 'code-192.png'), 192],
			[path.join(root, 'resources', 'server', 'code-512.png'), 512],
		];
		for (const [file, size] of squares) {
			await png(size, file);
			record(file);
		}

		// Document icons, one .icns and (where upstream ships one) one .ico each.
		for (const fileType of FILE_TYPES) {
			const typeIconset = path.join(temp, `${fileType.name}.iconset`);
			fs.mkdirSync(typeIconset);
			for (const [entry, size] of FILE_ICONSET) {
				await renderer.toPng(documentIcon(fileType.label, fileType.colour, size), size, size, path.join(typeIconset, entry));
			}
			const typeIcns = path.join(root, 'resources', 'darwin', `${fileType.name}.icns`);
			execFileSync('iconutil', ['--convert', 'icns', '--output', typeIcns, typeIconset]);
			record(typeIcns);

			if (fileType.windows !== false) {
				const entries: Buffer[] = [];
				for (const size of ICO_SIZES) {
					const file = path.join(temp, `${fileType.name}-${size}.png`);
					await renderer.toPng(documentIcon(fileType.label, fileType.colour, size), size, size, file);
					entries.push(fs.readFileSync(file));
				}
				const typeIco = path.join(root, 'resources', 'win32', `${fileType.name}.ico`);
				fs.writeFileSync(typeIco, buildIco(entries, ICO_SIZES));
				record(typeIco);
			}
		}

		// Installer bitmaps: rendered opaque, then converted by sips, because
		// Chromium writes no BMP.
		for (const [name, width, height] of [...INNO_BIG, ...INNO_SMALL]) {
			const source = path.join(temp, `${name}.png`);
			await renderer.toPng(bannerMark(svgSource, width, height), width, height, source, true);
			const bmp = path.join(root, 'resources', 'win32', name);
			execFileSync('sips', ['--setProperty', 'format', 'bmp', source, '--out', bmp], { stdio: 'ignore' });
			record(bmp);
		}
	} finally {
		await renderer.stop();
		fs.rmSync(temp, { recursive: true, force: true });
	}

	console.log(`Wrote ${written.length} icon files from ${path.relative(root, master)}:`);
	for (const file of written) {
		console.log(`  ${file}`);
	}
}

await main();
