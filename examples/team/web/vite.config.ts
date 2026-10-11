import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

// Env comes from examples/team/.env (shared with the server; see ../.env.example).
const envDir = '..';

// Public env (PUBLIC_API_URL, PUBLIC_TEAM_TOKEN) is inlined at build time via `define`.
export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, envDir, ['PUBLIC_', 'TEAM_API_PROXY']);
	// Dev: `/api/*` is proxied to the team server (default port 4000, see server/src/main.ts).
	const apiTarget = process.env.TEAM_API_PROXY ?? env.TEAM_API_PROXY ?? 'http://localhost:4000';
	return {
	envDir,
	// `eharness/client` resolves to the library source (no build step), like the server (also
	// `paths` in tsconfig.json). Its only runtime import is `ai`.
	resolve: { alias: { 'eharness/client': fileURLToPath(new URL('../../../src/client/index.ts', import.meta.url)) } },
	define: {
		__PUBLIC_API_URL__: JSON.stringify(env.PUBLIC_API_URL ?? ''),
		__PUBLIC_TEAM_TOKEN__: JSON.stringify(env.PUBLIC_TEAM_TOKEN ?? '')
	},
	server: {
		// `/api/*` (every route: /sessions, /attention, /activity, /agents, ...) goes to the team server.
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

			// The web is a SPA (`ssr = false`): `vite build` writes static files to build/ with an
			// index.html fallback for client routes. The team server serves them with TEAM_WEB_DIR
			// (see ../Dockerfile); any static host works too.
			adapter: adapter({ fallback: 'index.html' })
		})
	]
};
});
