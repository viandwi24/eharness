<script lang="ts">
	// Scripts: whether a script an agent writes in a chat runs at once when the owner (or an admin)
	// asked for it there. Saved on change.
	import { onMount } from 'svelte';
	import { api } from '#lib/api/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';

	let on = $state<boolean | null>(null);
	let busy = $state(false);

	onMount(async () => {
		try {
			on = (await api.get('/settings')).scriptsChatApproval;
		} catch {
			on = null;
		}
	});

	async function change(next: boolean): Promise<void> {
		const before = on;
		on = next;
		busy = true;
		try {
			await api.patch('/settings', { body: { scriptsChatApproval: next } });
			toast.success(next ? 'Scripts asked for in a chat run at once' : 'Agent scripts wait for approval on the Scripts page');
		} catch (e) {
			on = before;
			toast.error(e instanceof Error ? e.message : 'Could not save');
		} finally {
			busy = false;
		}
	}
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Scripts</Card.Title>
		<Card.Description>How a script an agent writes gets turned on.</Card.Description>
	</Card.Header>
	<Card.Content>
		<label class="flex items-start gap-3">
			<Switch checked={on === true} disabled={on === null || busy} onCheckedChange={(v) => void change(v)} class="mt-0.5" aria-label="Run scripts asked for in a chat at once" />
			<span class="flex flex-col gap-0.5 text-sm">
				<span class="font-medium">Run at once when you ask for it in a chat</span>
				<span class="text-xs text-muted-foreground">
					On: when you (or an admin in a chat channel) ask an agent for a script, it runs as soon as the agent has tested it; your request is the approval. Scripts an agent writes on its own (a heartbeat, a program) still wait for approval on the Scripts page. Off: every script an agent writes waits for approval there.
				</span>
			</span>
		</label>
	</Card.Content>
</Card.Root>
