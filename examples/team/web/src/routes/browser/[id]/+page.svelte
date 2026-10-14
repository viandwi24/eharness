<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { api, ApiError } from '#lib/api/index.js';
	import LiveView from '#lib/components/app/browser/LiveView.svelte';
	import ProfileSettings from '#lib/components/app/browser/ProfileSettings.svelte';
	import RuntimeCard from '#lib/components/app/browser/RuntimeCard.svelte';
	import UsagePanel from '#lib/components/app/browser/UsagePanel.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { loadBrowserNav } from '#lib/browser/nav.svelte.js';
	import { type BrowserAdapter, type BrowserProfile, type BrowserShot, modeLabel, stateBadge } from '#lib/browser/model.js';
	import { timeAgo } from '#lib/time.js';

	const id = $derived(page.params.id as string);
	let profile = $state<BrowserProfile | null>(null);
	let adapter = $state<BrowserAdapter | undefined>();
	let shots = $state<BrowserShot[]>([]);
	let error = $state('');
	let busy = $state(false);

	async function load(): Promise<void> {
		try {
			profile = await api.get('/browser/profiles/{id}', { params: { id } });
			error = '';
		} catch (e) {
			error = e instanceof ApiError && e.status === 404 ? 'This browser profile does not exist.' : e instanceof Error ? e.message : 'Could not load the profile';
		}
	}
	async function loadShots(): Promise<void> {
		try {
			shots = await api.get('/browser/profiles/{id}/shots', { params: { id }, query: { limit: 12 } });
		} catch {
			// no screenshots yet
		}
	}
	onMount(() => {
		void load();
		void loadShots();
		void api.get('/browser/adapters').then((o) => (adapter = o.adapters.find((a) => a.id === profile?.adapter)), () => undefined);
		const t = setInterval(() => {
			if (document.visibilityState === 'visible') void load();
		}, 4000);
		const s = setInterval(() => document.visibilityState === 'visible' && void loadShots(), 15000);
		return () => (clearInterval(t), clearInterval(s));
	});
	$effect(() => {
		if (profile && !adapter) void api.get('/browser/adapters').then((o) => (adapter = o.adapters.find((a) => a.id === profile?.adapter)), () => undefined);
	});

	async function run(kind: 'start' | 'stop'): Promise<void> {
		busy = true;
		try {
			profile = await api.post(kind === 'start' ? '/browser/profiles/{id}/start' : '/browser/profiles/{id}/stop', { params: { id } });
		} catch (e) {
			toast.error(e instanceof Error ? e.message : `Could not ${kind}`);
		} finally {
			busy = false;
		}
	}
	const badge = $derived(profile ? stateBadge(profile) : undefined);
	const live = $derived(profile?.capabilities ? profile.capabilities.liveView !== 'none' : true);
	const usable = $derived(profile !== null && !['missing', 'installing', 'error'].includes(profile.state));
	const canStart = $derived(profile?.mode === 'managed' && ['ready', 'error'].includes(profile.state));
	const canStop = $derived(profile !== null && ['running', 'in-use', 'controlled'].includes(profile.state));
</script>

{#snippet actions()}
	{#if canStart}<Button size="sm" disabled={busy} onclick={() => void run('start')} data-testid="start-browser">Start</Button>{/if}
	{#if canStop}<Button size="sm" variant="outline" disabled={busy} onclick={() => void run('stop')} data-testid="stop-browser">Stop</Button>{/if}
{/snippet}

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title={profile?.name ?? 'Browser'} description={profile ? `${profile.adapter} · ${modeLabel(profile.mode)}${profile.runsOn === 'remote' ? ` · on ${profile.runtime?.host ?? 'the Remote sandbox'}` : ''}` : undefined} breadcrumb={[{ label: 'Browser', href: '/browser' }]} backHref="/browser" {actions} />
	<PageBody size="full" class="gap-4">
		{#if error}
			<p class="text-sm text-destructive-text" role="alert">{error} <a class="underline underline-offset-4" href="/browser">Back to the list</a></p>
		{:else if profile === null}
			<p class="text-sm text-muted-foreground">Loading…</p>
		{:else}
			<div class="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
				<div class="flex min-w-0 flex-col gap-3">
					{#if badge}<div class="flex flex-wrap items-center gap-2"><Badge variant={badge.variant}>{badge.label}</Badge>{#if profile.trusted}<Badge variant="outline">Trusted</Badge>{/if}{#if profile.lease?.page}<span class="truncate text-xs text-muted-foreground">{profile.lease.page.title || profile.lease.page.url}</span>{/if}</div>{/if}
					{#if profile.state === 'missing' || profile.state === 'installing' || (profile.state === 'error' && profile.runtime?.error)}
						{@const engine = profile.runsOn === 'remote' ? adapter?.remote : adapter?.runtime}
						{#if adapter && engine}<RuntimeCard adapter={engine.adapter} label={profile.runsOn === 'remote' ? `${adapter.label} on ${engine.host ?? 'the Remote sandbox'}` : adapter.label} runtime={engine} onChange={() => void load()} />{:else}<p class="text-sm text-muted-foreground">The engine is not ready ({profile.runtime?.error ?? profile.state}).</p>{/if}
					{/if}
					{#if !live}
						<p class="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">This browser has no live view.</p>
					{:else if usable && !(profile.mode === 'managed' && profile.state === 'ready')}
						{#if profile.adapter === 'lightpanda'}
							<p class="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground" data-testid="lightpanda-note">Lightpanda draws an approximate picture of the page, so clicks on it can miss. In control, use the address bar, the paste box and the keyboard. For logins and CAPTCHAs use a Chrome profile.</p>
						{/if}
						{#key profile.id}
							<LiveView profileId={profile.id} liveUrl={profile.liveUrl} agentHolds={profile.lease?.holder?.kind === 'session'} />
						{/key}
					{:else if usable}
						<p class="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">The browser is not running. Press Start to watch it.</p>
					{:else}
						<p class="text-xs text-muted-foreground">The live view opens once the browser is ready.</p>
					{/if}
				</div>
				<div class="flex min-w-0 flex-col gap-4">
					<UsagePanel profileId={profile.id} />
					<section class="flex flex-col gap-2 rounded-xl border border-border bg-card p-4" aria-label="Recent screenshots" data-testid="browser-shots">
						<h2 class="text-sm font-medium">Recent screenshots</h2>
						{#if shots.length === 0}
							<p class="text-xs text-muted-foreground">Agents have not taken any yet.</p>
						{:else}
							<ul class="grid grid-cols-2 gap-2">
								{#each shots as s (s.path)}
									<li>
										<a href={s.url} target="_blank" rel="noreferrer" class="flex flex-col gap-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring">
											<img src={s.url} alt="Screenshot {s.path}" loading="lazy" class="aspect-video w-full rounded border border-border object-cover object-top" />
											<span class="truncate text-[11px] text-muted-foreground">{s.agent?.name ?? 'Agent'} · {timeAgo(s.updatedAt)}</span>
										</a>
									</li>
								{/each}
							</ul>
						{/if}
					</section>
					<ProfileSettings {profile} {adapter} onChange={(p) => (profile = p)} onDeleted={() => void loadBrowserNav()} />
				</div>
			</div>
		{/if}
	</PageBody>
</div>
