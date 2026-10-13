// Exports the server leaves to the browser (`client: true` in the registry): SVG and PNG of a
// diagram, PNG of an image. PDF of a document is not offered yet.
import { downloadBlob } from './download.js';
import { svgToPng } from './download.js';
import { loadText, type ViewerInput } from './input.js';
import { renderMermaid } from './mermaid.js';

const SUPPORTED: Record<string, string[]> = { mermaid: ['svg', 'png'], image: ['png'] };

export const clientExportSupported = (kind: string, format: string): boolean => SUPPORTED[kind]?.includes(format) ?? false;

async function rasterToPng(url: string): Promise<Blob> {
	const res = await fetch(url, { credentials: 'omit' });
	if (!res.ok) throw new Error(`Could not load the image (${res.status})`);
	const bitmap = await createImageBitmap(await res.blob());
	const canvas = document.createElement('canvas');
	canvas.width = bitmap.width;
	canvas.height = bitmap.height;
	canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
	return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not make the PNG'))), 'image/png'));
}

/** Make the export in the browser and download it. */
export async function runClientExport(kind: string, format: string, input: ViewerInput): Promise<void> {
	const stem = input.title.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'export';
	if (kind === 'mermaid') {
		const svg = await renderMermaid(await loadText(input), false);
		if (format === 'svg') return downloadBlob(`${stem}.svg`, new Blob([svg], { type: 'image/svg+xml' }));
		return downloadBlob(`${stem}.png`, await svgToPng(svg));
	}
	if (kind === 'image' && format === 'png') {
		const isSvg = /\.svg$/i.test(input.name);
		return downloadBlob(`${stem}.png`, isSvg ? await svgToPng(await loadText(input)) : await rasterToPng(await input.url!()));
	}
	throw new Error('This export is not available in the browser');
}
