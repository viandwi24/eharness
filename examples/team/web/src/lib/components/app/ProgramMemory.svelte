<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { api } from '#lib/api/index.js';
	import Surface from '#lib/components/app/Surface.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { live } from '#lib/stores/live.svelte.js';
	import { timeAgo } from '#lib/time.js';
	import type { Program } from '#lib/programs/form.js';

	/**
	 * Answers like "keep waiting" the client gave to a question of this program. Later runs are told
	 * about them and do not ask the same thing again until they expire; "Forget" makes the program ask again.
	 */
	let { program }: { program: Program } = $props();

	type Remembered = { id: string; subject: string; question: string; choice: string; note: string; decidedAt: number; expiresAt: number };
	let items = $state<Remembered[]>([]);
	let loaded = $state(false);
	let seq = 0;

	async function load(): Promise<void> {
		const mine = ++seq;
		try {
			const r = await api.get('/programs/{id}/memory', { params: { id: program.id } });
			if (mine === seq) items = r.remembered;
		} catch {
			if (mine === seq) items = [];
		} finally {
			loaded = true;
		}
	}
	$effect(() => {
		void program.id;
		void live.state.revs.decisions;
		void load();
	});
	onMount(() => void load());

	async function forget(item: Remembered): Promise<void> {
		try {
			const r = await api.delete('/programs/{id}/memory/{memoryId}', { params: { id: program.id, memoryId: item.id } });
			items = r.remembered;
			toast.success('Forgotten: the program will ask again');
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not forget it');
		}
	}

	const until = (at: number): string => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
</script>

{#if loaded && items.length}
	<Surface class="flex flex-col gap-2 p-4 text-sm" data-testid="program-memory">
		<div>
			<h3 class="font-medium">Decisions it remembers</h3>
			<p class="text-xs text-muted-foreground">Your earlier answers. Later runs do not ask these again until they expire.</p>
		</div>
		<ul class="flex flex-col divide-y divide-border">
			{#each items as m (m.id)}
				<li class="flex items-start gap-3 py-2" data-testid="remembered-decision">
					<div class="min-w-0 flex-1">
						<p class="text-[13px] font-medium break-words">{m.subject}: {m.choice}</p>
						<p class="text-xs text-muted-foreground break-words">{m.question}</p>
						<p class="text-xs text-muted-foreground">Answered {timeAgo(m.decidedAt)} · valid until {until(m.expiresAt)}{m.note ? ` · ${m.note}` : ''}</p>
					</div>
					<Button size="xs" variant="outline" onclick={() => void forget(m)}>Forget</Button>
				</li>
			{/each}
		</ul>
	</Surface>
{/if}
