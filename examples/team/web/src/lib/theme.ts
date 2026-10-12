// Light / dark preference (pure, unit-tested). The choice is kept in the `edmi-mode` cookie; with no
// saved choice the system setting decides. `app.html` applies it before the first paint (the
// static build has no server hook), `ThemeToggle` changes it.
export type ThemeMode = 'light' | 'dark';

export const THEME_COOKIE = 'edmi-mode';

/** The saved choice in a `document.cookie` string, if any. */
export function savedMode(cookie: string): ThemeMode | undefined {
	const m = /(?:^|;\s*)edmi-mode=(dark|light)\b/.exec(cookie);
	return m ? (m[1] as ThemeMode) : undefined;
}

/** The mode to show: the saved choice, else the system preference. */
export function resolveMode(cookie: string, systemDark: boolean): ThemeMode {
	return savedMode(cookie) ?? (systemDark ? 'dark' : 'light');
}

export function modeCookie(mode: ThemeMode): string {
	return `${THEME_COOKIE}=${mode}; path=/; max-age=31536000; samesite=lax`;
}
