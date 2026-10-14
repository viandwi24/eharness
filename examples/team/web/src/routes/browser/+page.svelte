<script lang="ts">
	import { onMount } from 'svelte';
	import GlobeIcon from 'phosphor-svelte/lib/Globe';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import { api } from '#lib/api/index.js';
	import NewProfileWizard from '#lib/components/app/browser/NewProfileWizard.svelte';
	import UsagePanel from '#lib/components/app/browser/UsagePanel.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { loadBrowserNav } from '#lib/browser/nav.svelte.js';
	import { type BrowserOverview, type BrowserProfile, modeLabel, stateBadge } from '#lib/browser/model.js';

	let profiles = $state<BrowserProfile[] | null>(null);
	let overview = $state<BrowserOverview | null>(null);
	let thumbs = $state<Record<string, string>>({});
	let error = $state('');
	let wizard = $state(false);

	async function load(): Promise<void> {
		try {
			profiles = await api.get('/browser/profiles');
			error = '';
			for (const p of profiles) {
				if (thumbs[p.id] !== undefined) continue;
				thumbs[p.id] = '';
				api.get('/browser/profiles/{id}/shots', { params: { id: p.id }, query: { limit: 1 } }).then(
					(s) => (thumbs[p.id] = s[0]?.url ?? ''),
					() => (thumbs[p.id] = '')
				);
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not load the browsers';
		}
	}
	async function loadOverview(): Promise<void> {
		try {
			overview = await api.get('/browser/adapters');
		} catch {
			// the wizard stays unavailable
		}
	}
	onMount(() => {
		void load();
		void loadOverview();
		const t = setInterval(() => {
			if (document.visibilityState === 'visible') void load();
		}, 5000);
		return () => clearInterval(t);
	});
	const off = $derived(overview?.driver === 'off');
</script>

{#snippet actions()}
	<Button size="sm" onclick={() => (wizard = !wizard)} disabled={overview === null} data-testid="new-browser"><PlusIcon class="size-4" /> New profile</Button>
{/snippet}

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title="Browser" description="Browsers your agents use: watch them live, take over, keep logins per profile." {actions} />
	<PageBody size="wide" class="gap-4">
		{#if off}
			<p class="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">Running a browser on this server is off (<span class="font-mono">TEAM_BROWSER_DRIVER</span>). You can still connect to an existing browser.</p>
		{/if}
		{#if wizard && overview}
			<NewProfileWizard {overview} onCancel={() => (wizard = false)} onCreated={() => { wizard = false; void load(); void loadBrowserNav(); void loadOverview(); }} />
		{/if}

		<div class="grid gap-4 lg:grid-cols-[1fr_18rem]">
			<div class="flex min-w-0 flex-col gap-3">
				{#if error && profiles === null}
					<p class="text-sm text-destructive-text" role="alert">{error} <button class="underline underline-offset-4" onclick={() => void load()}>Try again</button></p>
				{:else if profiles === null}
					<div class="flex flex-col gap-3" aria-busy="true">{#each [0, 1] as i (i)}<Skeleton class="h-28 w-full rounded-xl" />{/each}</div>
				{:else if profiles.length === 0}
					<div class="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground" data-testid="browser-empty">No browser profile yet. Create one to let an agent browse the web.</div>
				{:else}
					<ul class="flex flex-col gap-3" data-testid="browser-list">
						{#each profiles as p (p.id)}
							{@const badge = stateBadge(p)}
							<li>
								<a href="/browser/{p.id}" class="flex gap-3 rounded-xl border border-border bg-card p-3 outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring" data-testid="browser-row">
									<div class="flex h-20 w-32 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
										{#if thumbs[p.id]}<img src={thumbs[p.id]} alt="Last screenshot of {p.name}" class="size-full object-cover object-top" loading="lazy" />{:else}<GlobeIcon class="size-6 text-muted-foreground" />{/if}
									</div>
									<div class="flex min-w-0 flex-1 flex-col gap-1.5">
										<div class="flex flex-wrap items-center gap-2">
											<span class="truncate text-sm font-medium">{p.name}</span>
											<Badge variant={badge.variant}>{badge.label}</Badge>
											{#if p.trusted}<Badge variant="outline">Trusted</Badge>{/if}
										</div>
										<span class="text-xs text-muted-foreground">{p.adapter} · {modeLabel(p.mode)}{p.lease?.page ? ` · ${p.lease.page.title || p.lease.page.url}` : ''}</span>
										<span class="truncate text-xs text-muted-foreground">{p.agents.length ? `Agents: ${p.agents.map((a) => a.name).join(', ')}` : 'No agent uses it yet'}</span>
									</div>
								</a>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
			<UsagePanel />
		</div>
	</PageBody>
</div>
