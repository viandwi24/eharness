<script lang="ts">
	import AppWindowIcon from 'phosphor-svelte/lib/AppWindow';
	import ArrowSquareOutIcon from 'phosphor-svelte/lib/ArrowSquareOut';
	import CheckIcon from 'phosphor-svelte/lib/Check';
	import CopyIcon from 'phosphor-svelte/lib/Copy';
	import FloppyDiskIcon from 'phosphor-svelte/lib/FloppyDisk';
	import { getChatEnv, getMessageEnv } from '#lib/artifacts/context.js';
	import { copyText } from '#lib/artifacts/download.js';
	import { fenceIndexOf, type FenceKind } from '#lib/artifacts/fences.js';
	import { fenceTitle } from '#lib/artifacts/input.js';
	import { openPanel } from '#lib/artifacts/open.js';
	import { saveFence } from '#lib/artifacts/save.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import DiagramPane from './DiagramPane.svelte';

	/**
	 * A previewable fence of an assistant message: mermaid and svg draw inline, html is a compact
	 * card that opens in the panel. Nothing is stored until "Save as artifact".
	 */
	let { kind, lang, code }: { kind: FenceKind; lang: string; code: string } = $props();

	const env = getMessageEnv();
	const chat = getChatEnv();
	const index = $derived(env ? fenceIndexOf(env.fences(), lang, code) : -1);
	const target = $derived(env && chat && index >= 0 ? ({ kind: 'preview', messageId: env.messageId, index } as const) : null);
	const title = $derived(fenceTitle(kind, code));

	let saving = $state(false);
	let savedId = $state<string>();
	let copied = $state(false);

	async function save(): Promise<void> {
		if (saving) return;
		saving = true;
		try {
			const art = await saveFence(kind, code, env && index >= 0 ? { sessionId: chat?.sessionId(), messageId: env.messageId, block: index } : undefined);
			savedId = art.id;
			toast.success('Saved as an artifact', { action: { label: 'Open', onClick: () => openPanel({ kind: 'artifact', id: art.id }) } });
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not save the artifact');
		} finally {
			saving = false;
		}
	}
	async function copy(): Promise<void> {
		if (!(await copyText(code))) return void toast.error('Could not copy');
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}
</script>

{#snippet actions()}
	{#if target}
		<Button size="xs" variant="ghost" onclick={() => openPanel(target)}><ArrowSquareOutIcon />Open</Button>
	{/if}
	{#if savedId}
		<Button size="xs" variant="ghost" onclick={() => openPanel({ kind: 'artifact', id: savedId! })}><CheckIcon />Saved</Button>
	{:else}
		<Button size="xs" variant="ghost" disabled={saving} onclick={save}><FloppyDiskIcon />Save as artifact</Button>
	{/if}
{/snippet}

<div class="my-1 w-full" data-testid="fence-{kind}">
	{#if kind === 'html'}
		<div class="flex items-center gap-3 rounded-xl border border-border bg-card p-2.5 pr-2">
			<span class="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-muted text-muted-foreground"><AppWindowIcon class="size-5" /></span>
			<div class="min-w-0 flex-1">
				<p class="truncate text-[13.5px] font-medium">HTML preview</p>
				<p class="truncate text-xs text-muted-foreground">{title === 'HTML preview' ? 'A page the agent wrote' : title}</p>
			</div>
			<Button size="icon-xs" variant="ghost" aria-label="Copy code" title="Copy code" onclick={copy}>{#if copied}<CheckIcon />{:else}<CopyIcon />{/if}</Button>
			{#if target}<Button size="sm" variant="secondary" onclick={() => openPanel(target)}>Preview</Button>{/if}
			{#if savedId}
				<Button size="xs" variant="ghost" onclick={() => openPanel({ kind: 'artifact', id: savedId! })}><CheckIcon />Saved</Button>
			{:else}
				<Button size="xs" variant="ghost" disabled={saving} onclick={save}><FloppyDiskIcon />Save</Button>
			{/if}
		</div>
	{:else}
		<DiagramPane {kind} {code} extra={actions} />
	{/if}
</div>
