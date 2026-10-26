<script lang="ts">
	import { goto } from '$app/navigation';
	import { untrack } from 'svelte';
	import BracketsCurlyIcon from 'phosphor-svelte/lib/BracketsCurly';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import { api } from '#lib/api/index.js';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import Surface from '#lib/components/app/Surface.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { relativeTime } from '#lib/routines/schedule.js';
	import { approvalLabel, SCRIPT_NAME, type Script, statusLabel, TEMPLATE_MANIFEST, TEMPLATE_SOURCE } from '#lib/scripts/scripts.js';
	import { live } from '#lib/stores/live.svelte.js';

	let scripts = $state<Script[] | null>(null);
	let error = $state('');
	let seq = 0;

	// the "New script" dialog
	let creating = $state(false);
	let name = $state('');
	let description = $state('');
	let nameError = $state('');
	let formError = $state('');
	let saving = $state(false);

	async function load(): Promise<void> {
		const mine = ++seq;
		try {
			const r = await api.get('/scripts');
			if (mine !== seq) return;
			scripts = [...r.scripts].sort((a, b) => b.updatedAt - a.updatedAt);
			error = '';
		} catch (e) {
			if (mine === seq) error = e instanceof Error ? e.message : 'Could not load the scripts';
		}
	}

	// first load, and a refetch when a script changes or runs (an agent, another tab or instance)
	$effect(() => {
		void live.state.revs.scripts;
		untrack(() => void load());
	});

	function openCreate(): void {
		name = '';
		description = '';
		nameError = '';
		formError = '';
		creating = true;
	}

	async function create(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		nameError = '';
		formError = '';
		const n = name.trim();
		if (!SCRIPT_NAME.test(n)) {
			nameError = 'Use lowercase letters, digits and -, starting with a letter (e.g. halo-forwarder).';
			return;
		}
		saving = true;
		try {
			const s = await api.post('/scripts', {
				body: { name: n, ...(description.trim() ? { description: description.trim() } : {}), source: TEMPLATE_SOURCE, manifest: TEMPLATE_MANIFEST, note: 'created from the template' }
			});
			creating = false;
			toast.success(`Script ${s.name} created`);
			void goto(`/scripts/${encodeURIComponent(s.name)}`);
		} catch (err) {
			formError = err instanceof Error ? err.message : 'Could not create the script';
		} finally {
			saving = false;
		}
	}
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title="Scripts" description="Small programs that run on chat events, schedules or table changes, without a model.">
		<Button size="sm" onclick={openCreate}><PlusIcon class="size-4" /> New script</Button>
	</PageHeader>

	<PageBody size="wide">
		{#if error}
			<p class="text-sm text-destructive-text" role="alert">{error} <button class="underline underline-offset-4" onclick={() => void load()}>Retry</button></p>
		{:else if !scripts}
			<div class="flex flex-col gap-2">
				{#each [0, 1, 2] as i (i)}<Skeleton class="h-12 w-full" />{/each}
			</div>
		{:else if !scripts.length}
			<Empty.Root class="border border-dashed border-border">
				<Empty.Header>
					<Empty.Media variant="icon"><BracketsCurlyIcon /></Empty.Media>
					<Empty.Title>No scripts yet</Empty.Title>
					<Empty.Description>
						A script is a short TypeScript function for repeatable, rule-based work: forward a chat message, count join requests, write a nightly report. It only touches what its grants allow. Ask an agent to write one, or start from a template.
					</Empty.Description>
				</Empty.Header>
				<Empty.Content>
					<Button onclick={openCreate}><PlusIcon class="size-4" /> New script</Button>
				</Empty.Content>
			</Empty.Root>
		{:else}
			<Surface>
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>Script</Table.Head>
							<Table.Head>Status</Table.Head>
							<Table.Head class="hidden sm:table-cell" data-numeric>Latest</Table.Head>
							<Table.Head class="hidden md:table-cell" data-numeric>Runs</Table.Head>
							<Table.Head class="hidden sm:table-cell">Last run</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each scripts as s (s.id)}
							{@const st = statusLabel(s)}
							{@const ap = approvalLabel(s)}
							<Table.Row class="cursor-pointer" onclick={() => void goto(`/scripts/${encodeURIComponent(s.name)}`)}>
								<Table.Cell class="whitespace-normal">
									<a href="/scripts/{encodeURIComponent(s.name)}" class="block font-mono text-[13px] font-medium outline-none focus-visible:underline" onclick={(e) => e.stopPropagation()}>{s.name}</a>
									{#if s.description}<div class="line-clamp-2 max-w-md text-xs break-words text-muted-foreground">{s.description}</div>{/if}
								</Table.Cell>
								<Table.Cell class="whitespace-normal">
									<div class="flex flex-wrap gap-1">
										<Badge variant={st.tone} title={st.title}><span class="max-w-48 truncate">{st.label}</span></Badge>
										{#if ap}<Badge variant={ap.tone}>{ap.label}</Badge>{/if}
									</div>
								</Table.Cell>
								<Table.Cell class="hidden font-mono text-xs text-muted-foreground sm:table-cell" data-numeric>v{s.latestVersion}</Table.Cell>
								<Table.Cell class="hidden md:table-cell" data-numeric>
									{s.runCount.toLocaleString()}
									{#if s.errorCount}<span class="text-xs text-destructive-text" title="Failed runs"> · {s.errorCount} failed</span>{/if}
								</Table.Cell>
								<Table.Cell class="hidden text-muted-foreground sm:table-cell" title={s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : undefined}>{s.lastRunAt ? relativeTime(s.lastRunAt) : 'Never'}</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Surface>
		{/if}
	</PageBody>
</div>

<Dialog.Root bind:open={creating}>
	<Dialog.Content elevation="floating" class="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
		<form class="flex flex-col gap-4" onsubmit={create}>
			<Dialog.Header>
				<Dialog.Title>New script</Dialog.Title>
				<Dialog.Description>It starts as a draft from a template that logs chat messages containing "halo" and has no grants. Edit and dry-run it, then activate it.</Dialog.Description>
			</Dialog.Header>
			<Field.Field data-invalid={!!nameError}>
				<Field.Label for="new-script-name">Name</Field.Label>
				<Input id="new-script-name" bind:value={name} placeholder="halo-forwarder" class="font-mono text-xs" aria-invalid={!!nameError} autocomplete="off" />
				{#if nameError}<Field.Error>{nameError}</Field.Error>{:else}<Field.Description>Lowercase letters, digits and -, starting with a letter.</Field.Description>{/if}
			</Field.Field>
			<Field.Field>
				<Field.Label for="new-script-description">Description</Field.Label>
				<Input id="new-script-description" bind:value={description} placeholder="What it does, for people and agents" autocomplete="off" />
			</Field.Field>
			{#if formError}<p class="text-sm text-destructive-text" role="alert">{formError}</p>{/if}
			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => (creating = false)}>Cancel</Button>
				<Button type="submit" disabled={saving}>Create script</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
