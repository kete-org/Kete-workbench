/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Usage: node generate-icons.ts
//
// Regenerates every application icon in resources/ from the single master at
// resources/kete-icon.svg, so the mark is edited in one place and never
// per-platform by hand. Run it after changing that file, and commit what it
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
