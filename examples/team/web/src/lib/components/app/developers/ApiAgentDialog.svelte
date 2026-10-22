<script lang="ts">
	import { untrack } from 'svelte';
	import { api } from '#lib/api/index.js';
	import ConfirmDialog from '#lib/components/app/ConfirmDialog.svelte';
	import ModelPicker from '#lib/components/app/ModelPicker.svelte';
	import FolderPicker from './FolderPicker.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import type { ApiAgent } from '#lib/developers/model.js';

	let { open = $bindable(false), agent, onSaved }: { open?: boolean; agent?: ApiAgent | undefined; onSaved: () => void } = $props();

	let name = $state('');
	let slug = $state('');
	let description = $state('');
	let instructions = $state('');
	let rules = $state('');
	let model = $state<string | null>(null);
	let modelProfile = $state<string | null>(null);
	let readFolders = $state<string[]>([]);
	let writeFolder = $state<string[]>([]);
	let webSearch = $state(false);
	let retentionDays = $state('30');
	let saving = $state(false);
	let error = $state('');
	let confirmArchive = $state(false);
	let session = $state(0);

	$effect(() => {
		if (!open) return;
		untrack(() => {
			session++;
			name = agent?.name ?? '';
			slug = agent?.slug ?? '';
			description = agent?.description ?? '';
			instructions = agent?.instructions ?? '';
			rules = (agent?.rules ?? []).join('\n');
			model = agent?.model ?? null;
			modelProfile = agent?.modelProfile ?? null;
			readFolders = [...(agent?.readFolders ?? [])];
			writeFolder = agent?.writeFolder ? [agent.writeFolder] : [];
			webSearch = agent?.webSearch ?? false;
			retentionDays = String(agent?.retentionDays ?? 30);
			error = '';
		});
	});

	async function save(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		saving = true;
		error = '';
		const body = {
			name: name.trim(),
			description: description.trim(),
			instructions,
			rules: rules.split('\n').map((r) => r.trim()).filter((r) => r !== ''),
			model,
			modelProfile,
			readFolders,
			writeFolder: writeFolder[0] ?? null,
			webSearch,
			retentionDays: Number(retentionDays)
		};
		try {
			if (agent) await api.patch('/developer/agents/{id}', { params: { id: agent.id }, body });
			else await api.post('/developer/agents', { body: { ...body, ...(slug.trim() ? { slug: slug.trim() } : {}) } });
			toast.success(agent ? 'API agent saved' : 'API agent created');
			open = false;
			onSaved();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not save the agent';
		} finally {
			saving = false;
		}
	}

	async function archive(): Promise<void> {
		if (!agent) return;
		try {
			await api.delete('/developer/agents/{id}', { params: { id: agent.id } });
			toast.success('API agent archived');
			open = false;
			onSaved();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not archive the agent');
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content elevation="floating" class="flex max-h-[90svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
		<Dialog.Header class="border-b border-border px-5 py-4">
			<Dialog.Title>{agent ? 'Edit API agent' : 'New API agent'}</Dialog.Title>
			<Dialog.Description>An isolated agent that other applications call. It starts with no tools: grant only what it needs.</Dialog.Description>
		</Dialog.Header>
		<form id="api-agent-form" onsubmit={save} class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4 text-sm">
			{#key session}
				<label class="flex flex-col gap-1">
					<span class="font-medium">Name</span>
					<Input bind:value={name} required maxlength={80} placeholder="Support bot" data-testid="api-agent-name" />
				</label>
				{#if !agent}
					<label class="flex flex-col gap-1">
						<span class="font-medium">Slug</span>
						<Input bind:value={slug} placeholder="support-bot" class="font-mono" />
						<span class="text-xs text-muted-foreground">Used in the URL: <span class="font-mono">/v1/agents/&lt;slug&gt;/run</span>. Empty: made from the name.</span>
					</label>
				{/if}
				<label class="flex flex-col gap-1">
					<span class="font-medium">Description</span>
					<Input bind:value={description} maxlength={500} placeholder="Answers questions from the help center" />
				</label>
				<label class="flex flex-col gap-1">
					<span class="font-medium">Instructions</span>
					<Textarea bind:value={instructions} rows={7} required placeholder="What should this agent do, and how should it answer?" data-testid="api-agent-instructions" />
				</label>
				<label class="flex flex-col gap-1">
					<span class="font-medium">Rules</span>
					<Textarea bind:value={rules} rows={3} placeholder="One rule per line, e.g. Never give legal advice." />
					<span class="text-xs text-muted-foreground">Added to its prompt. What callers send is always treated as untrusted; that rule is built in.</span>
				</label>
				<div class="flex flex-col gap-1">
					<span class="font-medium">Model</span>
					<ModelPicker bind:profileId={modelProfile} bind:modelId={model} id="api-agent-model" />
				</div>
				<div class="rounded-lg border border-border bg-muted/30 p-3">
					<h3 class="mb-2 font-medium">Access</h3>
					<div class="flex flex-col gap-4">
						<FolderPicker bind:value={readFolders} label="Library folders it can read" />
						<FolderPicker bind:value={writeFolder} single label="One folder it can also write to (optional)" />
						<label class="flex items-center justify-between gap-3">
							<span class="flex flex-col"><span class="font-medium">Web search</span><span class="text-xs text-muted-foreground">Needs a provider that can search. Off by default.</span></span>
							<Switch bind:checked={webSearch} aria-label="Web search" />
						</label>
						<p class="text-xs text-muted-foreground">Nothing else: no channels, no team agents, no memory of others, no programs, decisions, tasks or connectors.</p>
					</div>
				</div>
				<label class="flex flex-col gap-1">
					<span class="font-medium">Keep conversations for (days)</span>
					<Input type="number" min={1} max={3650} step={1} bind:value={retentionDays} class="max-w-40" />
					<span class="text-xs text-muted-foreground">A conversation with no message for this long is deleted with its messages.</span>
				</label>
			{/key}
			{#if error}<p class="text-sm text-destructive-text" role="alert">{error}</p>{/if}
		</form>
		<Dialog.Footer class="border-t border-border px-5 py-3 sm:justify-between">
			{#if agent}
				<Button type="button" variant="ghost" class="text-destructive-text" onclick={() => (confirmArchive = true)}>Archive</Button>
			{:else}
				<span></span>
			{/if}
			<div class="flex gap-2">
				<Button type="button" variant="outline" onclick={() => (open = false)}>Cancel</Button>
				<Button type="submit" form="api-agent-form" disabled={saving} data-testid="api-agent-save">{#if saving}<Spinner class="size-4" />{/if}{agent ? 'Save' : 'Create'}</Button>
			</div>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog bind:open={confirmArchive} title="Archive this API agent?" description="It stops answering API calls (callers get a 404). Nothing is deleted, but keys that name it no longer reach it." confirmLabel="Archive" onConfirm={archive} />
