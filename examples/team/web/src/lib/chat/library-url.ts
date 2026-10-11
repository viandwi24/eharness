/** `library:///uploads/…` references name an uploaded file; a browser cannot load them directly. */
export const LIBRARY_URL_PREFIX = 'library://';

/** The library path of a `library:` URL, or `undefined` for any other URL (or a malformed one). */
export function libraryPathOf(url: string): string | undefined {
	if (!url.startsWith(LIBRARY_URL_PREFIX)) return undefined;
	try {
		return decodeURIComponent(url.slice(LIBRARY_URL_PREFIX.length));
	} catch {
		return undefined;
	}
}
