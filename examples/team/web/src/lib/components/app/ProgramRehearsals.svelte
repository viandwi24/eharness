<script lang="ts">
	import FlaskIcon from 'phosphor-svelte/lib/Flask';
	import { onDestroy } from 'svelte';
	import { api } from '#lib/api/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import type { Program } from '#lib/programs/form.js';
	import { rehearsalBadge, type Rehearsal } from '#lib/rehearsal/model.js';
	import { formatUsd } from '#lib/time.js';
	import Surface from './Surface.svelte';

	/** The recent test runs of a program, newest first. */
	let { program }: { program: Program } = $props();

	let list = $state<Rehearsal[] | null>(null);
	let error = $state('');
	let seq = 0;

	async function load(): Promise<void> {
		const mine = ++seq;
		try {
			const r = await api.get('/programs/{id}/rehearsals', { params: { id: program.id } });
			if (mine !== seq) return;
			list = r.rehearsals;
			error = '';
		} catch (e) {
			if (mine === seq) error = e instanceof Error ? e.message : 'Could not load the test runs';
		}
	}
	$effect(() => {
		void program.id;
		void load();
	});
	const timer = setInterval(() => {
		if (list?.some((r) => r.status === 'running')) void load();
	}, 2000);
	onDestroy(() => clearInterval(timer));

	const when = (ms: number): string => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
</script>

<section class="flex flex-col gap-2" data-testid="program-rehearsals">
	{#if error}
		<p class="text-sm text-destructive-text" role="alert">{error}</p>
	{:else if list === null}
		<Skeleton class="h-12 w-full" />
	{:else if list.length === 0}
		<Empty.Root class="border border-dashed border-border">
			<Empty.Header>
				<Empty.Media variant="icon"><FlaskIcon /></Empty.Media>
				<Empty.Title>No test runs yet</Empty.Title>
				<Empty.Description>A test run shows what the program does on sample data, before you let it loose: files, outside actions that would happen, decisions it would ask for, and the cost.</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else}
		<Surface class="divide-y divide-border text-sm">
			{#each list as r (r.id)}
				{@const b = rehearsalBadge(r)}
				<a class="flex flex-wrap items-center gap-2 px-3 py-2.5 hover:bg-accent/40" href="/programs/{program.id}/rehearsals/{r.id}">
					<Badge variant={b.variant}>{b.label}</Badge>
					{#if r.testId}<Badge variant="secondary">test case</Badge>{/if}
					<span class="min-w-0 flex-1 truncate">{r.report?.summary ?? (r.status === 'running' ? 'Running…' : (r.error ?? 'No report'))}</span>
					{#if r.simulated.length}<span class="text-xs text-muted-foreground">{r.simulated.length} simulated</span>{/if}
					{#if r.wouldAsk.length}<span class="text-xs text-muted-foreground">{r.wouldAsk.length} would ask</span>{/if}
					<span class="font-mono text-xs text-muted-foreground">{formatUsd(r.costUsd)}</span>
					<span class="text-xs text-muted-foreground">{when(r.startedAt)}</span>
				</a>
			{/each}
		</Surface>
	{/if}
</section>
