// openapi-typescript needs the TypeScript 5 API, but the workspace root hoists TypeScript 7.
// For `bun run gen:api`, rewrite its `typescript` imports to this package's own TypeScript 5
// (a devDependency). Bun's onResolve does not fire for bare package imports, so patch on load.
import { createRequire } from 'node:module';

const ts5 = createRequire(import.meta.url).resolve('typescript');
Bun.plugin({
	name: 'typescript-5',
	setup(build) {
		build.onLoad({ filter: /openapi-typescript\/dist\/.*\.(m?js)$/ }, async ({ path }) => {
			const src = await Bun.file(path).text();
			return {
				contents: src.replaceAll(/from ['"]typescript['"]/g, `from ${JSON.stringify(ts5)}`),
				loader: 'js'
			};
		});
	}
});
