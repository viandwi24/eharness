<script lang="ts">
	import { untrack } from 'svelte';
	import { api, fieldErrors, type PersonaState, type PersonaVersion } from '#lib/api/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { formatTime } from '#lib/format.js';
	import { authorText, diffRows, editOf, formOf, formProblems, proposerText, SOURCE_LABEL, type PersonaForm } from '#lib/persona/model.js';

	// The persona of one agent: who it is (identity), how it sounds (voice and preferences), what it
	// is responsible for (operating rules, admins only), proposals waiting for an admin and every
	// version with its diff. A save is a new version, effective from the agent's next message.
	let { agentId, visible = true }: { agentId: string; visible?: boolean } = $props();

	let persona = $state<PersonaState | null>(null);
	let history = $state<PersonaVersion[]>([]);
	let loadError = $state('');
	let form = $state<PersonaForm | null>(null);
	let errors = $state<Record<string, string>>({});
	let saving = $state(false);
	let busy = $state('');
	let seq = 0;
	let openVersion = $state<number | null>(null);

	async function load(): Promise<void> {
		const mine = ++seq;
		try {
			const [s, h] = await Promise.all([
				api.get('/agents/{id}/persona', { params: { id: agentId } }),
				api.get('/agents/{id}/persona/history', { params: { id: agentId } })
			]);
			if (mine !== seq) return;
			persona = s;
			history = h.items;
			loadError = '';
			// edits in the form are kept: it only follows the server while untouched
			if (form === null || untrack(() => !dirty)) form = formOf(s.current);
		} catch (e) {
			if (mine === seq) loadError = e instanceof Error ? e.message : 'Could not load the persona';
		}
	}
	$effect(() => {
		void agentId;
		if (visible) untrack(() => void load());
	});

	const patch = $derived(persona && form ? editOf(persona.current, form) : undefined);
	const dirty = $derived(patch !== undefined);
	const problems = $derived(persona && form ? formProblems(form, persona.limits, persona.current) : {});

	async function save(): Promise<void> {
		if (!persona || !form || !patch) return;
		saving = true;
		errors = {};
		try {
			const v = await api.patch('/agents/{id}/persona', { params: { id: agentId }, body: patch });
			toast.success(`Persona saved (version ${v.version}); the agent uses it from its next message`);
			form = null;
			await load();
		} catch (e) {
			errors = fieldErrors(e);
			toast.error(e instanceof Error ? e.message : 'Could not save the persona');
		} finally {
			saving = false;
		}
	}

	async function decide(id: string, what: 'apply' | 'reject'): Promise<void> {
		busy = id;
		try {
			await api.post(what === 'apply' ? '/agents/{id}/persona/proposals/{proposalId}/apply' : '/agents/{id}/persona/proposals/{proposalId}/reject', { params: { id: agentId, proposalId: id } });
			toast.success(what === 'apply' ? 'Proposal applied' : 'Proposal rejected');
			form = null;
			await load();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not decide the proposal');
			await load();
		} finally {
			busy = '';
		}
	}

	async function revert(version: number): Promise<void> {
		busy = `v${version}`;
		try {
			await api.post('/agents/{id}/persona/revert', { params: { id: agentId }, body: { version } });
			toast.success(`Restored version ${version} as a new version`);
			form = null;
			await load();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not revert');
		} finally {
			busy = '';
		}
	}
</script>

