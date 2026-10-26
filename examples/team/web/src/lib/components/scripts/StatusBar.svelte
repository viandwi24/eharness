<script lang="ts">
	import CheckIcon from 'phosphor-svelte/lib/Check';
	import LightningIcon from 'phosphor-svelte/lib/Lightning';
	import PauseIcon from 'phosphor-svelte/lib/Pause';
	import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimple';
	import PlayIcon from 'phosphor-svelte/lib/Play';
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import XIcon from 'phosphor-svelte/lib/X';
	import { api } from '#lib/api/index.js';
	import type { components } from '#lib/api/schema.js';
	import ConfirmDialog from '#lib/components/app/ConfirmDialog.svelte';
	import Surface from '#lib/components/app/Surface.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { relativeTime } from '#lib/routines/schedule.js';
	import { approvalLabel, canActivate, outcomeTone, SCRIPT_NAME, type Script, type ScriptDetail, statusLabel, triggerSummary } from '#lib/scripts/scripts.js';

	/**
	 * The top of a script: status, the approval request (approve / reject), and the actions that
	 * switch it on or off, run it, rename or delete it.
	 */
	let {
		detail,
		onChanged,
		onViewVersion,
		onRan,
		onRenamed,
		onDeleted
	}: {
		detail: ScriptDetail;
		onChanged: (s: Script) => void;
		onViewVersion: (version: number) => void;
		onRan: () => void;
		onRenamed: (name: string) => void;
		onDeleted: () => void;
	} = $props();

	type Decision = components['schemas']['ScriptDecision'];
	type Activate = components['schemas']['ScriptActivate'];

	const s = $derived(detail.script);
	const st = $derived(statusLabel(s));
	const ap = $derived(approvalLabel(s));
	const triggers = $derived(triggerSummary(detail.latest.manifest));
	const versionsDesc = $derived(Array.from({ length: s.latestVersion }, (_, i) => s.latestVersion - i));

	let busy = $state(false);

	async function act(fn: () => Promise<Script>, done: string): Promise<boolean> {
		busy = true;
		try {
			onChanged(await fn());
			toast.success(done);
			return true;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'That did not work');
			return false;
		} finally {
			busy = false;
		}
	}

	// approve / reject, with an optional note
	let decision = $state<'approve' | 'reject' | null>(null);
	let decisionNote = $state('');
	function openDecision(d: 'approve' | 'reject'): void {
		decision = d;
		decisionNote = '';
	}
	async function decide(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		const note = decisionNote.trim() ? { note: decisionNote.trim() } : {};
		const v = s.approval.version ?? undefined;
		const ok =
			decision === 'approve'
				? await act(() => api.post('/scripts/{script}/approve', { params: { script: s.id }, body: { ...(v ? { version: v } : {}), ...note } satisfies Decision as never }), `v${v ?? ''} approved`)
				: await act(() => api.post('/scripts/{script}/reject', { params: { script: s.id }, body: note satisfies Decision as never }), `v${v ?? ''} rejected`);
		if (ok) decision = null;
	}

	// activate a version
	let activating = $state(false);
	let activateVersion = $state('');
	let activateNote = $state('');
	function openActivate(): void {
		activateVersion = String(s.latestVersion);
		activateNote = '';
		activating = true;
	}
	async function activate(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		const version = Number(activateVersion);
		const ok = await act(
			() => api.post('/scripts/{script}/activate', { params: { script: s.id }, body: { version, ...(activateNote.trim() ? { note: activateNote.trim() } : {}) } satisfies Activate as never }),
			`v${version} is active`
		);
		if (ok) activating = false;
	}

	const disable = (): Promise<boolean> => act(() => api.post('/scripts/{script}/disable', { params: { script: s.id } }), 'Script switched off');
	const enable = (): Promise<boolean> => act(() => api.post('/scripts/{script}/enable', { params: { script: s.id } }), 'Script switched on');

	// run now (real side effects)
	let confirmRun = $state(false);
	async function runNow(): Promise<void> {
		busy = true;
		try {
			const r = await api.post('/scripts/{script}/run', { params: { script: s.id }, body: {} satisfies components['schemas']['ScriptRunNow'] as never });
			if (outcomeTone(r.outcome) === 'success') toast.success(`Ran v${r.version}: ${r.outcome}`);
			else toast.error(`Ran v${r.version}: ${r.outcome}${r.error ? ` — ${r.error}` : r.reason ? ` — ${r.reason}` : ''}`);
			onRan();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not run the script');
		} finally {
			busy = false;
		}
	}

	// rename / describe
	let editing = $state(false);
	let editName = $state('');
	let editDescription = $state('');
	let editError = $state('');
	function openEdit(): void {
		editName = s.name;
		editDescription = s.description;
		editError = '';
		editing = true;
	}
	async function saveDetails(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		editError = '';
		const name = editName.trim();
		if (!SCRIPT_NAME.test(name)) {
			editError = 'Use lowercase letters, digits and -, starting with a letter.';
			return;
		}
		busy = true;
		try {
			const r = await api.patch('/scripts/{script}', { params: { script: s.id }, body: { name, description: editDescription.trim() } });
			editing = false;
			onChanged(r.script);
			if (r.script.name !== detail.script.name) onRenamed(r.script.name);
			toast.success('Saved');
		} catch (err) {
			editError = err instanceof Error ? err.message : 'Could not save';
		} finally {
			busy = false;
		}
	}

	// delete: type the name
	let deleting = $state(false);
	let deleteName = $state('');
	async function remove(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		if (deleteName.trim() !== s.name) return;
		busy = true;
		try {
			await api.delete('/scripts/{script}', { params: { script: s.id } });
			deleting = false;
			toast.success(`Script ${s.name} deleted`);
			onDeleted();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not delete the script');
		} finally {
			busy = false;
		}
	}
