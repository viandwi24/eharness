import type { Handle } from '@sveltejs/kit/hooks';

// Theme mode lives in the `edmi-mode` cookie (edmi-ui theming reference): render the `.dark`
// class on the server so the first paint is already themed.
export const handle: Handle = ({ event, resolve }) => {
	const dark = event.cookies.get('edmi-mode') === 'dark';
	return resolve(event, {
		transformPageChunk: ({ html }) => html.replace('%eh.mode%', dark ? 'dark' : '')
	});
};
