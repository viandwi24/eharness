<script lang="ts">
	import type { Snippet } from 'svelte';
	import CheckIcon from 'phosphor-svelte/lib/Check';
	import CopyIcon from 'phosphor-svelte/lib/Copy';
	import DownloadSimpleIcon from 'phosphor-svelte/lib/DownloadSimple';
	import { copyText, downloadBlob, downloadText, svgToPng } from '#lib/artifacts/download.js';
	import { svgDocument } from '#lib/artifacts/frame.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { cn } from '#lib/utils.js';
	import MermaidDiagram from './MermaidDiagram.svelte';
	import SandboxFrame from './SandboxFrame.svelte';

	/**
	 * A mermaid diagram or an SVG with its toolbar: Diagram/Code toggle, copy, download SVG and PNG,
	 * and whatever the caller adds (Open in panel, Save as artifact). SVG always runs in the locked frame.
	 */
	let {
		kind,
		code,
		label,
		extra,
		bordered = true,
		fill = false,
		class: className
	}: {
		kind: 'mermaid' | 'svg';
		code: string;
		label?: string;
		extra?: Snippet;
		bordered?: boolean;
		/** Fill the parent's height (the panel) instead of a fixed preview height. */
		fill?: boolean;
		class?: string;
	} = $props();

	let mode = $state<'diagram' | 'code'>('diagram');
	let rendered = $state(''); // mermaid's SVG
	let error = $state('');
	let copied = $state(false);

	const svgText = $derived(kind === 'mermaid' ? rendered : code);
	const base = $derived(kind === 'mermaid' ? 'diagram' : 'image');

	async function copy(): Promise<void> {
		if (!(await copyText(code))) return void toast.error('Could not copy');
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}
	async function png(): Promise<void> {
		try {
			downloadBlob(`${base}.png`, await svgToPng(svgText));
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not make the PNG');
		}
	}
</script>

<div class={cn('flex min-w-0 flex-col overflow-hidden', bordered && 'rounded-xl border border-border bg-card', fill && 'h-full', className)}>
	<div class="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1.5 text-xs text-muted-foreground">
		<span class="mr-1 px-1 font-mono">{label ?? (kind === 'mermaid' ? 'mermaid' : 'svg')}</span>
		<div class="flex items-center gap-0.5" role="group" aria-label="View">
			<Button size="xs" variant={mode === 'diagram' ? 'secondary' : 'ghost'} aria-pressed={mode === 'diagram'} onclick={() => (mode = 'diagram')}>{kind === 'mermaid' ? 'Diagram' : 'Preview'}</Button>
			<Button size="xs" variant={mode === 'code' ? 'secondary' : 'ghost'} aria-pressed={mode === 'code'} onclick={() => (mode = 'code')}>Code</Button>
		</div>
		<span class="flex-1"></span>
		<Button size="icon-xs" variant="ghost" aria-label="Copy code" title="Copy code" onclick={copy}>
			{#if copied}<CheckIcon />{:else}<CopyIcon />{/if}
		</Button>
		<Button size="xs" variant="ghost" disabled={!svgText} onclick={() => downloadText(`${base}.svg`, svgText, 'image/svg+xml')}><DownloadSimpleIcon />SVG</Button>
		<Button size="xs" variant="ghost" disabled={!svgText} onclick={png}><DownloadSimpleIcon />PNG</Button>
		{@render extra?.()}
	</div>
	<div class={cn('min-h-0 p-3', fill && 'flex-1 overflow-auto')}>
		{#if mode === 'code'}
			<pre class="overflow-x-auto font-mono text-xs leading-relaxed whitespace-pre">{code}</pre>
		{:else if kind === 'mermaid'}
			<MermaidDiagram {code} bind:svg={rendered} bind:error />
		{:else}
			<SandboxFrame srcdoc={svgDocument(code)} title="SVG preview" locked class={cn('rounded-md', fill ? 'min-h-[60vh]' : 'h-72')} />
		{/if}
	</div>
</div>
