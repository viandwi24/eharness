<script lang="ts">
	import type { UIMessage } from 'ai';
	import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeft';
	import ArrowSquareOutIcon from 'phosphor-svelte/lib/ArrowSquareOut';
	import CheckIcon from 'phosphor-svelte/lib/Check';
	import CopyIcon from 'phosphor-svelte/lib/Copy';
	import DownloadSimpleIcon from 'phosphor-svelte/lib/DownloadSimple';
	import FloppyDiskIcon from 'phosphor-svelte/lib/FloppyDisk';
	import ShareNetworkIcon from 'phosphor-svelte/lib/ShareNetwork';
	import XIcon from 'phosphor-svelte/lib/X';
	import { artifactsApi, exportArtifact, type Artifact, type ArtifactVersion } from '#lib/artifacts/api.js';
	import { copyText, downloadBlob, downloadText } from '#lib/artifacts/download.js';
	import { fromArtifact, fromFence, fromFile, isBinaryPath, loadText, type ViewerInput } from '#lib/artifacts/input.js';
	import { previewFence } from '#lib/artifacts/fences.js';
	import { isKnownKind, kindLabel, kindOf } from '#lib/artifacts/kinds.js';
	import { openPanel } from '#lib/artifacts/open.js';
	import type { PanelTarget } from '#lib/artifacts/panel.js';
	import { saveFence, saveLibraryText } from '#lib/artifacts/save.js';
	import { clientExportSupported, runClientExport } from '#lib/artifacts/export.js';
	import { ArtifactKindIcon, type ArtifactKind } from '#lib/components/ai/artifact-card/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { basename } from '#lib/files/helpers.js';
	import ArtifactView from './ArtifactView.svelte';

	/**
	 * The artifact panel (plan P45 R1): header with title, kind, version picker and actions, and the
	 * viewer. It shows a stored artifact, a fence of a chat message, or a library file; `full` is the
	 * `/artifacts/<id>` page (no close, no "open full page").
	 */
	let {
		target,
		messages = [],
		full = false,
		refreshKey,
		onClose,
		onBack,
		onAsk
	}: {
		target: PanelTarget;
		messages?: readonly UIMessage[];
		full?: boolean;
		/** Changes when the chat settles: a stored artifact is fetched again (the agent may have made a new version). */
		refreshKey?: unknown;
		onClose?: () => void;
		/** Narrow screens: a back arrow instead of close. */
		onBack?: () => void;
		/** Send a message to the agent of the chat ("ask the agent to fix", "adopt this file"). */
		onAsk?: (text: string) => void;
	} = $props();

	let artifact = $state<Artifact>();
	let versions = $state<ArtifactVersion[]>([]);
	let version = $state<number>(); // undefined: the latest
	let loadError = $state('');
	let copied = $state(false);
	let busy = $state(false);

	const targetKey = $derived(target.kind === 'artifact' ? `a:${target.id}:${target.version ?? ''}` : target.kind === 'preview' ? `p:${target.messageId}:${target.index}` : `f:${target.path}`);

	// load the artifact when the target changes, and again when the chat settles
	let loadedKey = '';
	$effect(() => {
		const t = target;
		void refreshKey;
		if (t.kind !== 'artifact') {
			artifact = undefined;
			versions = [];
			loadedKey = '';
			return;
		}
		const fresh = loadedKey !== targetKey;
		loadedKey = targetKey;
		if (fresh) {
			artifact = undefined;
			versions = [];
			version = t.version;
			loadError = '';
		}
		const ctl = new AbortController();
		artifactsApi.get(t.id, ctl.signal).then(
			(a) => {
				if (ctl.signal.aborted) return;
				// a new version made while the person watched the latest one is followed
				if (artifact && a.version !== artifact.version && version === artifact.version) version = a.version;
				artifact = a;
				void artifactsApi.versions(a.id).then((v) => !ctl.signal.aborted && (versions = [...v].sort((x, y) => y.n - x.n))).catch(() => {});
			},
			(e: unknown) => {
				if (ctl.signal.aborted) return;
				loadError = (e as { status?: number } | null)?.status === 404 ? 'This artifact was not found. It may have been deleted.' : e instanceof Error ? e.message : 'Could not load the artifact';
			}
		);
		return () => ctl.abort();
	});

	const shownVersion = $derived(version ?? artifact?.version);
	// The viewer input of a stored artifact is rebuilt only when what it shows changes (a visibility
	// switch or a refetch of the same version must not reload the frame).
	let artifactInput = $state<ViewerInput>();
	let artifactInputKey = '';
	$effect(() => {
		const a = artifact;
		const v = version;
		if (!a) {
			artifactInput = undefined;
			artifactInputKey = '';
			return;
		}
		const key = `${a.id}:${a.version}:${a.entry}:${v ?? ''}`;
		if (key === artifactInputKey) return;
		artifactInputKey = key;
		artifactInput = fromArtifact(a, v && v !== a.version ? v : undefined);
	});
	// Previews and files: the same input object while the content is the same (the message list
	// changes on every streamed token, and a diagram must not be drawn again each time).
	let memo: { key: string; input: ViewerInput } | undefined;
	const memoize = (key: string, make: () => ViewerInput): ViewerInput => (memo?.key === key ? memo.input : (memo = { key, input: make() }).input);
	const input = $derived.by((): ViewerInput | undefined => {
		if (target.kind === 'artifact') return artifactInput;
		if (target.kind === 'preview') {
			const m = messages.find((x) => x.id === target.messageId);
			const f = m ? previewFence(m, target.index) : undefined;
			return f ? memoize(`p:${target.messageId}:${target.index}:${f.kind}:${f.code}`, () => fromFence(f)) : undefined;
		}
		const path = target.path;
		return memoize(`f:${path}`, () => fromFile(path));
	});
	const previewGone = $derived(target.kind === 'preview' && !input);
	const title = $derived(artifact?.title ?? input?.title ?? (target.kind === 'file' ? basename(target.path) : 'Preview'));
	const kind = $derived(artifact?.kind ?? input?.kind ?? 'file');
	const iconKind = $derived((isKnownKind(kind) ? kind : 'file') as ArtifactKind);
	const source = $derived(target.kind === 'artifact' ? 'artifact' : target.kind === 'preview' ? 'Preview from the chat' : target.path);

	const fixAsk = (error: string): void => {
		if (!onAsk || !input) return;
		const what = artifact ? `The artifact "${artifact.title}" (id ${artifact.id})` : `The page "${input.title}"`;
		onAsk(`${what} reports this error in the browser:\n\n${error}\n\nPlease fix it.`);
	};

	async function copySource(): Promise<void> {
		if (!input) return;
		try {
			if (!(await copyText(await loadText(input)))) throw new Error('Could not copy');
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not copy');
		}
	}

	async function download(format?: string): Promise<void> {
		if (!input || busy) return;
		busy = true;
		try {
			if (artifact && format && kindOf(artifact.kind).exports.find((e) => e.id === format)?.client) await runClientExport(artifact.kind, format, input);
			else if (artifact && format) {
				const r = await exportArtifact(artifact.id, format);
				downloadBlob(r.filename, r.blob);
			} else if (input.text !== undefined) downloadText(input.name, input.text, input.mediaType ?? 'text/plain');
			else if (input.url) {
				const res = await fetch(await input.url(), { credentials: 'omit' });
				if (!res.ok) throw new Error(`Download failed (${res.status})`);
				downloadBlob(input.name, await res.blob());
			}
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Download failed');
		} finally {
			busy = false;
		}
	}

	async function saveAsArtifact(): Promise<void> {
		if (!input || busy) return;
		if (target.kind === 'file' && isBinaryPath(target.path)) {
			// bytes never go through the browser: the agent adopts the library file (plan P45 R5)
			if (onAsk) onAsk(`Create an artifact from the file ${target.path} (artifact_create with from: "${target.path}").`);
			else toast('Ask the agent to create an artifact from this file');
			return;
		}
		busy = true;
		try {
			const a =
				target.kind === 'preview'
					? await (async () => {
							const f = previewFence(messages.find((x) => x.id === target.messageId)!, target.index)!;
							return saveFence(f.kind, f.code, { messageId: target.messageId, block: target.index });
						})()
					: await saveLibraryText((target as { path: string }).path, input);
			toast.success('Saved as an artifact');
			openPanel({ kind: 'artifact', id: a.id }, { replace: true });
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not save the artifact');
		} finally {
			busy = false;
		}
	}

	async function setVisibility(pub: boolean): Promise<void> {
		if (!artifact) return;
		try {
			artifact = await artifactsApi.patch(artifact.id, { visibility: pub ? 'public' : 'private' });
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not change the visibility');
		}
	}
	async function copyLink(): Promise<void> {
		if (artifact?.shareUrl && (await copyText(artifact.shareUrl))) toast.success('Link copied');
		else toast.error('Could not copy the link');
	}
