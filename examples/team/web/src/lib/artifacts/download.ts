// Browser-side downloads and image conversion shared by the viewers.
export function downloadBlob(name: string, blob: Blob): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const downloadText = (name: string, text: string, mime = 'text/plain'): void => downloadBlob(name, new Blob([text], { type: `${mime};charset=utf-8` }));

function svgSize(svg: string): { w: number; h: number } {
	const vb = /viewBox="([\d.\s-]+)"/.exec(svg)?.[1]?.trim().split(/\s+/).map(Number);
	const w = Number(/<svg[^>]*\swidth="([\d.]+)(?:px)?"/.exec(svg)?.[1]);
	const h = Number(/<svg[^>]*\sheight="([\d.]+)(?:px)?"/.exec(svg)?.[1]);
	if (w > 0 && h > 0) return { w, h };
	if (vb && vb.length === 4 && vb[2]! > 0 && vb[3]! > 0) return { w: vb[2]!, h: vb[3]! };
	return { w: 800, h: 600 };
}

/** Rasterise an SVG string to a PNG (white background, 2x) through a canvas. */
export async function svgToPng(svg: string, scale = 2): Promise<Blob> {
	const { w, h } = svgSize(svg);
	const withNs = /xmlns=/.test(svg) ? svg : svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
	const img = new Image();
	img.decoding = 'async';
	await new Promise<void>((resolve, reject) => {
		img.onload = () => resolve();
		img.onerror = () => reject(new Error('Could not draw the SVG'));
		img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withNs)}`;
	});
	const canvas = document.createElement('canvas');
	canvas.width = Math.ceil(w * scale);
	canvas.height = Math.ceil(h * scale);
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('Canvas is not available');
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
	return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not make the PNG'))), 'image/png'));
}

export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}