{#snippet diff(text: string)}
	<div class="flex flex-col gap-0.5 rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] leading-snug" data-testid="persona-diff">
		{#each diffRows(text) as row, i (i)}
			{#if row.kind === 'head'}
				<div class="mt-1 font-sans text-[11px] font-medium text-muted-foreground first:mt-0">{row.text}</div>
			{:else}
				<div class="whitespace-pre-wrap break-words {row.kind === 'add' ? 'text-success-text' : 'text-destructive-text'}">{row.kind === 'add' ? '+' : '−'} {row.text}</div>
			{/if}
		{/each}
	</div>
{/snippet}

<div class="flex flex-col gap-5 text-sm">
	{#if loadError}
		<p class="text-destructive-text" role="alert">{loadError}</p>
	{:else if !persona || !form}
		<div class="flex flex-col gap-2" aria-busy="true" aria-label="Loading the persona">
			{#each [0, 1, 2] as i (i)}<Skeleton class="h-9 w-full rounded-lg" />{/each}
		</div>
	{:else}
		{#if persona.pending.length > 0}
			<section class="flex flex-col gap-2" data-testid="persona-pending">
				<div class="font-medium">Pending proposals <Badge variant="warning" shape="number">{persona.pending.length}</Badge></div>
				<p class="text-xs text-muted-foreground">Somebody asked the agent for these changes. Nothing changes until you apply one.</p>
				<ul class="flex flex-col gap-2">
					{#each persona.pending as p (p.id)}
						<li class="flex flex-col gap-2 rounded-lg border border-border p-3">
							<div class="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
								<span class="font-medium text-foreground">{proposerText(p)}</span>
								<span>{formatTime(p.createdAt)}</span>
								{#if p.baseVersion !== persona.current.version}<Badge variant="warning">Written against version {p.baseVersion}</Badge>{/if}
							</div>
							<p class="text-xs">{p.reason}</p>
							{#if p.request}<p class="text-xs text-muted-foreground">Their words: “{p.request}”</p>{/if}
							{@render diff(p.diff)}
							<div class="flex items-center gap-2">
								<Button size="sm" disabled={busy === p.id} onclick={() => void decide(p.id, 'apply')}>Apply</Button>
								<Button size="sm" variant="outline" disabled={busy === p.id} onclick={() => void decide(p.id, 'reject')}>Reject</Button>
							</div>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		<section class="flex flex-col gap-3">
			<div>
				<div class="font-medium">Identity</div>
				<p class="text-xs text-muted-foreground">Version {persona.current.version}, {authorText(persona.current)}. A change takes effect from the agent's next message.</p>
			</div>
			<div class="grid gap-3 sm:grid-cols-2">
				<label class="flex flex-col gap-1">
					<span class="text-xs font-medium">Name it goes by</span>
					<Input bind:value={form.displayName} maxlength={60} aria-invalid={!!problems.displayName || !!errors.displayName} />
					{#if problems.displayName}<span class="text-xs text-destructive-text">{problems.displayName}</span>{/if}
				</label>
				<label class="flex flex-col gap-1">
					<span class="text-xs font-medium">Answers in</span>
					<Input bind:value={form.language} maxlength={40} placeholder="The language of the person" aria-invalid={!!problems.language} />
				</label>
				<label class="flex flex-col gap-1 sm:col-span-2">
					<span class="text-xs font-medium">About</span>
					<Input bind:value={form.about} maxlength={300} placeholder="One short line about what it is for" aria-invalid={!!problems.about} />
				</label>
				<div class="flex items-center justify-between gap-3 sm:col-span-2">
					<span class="text-xs font-medium">May use emoji</span>
					<Switch bind:checked={form.emoji} aria-label="May use emoji" />
				</div>
			</div>
		</section>

		<section class="flex flex-col gap-1.5">
			<div class="flex items-baseline justify-between gap-2">
				<div class="font-medium">Voice &amp; preferences</div>
				<span class="text-[11px] text-muted-foreground">{form.voice.length} / {persona.limits.voice}</span>
			</div>
			<Textarea bind:value={form.voice} rows={7} aria-label="Voice and preferences" placeholder="How it sounds and what it prefers: tone, wording, habits." aria-invalid={!!problems.voice || !!errors.voice} />
			{#if problems.voice || errors.voice}<span class="text-xs text-destructive-text">{problems.voice ?? errors.voice}</span>{/if}
			<p class="text-xs text-muted-foreground">Voice only. It cannot change rules, tools, permissions, approvals or who is an admin; text that tries to is refused.</p>
		</section>

		<section class="flex flex-col gap-1.5">
			<div class="flex items-baseline justify-between gap-2">
				<div class="font-medium">Operating rules</div>
				<span class="text-[11px] text-muted-foreground">{form.operatingRules.length} / {persona.limits.operatingRules}</span>
			</div>
			<Textarea bind:value={form.operatingRules} rows={6} aria-label="Operating rules" placeholder="What it is responsible for and how it escalates." aria-invalid={!!problems.operatingRules || !!errors.operatingRules} />
			{#if problems.operatingRules || errors.operatingRules}<span class="text-xs text-destructive-text">{problems.operatingRules ?? errors.operatingRules}</span>{/if}
			<p class="text-xs text-muted-foreground">Edited here only. The agent can read these rules but can neither propose nor apply a change to them.</p>
		</section>

		<section class="flex flex-col gap-1.5">
			<div class="font-medium">Channel overlays</div>
			<p class="text-xs text-muted-foreground">
				Tone, language and length of one chat or topic are set per place, on the
				<a class="underline underline-offset-2" href="/channels">Channels page</a>
				(Persona overlay, inherited down the tree, at most 1000 characters). An overlay never widens what the agent may do.
			</p>
		</section>

		<div class="sticky bottom-0 z-10 -mx-5 -mb-4 flex flex-wrap items-center gap-2 border-t border-border bg-background px-5 py-2.5" data-testid="persona-save-bar">
			{#if dirty}<span class="flex items-center gap-1.5 text-xs text-warning-text" role="status"><span class="size-1.5 rounded-full bg-warning"></span>Unsaved changes</span>{/if}
			<Input bind:value={form.reason} class="min-w-48 flex-1" maxlength={500} placeholder="Why (optional, shown in the history)" aria-label="Reason for the change" />
			<Button size="sm" disabled={!dirty || saving || Object.keys(problems).length > 0} onclick={() => void save()}>{saving ? 'Saving…' : 'Save as new version'}</Button>
			<Button size="sm" variant="ghost" disabled={!dirty || saving} onclick={() => (form = formOf(persona!.current))}>Reset</Button>
		</div>

		<section class="flex flex-col gap-2" data-testid="persona-history">
			<div class="font-medium">History</div>
			<ul class="flex flex-col divide-y divide-border rounded-lg border border-border">
				{#each history as v (v.version)}
					<li class="flex flex-col gap-1.5 px-3 py-2">
						<div class="flex items-center gap-2">
							<Badge variant={v.version === persona.current.version ? 'success' : 'secondary'}>v{v.version}</Badge>
							<span class="min-w-0 flex-1 truncate text-xs">
								<span class="font-medium">{authorText(v)}</span>
								{#if v.source !== 'migration' && (v.source !== 'web' || v.reason)}<span class="text-muted-foreground"> · {[v.source === 'web' ? '' : SOURCE_LABEL[v.source], v.reason].filter(Boolean).join(' · ')}</span>{/if}
							</span>
							<span class="shrink-0 text-[11px] text-muted-foreground">{formatTime(v.createdAt)}</span>
						</div>
						<div class="flex items-center gap-2">
							{#if v.diff}
								<Button size="sm" variant="ghost" class="h-7 px-2 text-xs" onclick={() => (openVersion = openVersion === v.version ? null : v.version)}>{openVersion === v.version ? 'Hide changes' : 'Show changes'}</Button>
							{/if}
							{#if v.version !== persona.current.version}
								<Button size="sm" variant="outline" class="h-7 px-2 text-xs" disabled={busy === `v${v.version}`} onclick={() => void revert(v.version)}>Revert to this</Button>
							{/if}
						</div>
						{#if openVersion === v.version && v.diff}{@render diff(v.diff)}{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>
