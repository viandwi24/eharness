// Copy to the clipboard on every deployment. `navigator.clipboard` exists only in a secure context
// (HTTPS or localhost): a team server reached over plain `http://` (a bare IP, sslip.io) has none,
// so the legacy `execCommand('copy')` on a hidden textarea is the fallback there.

/** Copy `text`; true when it reached the clipboard. Call it from a click (user activation). */
export async function copyText(text: string): Promise<boolean> {
	if (typeof window !== 'undefined' && window.isSecureContext && navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// denied (permissions policy, an iframe): try the fallback
		}
	}
	return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
	if (typeof document === 'undefined') return false;
	const area = document.createElement('textarea');
	area.value = text;
	area.setAttribute('readonly', '');
	// off screen, no zoom on iOS (font-size >= 16px), no scroll jump
	area.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;font-size:16px';
	const active = document.activeElement as HTMLElement | null;
	// next to the clicked control: a popover or dialog traps focus and would pull it out of a
	// textarea placed on <body>, leaving nothing selected
	const host = active && active !== document.body ? (active.parentElement ?? document.body) : document.body;
	host.appendChild(area);
	area.focus({ preventScroll: true });
	area.select();
	area.setSelectionRange(0, text.length);
	let ok = false;
	try {
		ok = document.execCommand('copy');
	} catch {
		ok = false;
	}
	area.remove();
	active?.focus?.();
	return ok;
}
