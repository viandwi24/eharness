import { modeCookie, resolveMode, type ThemeMode } from '../theme.js';

const initial = (): ThemeMode =>
	typeof document === 'undefined'
		? 'light'
		: document.documentElement.classList.contains('dark')
			? 'dark'
			: resolveMode(document.cookie, window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);

/** The shown mode. `app.html` already set the class before the first paint; this mirrors it for components (the toaster). */
export const theme = (() => {
	let mode = $state<ThemeMode>(initial());
	return {
		get mode(): ThemeMode {
			return mode;
		},
		toggle(): void {
			mode = mode === 'dark' ? 'light' : 'dark';
			document.documentElement.classList.toggle('dark', mode === 'dark');
			document.cookie = modeCookie(mode);
		}
	};
})();
