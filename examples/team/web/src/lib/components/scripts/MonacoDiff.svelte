<script lang="ts">
	// A read-only Monaco diff (side by side on wide screens, inline on narrow ones).
	import { onDestroy, onMount, untrack } from 'svelte';
	import type * as Monaco from 'monaco-editor';
	import { cn } from '#lib/utils.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { theme } from '#lib/stores/theme.svelte.js';
	import { defineThemes, loadMonaco, themeName, type MonacoApi } from '#lib/scripts/monaco.js';

	let {
		original,
		modified,
		language,
		class: className = ''
	}: { original: string; modified: string; language: 'typescript' | 'json'; class?: string } = $props();

	let host: HTMLDivElement;
	let monaco: MonacoApi | null = null;
	let diff: Monaco.editor.IStandaloneDiffEditor | null = null;
	let models: Monaco.editor.ITextModel[] = [];
	let ready = $state(false);
	let failed = $state('');

	onMount(() => {
		let gone = false;
		void loadMonaco()
			.then((m) => {
				if (gone) return;
				monaco = m;
				// plain models: a diff must not join the script's type checking
				const lang = language === 'json' ? 'json' : 'typescript';
				const a = m.editor.createModel(original, lang);
				const b = m.editor.createModel(modified, lang);
				models = [a, b];
				diff = m.editor.createDiffEditor(host, {
					theme: themeName(),
					readOnly: true,
					originalEditable: false,
					automaticLayout: true,
					minimap: { enabled: false },
					renderSideBySide: host.clientWidth > 720,
					useInlineViewWhenSpaceIsLimited: true,
					fontFamily: "'JetBrains Mono Variable', ui-monospace, monospace",
					fontSize: 13,
					lineHeight: 20,
					scrollBeyondLastLine: false,
					renderOverviewRuler: false,
					hideUnchangedRegions: { enabled: true, contextLineCount: 3 }
				});
				diff.setModel({ original: a, modified: b });
				ready = true;
			})
			.catch((e) => {
				failed = e instanceof Error ? e.message : 'The diff could not load';
			});
		return () => {
			gone = true;
		};
	});

	onDestroy(() => {
		diff?.dispose();
		for (const m of models) m.dispose();
	});

	$effect(() => {
		const a = original;
		const b = modified;
		untrack(() => {
			if (models.length !== 2) return;
			if (models[0]!.getValue() !== a) models[0]!.setValue(a);
			if (models[1]!.getValue() !== b) models[1]!.setValue(b);
		});
	});

	$effect(() => {
		void theme.mode;
		untrack(() => {
			if (!monaco) return;
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
			{#if failed}<p class="text-sm text-destructive-text" role="alert">{failed}</p>{:else}<Skeleton class="h-full w-full" />{/if}
		</div>
	{/if}
</div>
