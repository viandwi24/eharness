<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '#lib/api/index.js';
	import ConfirmDialog from '#lib/components/app/ConfirmDialog.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import type { components } from '#lib/api/schema.js';

	type Suggestions = components['schemas']['ChannelRoleSuggestions'];
	type Suggestion = Suggestions['admins'][number];

	/** Directory onboarding: most people have no role yet. Bulk member, review suggested admins. */
	let { id, onChanged }: { id: string; onChanged: () => void | Promise<void> } = $props();

	let suggestions = $state<Suggestions>({ admins: [], members: [] });
	let busy = $state(false);
	let confirm = $state(false);
	let review = $state(false);
	let applied = $state<Record<string, boolean>>({});

	const noRole = $derived(suggestions.admins.length + suggestions.members.length);
	const label = (s: Suggestion): string => s.name ?? (s.username ? `@${s.username}` : s.peerId);

	async function load(): Promise<void> {
		try {
			suggestions = await api.get('/channels/connections/{id}/people/suggestions', { params: { id } });
		} catch {
			// the banner is a convenience: the table still works
		}
	}
	onMount(() => void load());

	async function refresh(): Promise<void> {
		await load();
		await onChanged();
	}

	async function makeMembers(): Promise<void> {
		busy = true;
		try {
			// everybody without a role who is not suggested as an admin stays out of the way: they are excluded here
			const r = await api.post('/channels/connections/{id}/people/bulk-role', {
				params: { id },
				body: { role: 'member', allWithoutRole: true, exclude: suggestions.admins.map((a) => a.peerId) }
			});
			toast.success(`${r.updated} people are members now${r.skipped > 0 ? `, ${r.skipped} skipped` : ''}`);
			await refresh();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not set the roles');
		} finally {
			busy = false;
		}
	}

	async function apply(s: Suggestion): Promise<void> {
		busy = true;
		try {
			await api.put('/channels/connections/{id}/people/{peerId}/role', { params: { id, peerId: s.peerId }, body: { role: 'admin' } });
			applied[s.peerId] = true;
			toast.success(`${label(s)} is an admin now`);
			await refresh();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not set the role');
		} finally {
			busy = false;
		}
	}
</script>

{#if noRole >= 2}
	<section class="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-label="People without a role" data-testid="role-onboarding">
		<div class="flex flex-col gap-1">
			<h2 class="text-sm font-medium">{noRole} people have no role: they only get answers</h2>
			<p class="text-xs text-muted-foreground">Members can read the chats of their divisions and set their own reminders. Admins can also approve and use write tools. Nothing changes until you confirm.</p>
		</div>
		<div class="flex flex-wrap gap-2">
			<Button size="sm" onclick={() => (confirm = true)} disabled={busy || suggestions.members.length === 0} data-testid="make-members">Make everyone who wrote here a member</Button>
			<Button size="sm" variant="outline" onclick={() => (review = !review)} disabled={suggestions.admins.length === 0} data-testid="review-admins">
				{review ? 'Hide suggested admins' : `Review suggested admins (${suggestions.admins.length})`}
			</Button>
		</div>
		{#if review}
			<ul class="flex flex-col divide-y divide-border rounded-lg border border-border" data-testid="suggested-admins">
				{#each suggestions.admins as s (s.peerId)}
					<li class="flex flex-wrap items-center justify-between gap-2 p-2">
						<div class="flex min-w-0 flex-col">
							<span class="truncate text-sm font-medium">{label(s)}</span>
							<span class="text-xs text-muted-foreground">{s.reason} · id {s.peerId}</span>
						</div>
						{#if applied[s.peerId]}
							<Badge variant="secondary">Admin</Badge>
						{:else}
							<Button size="sm" variant="outline" onclick={() => void apply(s)} disabled={busy}>Apply admin</Button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{/if}

<ConfirmDialog
	bind:open={confirm}
	title="Make {suggestions.members.length} people members?"
	description="Everybody who wrote here and has no role becomes a member. Bots and the people suggested as admins are left out. You can change any role later."
	confirmLabel="Make members"
	confirmVariant="default"
	onConfirm={makeMembers}
/>