</script>

<Surface class="flex flex-col gap-3 p-4 text-sm">
	<div class="flex flex-wrap items-center gap-2">
		<Badge variant={st.tone} title={st.title}><span class="max-w-64 truncate">{st.label}</span></Badge>
		{#if ap}<Badge variant={ap.tone}>{ap.label}</Badge>{/if}
		<span class="text-xs text-muted-foreground">
			latest v{s.latestVersion} · {s.runCount.toLocaleString()} run{s.runCount === 1 ? '' : 's'}{s.errorCount ? `, ${s.errorCount} failed` : ''} · last run {s.lastRunAt ? relativeTime(s.lastRunAt) : 'never'}
		</span>
		<span class="flex-1"></span>
		<div class="flex flex-wrap items-center gap-1">
			{#if canActivate(s) && s.approval.state !== 'pending'}
				<Button size="sm" disabled={busy} onclick={openActivate}><LightningIcon class="size-4" /> Activate</Button>
			{/if}
			{#if s.status === 'active'}
				<Button size="sm" variant="outline" disabled={busy} onclick={() => (confirmRun = true)}><PlayIcon class="size-4" /> Run now</Button>
				<Button size="sm" variant="ghost" disabled={busy} onclick={() => void disable()}><PauseIcon class="size-4" /> Disable</Button>
			{:else if s.status === 'disabled'}
				<Button size="sm" variant="outline" disabled={busy} onclick={() => void enable()}><PlayIcon class="size-4" /> Enable</Button>
			{/if}
			<Button size="icon-sm" variant="ghost" disabled={busy} aria-label="Rename or describe" title="Rename or describe" onclick={openEdit}><PencilSimpleIcon class="size-4" /></Button>
			<Button size="icon-sm" variant="ghost" disabled={busy} aria-label="Delete the script" title="Delete" onclick={() => { deleteName = ''; deleting = true; }}><TrashIcon class="size-4" /></Button>
		</div>
	</div>

	{#if triggers.length}
		<p class="text-xs text-muted-foreground">Runs on: {triggers.join(' · ')}{s.status === 'active' && s.activeVersion !== s.latestVersion ? ` (latest version; v${s.activeVersion} is running)` : ''}</p>
	{/if}

	{#if s.approval.state === 'pending'}
		<div class="flex flex-col gap-2 rounded-md border border-[color-mix(in_srgb,var(--info)_30%,var(--card))] bg-info-soft p-3">
			<p class="font-medium text-info-text">v{s.approval.version} waits for your approval</p>
			<p class="text-xs">
				{#if s.approval.by}Asked by {s.approval.by}{/if}{#if s.approval.at} {relativeTime(s.approval.at)}{/if}.
				{#if s.approval.note}<span class="text-muted-foreground">“{s.approval.note}”</span>{/if}
			</p>
			{#if detail.widening.length}
				<div class="text-xs">
					<span class="font-medium">Why it needs approval:</span>
					<ul class="mt-0.5 list-disc pl-5">{#each detail.widening as w, i (i)}<li>{w}</li>{/each}</ul>
				</div>
			{/if}
			<div class="flex flex-wrap items-center gap-2">
				<Button size="sm" disabled={busy} onclick={() => openDecision('approve')}><CheckIcon class="size-4" /> Approve</Button>
				<Button size="sm" variant="outline" disabled={busy} onclick={() => openDecision('reject')}><XIcon class="size-4" /> Reject</Button>
				{#if s.approval.version}
					{@const v = s.approval.version}
					<button type="button" class="text-xs underline underline-offset-4 hover:text-foreground" onclick={() => onViewVersion(v)}>View code of v{v}</button>
				{/if}
			</div>
		</div>
	{:else if s.approval.state === 'rejected'}
		<p class="text-xs text-muted-foreground">v{s.approval.version} was rejected{s.approval.by ? ` by ${s.approval.by}` : ''}{s.approval.note ? `: “${s.approval.note}”` : '.'}</p>
	{:else if canActivate(s) && detail.widening.length}
		<p class="text-xs text-muted-foreground">Activating v{s.latestVersion}: {detail.widening.join('; ')}.</p>
	{/if}
</Surface>

<Dialog.Root open={decision !== null} onOpenChange={(o) => { if (!o) decision = null; }}>
	<Dialog.Content elevation="floating" class="sm:max-w-md">
		<form class="flex flex-col gap-4" onsubmit={decide}>
			<Dialog.Header>
				<Dialog.Title>{decision === 'approve' ? 'Approve' : 'Reject'} v{s.approval.version}?</Dialog.Title>
				<Dialog.Description>{decision === 'approve' ? 'The version becomes active and runs on its triggers.' : 'The version is not activated. A running version keeps running.'}</Dialog.Description>
			</Dialog.Header>
			<Field.Field>
				<Field.Label for="decision-note">Note (optional)</Field.Label>
				<Textarea id="decision-note" bind:value={decisionNote} rows={2} />
			</Field.Field>
			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => (decision = null)}>Cancel</Button>
				<Button type="submit" variant={decision === 'reject' ? 'destructive' : 'default'} disabled={busy}>{decision === 'approve' ? 'Approve' : 'Reject'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={activating}>
	<Dialog.Content elevation="floating" class="sm:max-w-md">
		<form class="flex flex-col gap-4" onsubmit={activate}>
			<Dialog.Header>
				<Dialog.Title>Activate a version</Dialog.Title>
				<Dialog.Description>The version runs on its triggers from now on, with the grants of its manifest. Dry-run it first.</Dialog.Description>
			</Dialog.Header>
			<Field.Field>
				<Field.Label for="activate-version">Version</Field.Label>
				<NativeSelect id="activate-version" bind:value={activateVersion}>
					{#each versionsDesc as v (v)}<NativeSelectOption value={String(v)}>v{v}{v === s.latestVersion ? ' (latest)' : ''}{v === s.activeVersion ? ' (active)' : ''}</NativeSelectOption>{/each}
				</NativeSelect>
			</Field.Field>
			<Field.Field>
				<Field.Label for="activate-note">Note (optional)</Field.Label>
				<Input id="activate-note" bind:value={activateNote} autocomplete="off" />
			</Field.Field>
			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => (activating = false)}>Cancel</Button>
				<Button type="submit" disabled={busy}>Activate</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={editing}>
	<Dialog.Content elevation="floating" class="sm:max-w-md">
		<form class="flex flex-col gap-4" onsubmit={saveDetails}>
			<Dialog.Header>
				<Dialog.Title>Rename or describe</Dialog.Title>
				<Dialog.Description>This does not create a new version.</Dialog.Description>
			</Dialog.Header>
			<Field.Field data-invalid={!!editError}>
				<Field.Label for="edit-script-name">Name</Field.Label>
				<Input id="edit-script-name" bind:value={editName} class="font-mono text-xs" autocomplete="off" aria-invalid={!!editError} />
			</Field.Field>
			<Field.Field>
				<Field.Label for="edit-script-description">Description</Field.Label>
				<Input id="edit-script-description" bind:value={editDescription} autocomplete="off" />
			</Field.Field>
			{#if editError}<p class="text-sm text-destructive-text" role="alert">{editError}</p>{/if}
			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => (editing = false)}>Cancel</Button>
				<Button type="submit" disabled={busy}>Save</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={deleting}>
	<Dialog.Content elevation="floating" class="sm:max-w-md">
		<form class="flex flex-col gap-4" onsubmit={remove}>
			<Dialog.Header>
				<Dialog.Title>Delete {s.name}?</Dialog.Title>
				<Dialog.Description>The script, its versions, runs and state are deleted. This cannot be undone. Type its name to confirm.</Dialog.Description>
			</Dialog.Header>
			<Input bind:value={deleteName} placeholder={s.name} class="font-mono text-xs" autocomplete="off" aria-label="Script name" />
			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => (deleting = false)}>Cancel</Button>
				<Button type="submit" variant="destructive" disabled={busy || deleteName.trim() !== s.name}>Delete</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={confirmRun}
	title="Run {s.name} now?"
	description="This is a real run of v{s.activeVersion}: messages are sent and data is written as its code says. Use a dry run to test."
	confirmLabel="Run now"
	confirmVariant="default"
	onConfirm={runNow}
/>
