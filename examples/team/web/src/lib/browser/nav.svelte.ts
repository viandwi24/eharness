import { api } from '../api/index';

/** Whether the Browser section shows in the rail: the driver is on, or a profile exists. */
export const browserNav = $state({ visible: false, loaded: false });

export async function loadBrowserNav(): Promise<void> {
	try {
		const info = await api.get('/settings/browser');
		if (info.driver !== 'off') browserNav.visible = true;
		else browserNav.visible = (await api.get('/browser/profiles')).length > 0;
	} catch {
		// keep the last value (the section stays hidden until the server answers)
	} finally {
		browserNav.loaded = true;
	}
}
