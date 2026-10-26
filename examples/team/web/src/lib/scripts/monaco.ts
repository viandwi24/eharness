// Monaco (the VS Code editor) for the Scripts pages: loaded on demand, set up once.
// TypeScript gets the `scripts.d.ts` of the server (autocomplete of `ctx`, hover docs, type errors);
// JSON gets the manifest's JSON Schema (autocomplete, inline errors). Workers come from Vite.
import type * as Monaco from 'monaco-editor';
import { api } from '../api/index.js';

export type MonacoApi = typeof Monaco;

let loading: Promise<MonacoApi> | null = null;
let typesLib: { dispose(): void } | null = null;
let typesText = '';
let schemaText = '';

/** A CSS color (any syntax the browser knows, oklch included) as #rrggbb for Monaco themes. */
function hex(cssColor: string, fallback: string): string {
	try {
		const c = document.createElement('canvas');
		c.width = c.height = 1;
		const ctx = c.getContext('2d');
		if (!ctx) return fallback;
		ctx.fillStyle = fallback;
		ctx.fillStyle = cssColor;
		ctx.fillRect(0, 0, 1, 1);
		const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
		return `#${[r, g, b].map((v) => (v ?? 0).toString(16).padStart(2, '0')).join('')}`;
	} catch {
		return fallback;
	}
}

const cssVar = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Editor themes from the app's tokens, so the editor sits on the page like any card. */
export function defineThemes(monaco: MonacoApi): void {
	const dark = document.documentElement.classList.contains('dark');
	const bg = hex(cssVar('--card') || cssVar('--background'), dark ? '#1b1b1f' : '#ffffff');
	const fg = hex(cssVar('--foreground'), dark ? '#e6e6e6' : '#1b1b1f');
	const muted = hex(cssVar('--muted-foreground'), dark ? '#8a8a93' : '#6b6b73');
	const border = hex(cssVar('--border'), dark ? '#2c2c33' : '#e4e4e7');
	const accent = hex(cssVar('--primary'), dark ? '#e6e6e6' : '#1b1b1f');
	const colors = {
		'editor.background': bg,
		'editor.foreground': fg,
		'editorLineNumber.foreground': muted,
		'editorLineNumber.activeForeground': fg,
		'editorGutter.background': bg,
		'editor.lineHighlightBackground': dark ? '#ffffff08' : '#00000006',
		'editor.lineHighlightBorder': '#00000000',
		'editorIndentGuide.background1': border,
		'editorWidget.background': bg,
		'editorWidget.border': border,
		'editorSuggestWidget.background': bg,
		'editorSuggestWidget.border': border,
		'editorHoverWidget.background': bg,
		'editorHoverWidget.border': border,
		'editorCursor.foreground': accent,
		'scrollbarSlider.background': dark ? '#ffffff18' : '#00000018',
		'diffEditor.insertedTextBackground': dark ? '#2ea04326' : '#2ea04322',
		'diffEditor.removedTextBackground': dark ? '#f8514926' : '#f8514922'
	};
	monaco.editor.defineTheme('eh-dark', { base: 'vs-dark', inherit: true, rules: [], colors });
	monaco.editor.defineTheme('eh-light', { base: 'vs', inherit: true, rules: [], colors });
}

export const themeName = (): string => (document.documentElement.classList.contains('dark') ? 'eh-dark' : 'eh-light');

/** Load Monaco once (a separate chunk; only the Scripts pages pay for it). */
export function loadMonaco(): Promise<MonacoApi> {
	if (loading) return loading;
	loading = (async () => {
		const [monaco, EditorWorker, TsWorker, JsonWorker] = await Promise.all([
			import('monaco-editor'),
			import('monaco-editor/editor/editor.worker.js?worker'),
			import('monaco-editor/language/typescript/ts.worker.js?worker'),
			import('monaco-editor/language/json/json.worker.js?worker')
		]);
		(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
			getWorker(_id: string, label: string): Worker {
				if (label === 'typescript' || label === 'javascript') return new TsWorker.default();
				if (label === 'json') return new JsonWorker.default();
				return new EditorWorker.default();
			}
		};
		const ts = monaco.typescript;
		ts.typescriptDefaults.setCompilerOptions({
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.NodeJs,
			lib: ['es2022'],
			allowNonTsExtensions: true,
			strict: false,
			noImplicitAny: false,
			// scripts have no DOM: `document`, `window`, `fetch` should not complete
			noLib: false
		});
		ts.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false });
		ts.typescriptDefaults.setEagerModelSync(true);
		defineThemes(monaco);
		return monaco;
	})();
	loading.catch(() => {
		loading = null;
	});
	return loading;
}

/** Give the TypeScript service the server's `scripts.d.ts` (once per text). */
export function setScriptTypes(monaco: MonacoApi, dts: string): void {
	if (dts === typesText) return;
	typesText = dts;
	typesLib?.dispose();
	typesLib = monaco.typescript.typescriptDefaults.addExtraLib(dts, 'file:///eharness/scripts.d.ts');
}

/** Give the JSON service the manifest schema, for models under `file:///manifest/`. */
export function setManifestSchema(monaco: MonacoApi, schema: Record<string, unknown>): void {
	const text = JSON.stringify(schema);
	if (text === schemaText) return;
	schemaText = text;
	monaco.json.jsonDefaults.setDiagnosticsOptions({
		validate: true,
		allowComments: false,
		schemaValidation: 'error',
		schemas: [{ uri: 'https://eharness.dev/schemas/script-manifest.json', fileMatch: ['file:///manifest/*'], schema }]
	});
}

let support: Promise<void> | null = null;

/** Fetch the server's `scripts.d.ts` and manifest schema once and hand them to Monaco. */
export function ensureScriptSupport(monaco: MonacoApi): Promise<void> {
	if (support) return support;
	support = api
		.get('/scripts-types')
		.then((t) => {
			setScriptTypes(monaco, t.types);
			setManifestSchema(monaco, t.manifestSchema);
		})
		.catch(() => {
			support = null;
		});
	return support;
}
