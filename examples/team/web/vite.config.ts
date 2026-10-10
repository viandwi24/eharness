import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-auto';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv } from 'vite';

// Dev: `/api/*` is proxied to the team server (default port 4000, see server/src/main.ts).
const apiTarget = process.env.TEAM_API_PROXY ?? 'http://localhost:4000';

// Public env (PUBLIC_API_URL, PUBLIC_TEAM_TOKEN) is inlined at build time via `define`.
export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), 'PUBLIC_');
	return {
	define: {
		__PUBLIC_API_URL__: JSON.stringify(env.PUBLIC_API_URL ?? ''),
		__PUBLIC_TEAM_TOKEN__: JSON.stringify(env.PUBLIC_TEAM_TOKEN ?? '')
	},
	server: {
		proxy: { '/api': { target: apiTarget, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') } }
	},
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
			// If your environment is not supported, or you settled on a specific environment, switch out the adapter.
			// See https://svelte.dev/docs/kit/adapters for more information about adapters.
			adapter: adapter()
		})
	]
};
});
