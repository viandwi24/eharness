<script lang="ts">
	// A Monaco editor bound to a string: syntax highlighting, line numbers, autocomplete and
	// inline problems. `path` names the model (file:///scripts/x.ts or file:///manifest/x.json),
	// which decides the language and which types/schema apply.
	import { onDestroy, onMount, untrack } from 'svelte';
	import type * as Monaco from 'monaco-editor';
	import { cn } from '#lib/utils.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { theme } from '#lib/stores/theme.svelte.js';
	import { defineThemes, ensureScriptSupport, loadMonaco, themeName, type MonacoApi } from '#lib/scripts/monaco.js';

	export type EditorProblem = { line: number; column: number; message: string; severity: 'error' | 'warning' };

	let {
		value = $bindable(''),
		path,
		language,
		readOnly = false,
		label,
		class: className = '',
		onSave,
		onProblems,
		onReady
	}: {
		value?: string;
		path: string;
		language: 'typescript' | 'json';
		readOnly?: boolean;
		label: string;
		class?: string;
		onSave?: () => void;
		onProblems?: (problems: EditorProblem[]) => void;
		onReady?: (api: { reveal: (line: number, column: number) => void; focus: () => void }) => void;
	} = $props();

	let host: HTMLDivElement;
	let monaco: MonacoApi | null = null;
	let editor: Monaco.editor.IStandaloneCodeEditor | null = null;
	let model: Monaco.editor.ITextModel | null = null;
	let failed = $state('');
	let ready = $state(false);
	const subs: Monaco.IDisposable[] = [];

	onMount(() => {
		let gone = false;
		void loadMonaco()
			.then((m) => {
				if (gone) return;
				monaco = m;
				void ensureScriptSupport(m);
				const uri = m.Uri.parse(path);
				m.editor.getModel(uri)?.dispose();
				model = m.editor.createModel(value, language, uri);
				editor = m.editor.create(host, {
					model,
					theme: themeName(),
					readOnly,
					automaticLayout: true,
					minimap: { enabled: false },
					fontFamily: "'JetBrains Mono Variable', ui-monospace, monospace",
					fontSize: 13,
					lineHeight: 20,
					tabSize: 2,
					insertSpaces: true,
					scrollBeyondLastLine: false,
					renderLineHighlight: 'line',
					fixedOverflowWidgets: true,
					padding: { top: 10, bottom: 10 },
					stickyScroll: { enabled: false },
					ariaLabel: label,
					quickSuggestions: { other: true, comments: false, strings: language === 'json' },
					wordWrap: language === 'json' ? 'on' : 'off'
				});
				subs.push(
					model.onDidChangeContent(() => {
						const next = model?.getValue() ?? '';
						if (next !== value) value = next;
					})
				);
				if (onSave) editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => onSave?.());
				const report = (): void => {
					if (!model || !monaco) return;
					const marks = monaco.editor.getModelMarkers({ resource: model.uri });
					onProblems?.(
						marks
							.filter((k) => k.severity >= monaco!.MarkerSeverity.Warning)
							.map((k) => ({ line: k.startLineNumber, column: k.startColumn, message: k.message, severity: k.severity === monaco!.MarkerSeverity.Error ? 'error' : 'warning' }))
					);
				};
				subs.push(m.editor.onDidChangeMarkers((uris) => uris.some((u) => u.toString() === model?.uri.toString()) && report()));
				onReady?.({
					reveal: (line, column) => {
						editor?.revealLineInCenter(line);
						editor?.setPosition({ lineNumber: line, column });
						editor?.focus();
					},
					focus: () => editor?.focus()
				});
				ready = true;
			})
			.catch((e) => {
				failed = e instanceof Error ? e.message : 'The editor could not load';
			});
		return () => {
			gone = true;
		};
	});

	onDestroy(() => {
		for (const s of subs) s.dispose();
		editor?.dispose();
		model?.dispose();
	});

	// outside changes (load a version, discard) go into the model without losing undo
	$effect(() => {
		const v = value;
		untrack(() => {
			if (!model || model.getValue() === v) return;
			editor?.pushUndoStop();
			model.pushEditOperations([], [{ range: model.getFullModelRange(), text: v }], () => null);
			editor?.pushUndoStop();
		});
	});

	$effect(() => {
		const ro = readOnly;
		untrack(() => editor?.updateOptions({ readOnly: ro }));
	});

	// follow the app's light/dark mode
	$effect(() => {
		void theme.mode;
		untrack(() => {
			if (!monaco) return;
			// the class flips before paint; read the tokens on the next frame
			requestAnimationFrame(() => {
				if (!monaco) return;
				defineThemes(monaco);
				monaco.editor.setTheme(themeName());
			});
		});
	});
</script>

<div class={cn('relative min-h-40 overflow-hidden rounded-md border border-border bg-card', className)}>
	<div bind:this={host} class="absolute inset-0" class:invisible={!ready}></div>
	{#if !ready}
		<div class="absolute inset-0 p-3">
			{#if failed}
				<p class="text-sm text-destructive-text" role="alert">{failed}</p>
				<textarea class="mt-2 h-[calc(100%-2rem)] w-full resize-none bg-transparent font-mono text-xs outline-none" aria-label={label} bind:value readonly={readOnly}></textarea>
			{:else}
				<div class="flex flex-col gap-2">
					{#each { length: 8 } as _, i (i)}<Skeleton class="h-3" style="width: {40 + ((i * 37) % 50)}%" />{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>