</script>

<div class="flex h-full min-h-0 min-w-0 flex-col bg-background" data-testid="artifact-panel" role="region" aria-label="{title} preview">
	<header class="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
		{#if onBack && !full}<Button variant="ghost" size="icon-sm" aria-label="Back to the chat" onclick={onBack}><ArrowLeftIcon class="size-4" /></Button>{/if}
		<span class="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-muted text-muted-foreground"><ArtifactKindIcon kind={iconKind} class="size-4" /></span>
		<div class="min-w-0 flex-1">
			{#if !input && !loadError && !previewGone && target.kind === 'artifact'}
				<Skeleton class="h-3.5 w-40" />
			{:else}
				<h2 class="truncate text-[13px] leading-4 font-medium" {title}>{title}</h2>
				<p class="flex items-center gap-1.5 truncate text-[11px] leading-4 text-muted-foreground">
					<Badge variant="outline" class="h-4 px-1.5 text-[10px]">{kindLabel(kind)}</Badge>
					<span class="truncate font-mono">{source}</span>
				</p>
			{/if}
		</div>

		{#if artifact && versions.length > 1}
			<NativeSelect size="sm" class="w-auto" aria-label="Version" value={String(shownVersion)} onchange={(e) => (version = Number(e.currentTarget.value))}>
				{#each versions as v (v.n)}<NativeSelectOption value={String(v.n)}>v{v.n}{v.n === artifact.version ? ' (latest)' : ''}</NativeSelectOption>{/each}
			</NativeSelect>
		{/if}

		{#if input}
			{#if kind !== 'image' && kind !== 'file'}
				<Button size="icon-sm" variant="ghost" aria-label="Copy source" title="Copy source" onclick={copySource}>
					{#if copied}<CheckIcon class="size-4" />{:else}<CopyIcon class="size-4" />{/if}
				</Button>
			{/if}
			{#if artifact}
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button {...props} size="icon-sm" variant="ghost" aria-label="Download" title="Download" disabled={busy}><DownloadSimpleIcon class="size-4" /></Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content elevation="floating" align="end" class="w-48">
						{#each kindOf(artifact.kind).exports.filter((e) => !e.client || clientExportSupported(artifact!.kind, e.id)) as ex (ex.id)}
							<DropdownMenu.Item onSelect={() => void download(ex.id)}>{ex.label}</DropdownMenu.Item>
						{/each}
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			{:else}
				<Button size="icon-sm" variant="ghost" aria-label="Download" title="Download" disabled={busy} onclick={() => void download()}><DownloadSimpleIcon class="size-4" /></Button>
				<Button size="sm" variant="outline" disabled={busy} onclick={saveAsArtifact}><FloppyDiskIcon />Save as artifact</Button>
			{/if}
		{/if}

		{#if artifact}
			{#if !full}
				<Button size="icon-sm" variant="ghost" href="/artifacts/{artifact.id}" aria-label="Open full page" title="Open full page"><ArrowSquareOutIcon class="size-4" /></Button>
			{/if}
			<Popover.Root>
				<Popover.Trigger>
					{#snippet child({ props })}
						<Button {...props} size="icon-sm" variant={artifact?.visibility === 'public' ? 'secondary' : 'ghost'} aria-label="Share" title="Share"><ShareNetworkIcon class="size-4" /></Button>
					{/snippet}
				</Popover.Trigger>
				<Popover.Content elevation="floating" align="end" class="w-80 p-3">
					<div class="flex flex-col gap-3">
						<label class="flex items-center justify-between gap-3 text-sm">
							<span class="min-w-0">
								<span class="block font-medium">{artifact.visibility === 'public' ? 'Public link' : 'Private'}</span>
								<span class="block text-xs text-muted-foreground">{artifact.visibility === 'public' ? 'Anyone with the link can view it.' : 'Only signed-in people can open it.'}</span>
							</span>
							<Switch checked={artifact.visibility === 'public'} onCheckedChange={(v) => void setVisibility(v)} aria-label="Public link" />
						</label>
						{#if artifact.visibility === 'public' && artifact.shareUrl}
							<div class="flex gap-1.5">
								<Input readonly value={artifact.shareUrl} aria-label="Public link" class="h-8 min-w-0 flex-1 font-mono text-xs" onfocus={(e) => e.currentTarget.select()} />
								<Button size="sm" variant="outline" onclick={copyLink}><CopyIcon />Copy</Button>
							</div>
						{/if}
					</div>
				</Popover.Content>
			</Popover.Root>
		{/if}
		{#if onClose && !full}<Button size="icon-sm" variant="ghost" aria-label="Close panel" title="Close" onclick={onClose}><XIcon class="size-4" /></Button>{/if}
	</header>

	<div class="min-h-0 flex-1">
		{#if loadError}
			<p class="p-4 text-sm text-destructive-text" role="alert">{loadError}</p>
		{:else if previewGone}
			<p class="p-4 text-sm text-muted-foreground">This preview is no longer in the chat. Open the message it came from, or ask the agent again.</p>
		{:else if input}
			{#key `${targetKey}:${shownVersion ?? ''}`}
				<ArtifactView {input} onFix={onAsk ? fixAsk : undefined} />
			{/key}
		{:else}
			<div class="flex flex-col gap-2 p-4"><Skeleton class="h-4 w-2/3" /><Skeleton class="h-40 w-full" /></div>
		{/if}
	</div>
</div>
