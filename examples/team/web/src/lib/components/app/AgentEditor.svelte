<script lang="ts">
	import Surface from '#lib/components/app/Surface.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import ModelPicker from '#lib/components/app/ModelPicker.svelte';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { fieldErrors, type Agent } from '#lib/api/index.js';
	import { agentColors } from '#lib/models.js';
	import { providersStore } from '#lib/providers/store.svelte.js';
	import { agentChoiceOf, agentChoices, storedOfChoice, type AgentChoice } from '#lib/modes.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { CONFLICT_TEXT, isVersionConflict } from '#lib/conflict.js';

	/** Without `agent` the editor creates one; with it, it edits (the lead cannot be archived). */
	let {
		agent,
		compact = false,
		bare = false,
		formId = 'agent-editor-form',
		saving = $bindable(false),
		valid = $bindable(false),
		dirty = $bindable(false),
		onDone
	}: {
		agent?: Agent;
		compact?: boolean;
		/** Dialog mode: no padding or footer; the host renders submit buttons with `form={formId}`. */
		bare?: boolean;
		formId?: string;
		saving?: boolean;
		valid?: boolean;
		/** Something differs from the saved agent (a new agent is dirty once it has a name). */
		dirty?: boolean;
		/** Called after a successful create, save or archive. */
		onDone?: (result: 'created' | 'saved' | 'archived') => void;
	} = $props();

	// svelte-ignore state_referenced_locally
	let name = $state(agent?.name ?? '');
	// svelte-ignore state_referenced_locally
	let color = $state(agent?.color ?? agentColors[0]);
	// svelte-ignore state_referenced_locally
	let description = $state(agent?.description ?? '');
	// svelte-ignore state_referenced_locally
	let instructions = $state(agent?.instructions ?? '');
	// svelte-ignore state_referenced_locally
	let model = $state<string | null>(agent?.model ?? null);
	// svelte-ignore state_referenced_locally
	let modelProfile = $state<string | null>(agent?.modelProfile ?? null);
	// svelte-ignore state_referenced_locally
	let modeChoice = $state<AgentChoice>(agentChoiceOf(agent?.permissionMode));
	// svelte-ignore state_referenced_locally
	let taskConcurrency = $state(String(agent?.taskConcurrency ?? 1));
	let errors = $state<Record<string, string>>({});
	let formError = $state('');

	$effect(() => {
		// an existing agent's voice and rules are the Persona tab's; a new agent starts from its instructions
		valid = !!name.trim() && (!!agent || !!instructions.trim());
	});

	$effect(() => {
		dirty = agent
			? name !== agent.name || color !== agent.color || description !== agent.description || (model || null) !== (agent.model ?? null) || (modelProfile || null) !== (agent.modelProfile ?? null) || modeChoice !== agentChoiceOf(agent.permissionMode) || taskConcurrency !== String(agent.taskConcurrency ?? 1)
			: !!name.trim() || !!instructions.trim();
	});

	const isLead = $derived(agent?.role === 'lead');

	onMount(() => {
		void providersStore.load();
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		saving = true;
		errors = {};
		formError = '';
		const body = {
			name: name.trim(),
			color,
			description,
			model: model || null,
			modelProfile: modelProfile || null,
			permissionMode: storedOfChoice(modeChoice) as Agent['permissionMode'],
			taskConcurrency: Number.parseInt(taskConcurrency, 10) || 1
		};
		try {
			if (agent) {
				await agentsStore.update(agent.id, { ...body, version: agent.version });
				toast.success('Agent saved');
				onDone?.('saved');
			} else {
				const created = await agentsStore.create({ ...body, instructions });
				toast.success(`${created.name} created`);
				onDone?.('created');
				await goto(`/a/${created.id}`);
			}
		} catch (err) {
			errors = fieldErrors(err);
			formError = isVersionConflict(err) ? CONFLICT_TEXT : err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}

	let confirmArchive = $state(false);
	async function archive() {
		if (!agent || isLead) return;
		try {
			await agentsStore.archive(agent.id);
			toast.success('Agent archived');
			onDone?.('archived');
			await goto('/');
		} catch (err) {
			formError = err instanceof Error ? err.message : String(err);
		}
	}
</script>

<form id={formId} class="flex flex-col gap-4 {compact || bare ? 'text-sm' : 'max-w-xl p-4'}" onsubmit={submit}>
	<div class="flex items-center gap-3">
		<AgentAvatar seed={agent?.id ?? (name || 'new')} {color} size={compact ? 40 : 56} label="Avatar preview" />
		<div class="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Avatar color">
			{#each agentColors as c (c)}
				<button
					type="button"
					role="radio"
					aria-checked={color === c}
					aria-label="Color {c}"
					class="size-6 rounded-full border-2 {color === c ? 'border-foreground' : 'border-transparent'}"
					style="background:{c}"
					onclick={() => (color = c)}
				></button>
			{/each}
		</div>
	</div>

	<label class="flex flex-col gap-1">
		<span class="font-medium">Name</span>
		<Input bind:value={name} placeholder="Researcher" aria-invalid={!!errors.name} />
		{#if errors.name}<span class="text-xs text-destructive-text">{errors.name}</span>{/if}
	</label>

	<label class="flex flex-col gap-1">
		<span class="font-medium">Description</span>
		<Input bind:value={description} placeholder="One line shown in the agent list" maxlength={280} aria-invalid={!!errors.description} />
		{#if errors.description}<span class="text-xs text-destructive-text">{errors.description}</span>{/if}
	</label>

	{#if agent}
		<p class="rounded-lg border border-border p-3 text-xs text-muted-foreground">
			Its name, voice, preferences and operating rules are on the <span class="font-medium text-foreground">Persona</span> tab: versioned, reviewable and revertable.
		</p>
	{:else}
		<label class="flex flex-col gap-1">
			<span class="font-medium">Instructions</span>
			<Textarea bind:value={instructions} rows={compact ? 6 : 10} placeholder="What should this agent do?" aria-invalid={!!errors.instructions} />
			{#if errors.instructions}<span class="text-xs text-destructive-text">{errors.instructions}</span>{/if}
			<span class="text-xs text-muted-foreground">After you create the agent you can choose its connectors (it starts with files (read only), memory and planning). The text becomes its first persona (voice) and operating rules; edit both later on the Persona tab.</span>
		</label>
	{/if}

	<div class="flex flex-col gap-1">
		<span class="font-medium" id="agent-model-label">Model</span>
		<ModelPicker bind:profileId={modelProfile} bind:modelId={model} id="agent-model" />
		{#if errors.model || errors.modelProfile}<span class="text-xs text-destructive-text">{errors.model ?? errors.modelProfile}</span>{/if}
	</div>

	<label class="flex flex-col gap-1">
		<span class="font-medium">Permission mode</span>
		<NativeSelect bind:value={modeChoice}>
			{#each agentChoices as m (m.id)}
				<NativeSelectOption value={m.id}>{m.label}</NativeSelectOption>
			{/each}
		</NativeSelect>
		<span class="text-xs text-muted-foreground">
			{agentChoices.find((m) => m.id === modeChoice)?.hint}
			A mode set here is also the loosest this agent can run in; delegated tasks follow the chat that started them, unless this agent is stricter.
		</span>
	</label>

	<label class="flex flex-col gap-1">
		<span class="font-medium">Tasks at once</span>
		<NativeSelect bind:value={taskConcurrency} aria-label="Tasks at once" data-testid="task-concurrency">
			{#each [1, 2, 3, 4, 5, 6, 7, 8] as n (n)}<NativeSelectOption value={String(n)}>{n}</NativeSelectOption>{/each}
		</NativeSelect>
		{#if errors.taskConcurrency}<span class="text-xs text-destructive-text">{errors.taskConcurrency}</span>{/if}
		<span class="text-xs text-muted-foreground">How many assigned tasks this agent works on at the same time. More wait as Queued and start when one finishes; the team-wide limit in Settings still applies.</span>
	</label>

	{#if formError && !Object.keys(errors).length}<p class="text-xs text-destructive-text" role="alert">{formError}</p>{/if}

	{#if !bare}
		<div class="flex items-center gap-2">
			<Button type="submit" disabled={saving || !valid}>
				{saving ? 'Saving…' : agent ? 'Save changes' : 'Create agent'}
			</Button>
			{#if agent}
				<Button type="button" variant="outline" class="ml-auto" disabled={isLead} title={isLead ? 'The lead cannot be archived' : undefined} onclick={() => (confirmArchive = true)}>
					Archive
				</Button>
			{/if}
		</div>
	{:else if agent && !isLead}
		<Surface class="flex items-center justify-between gap-3 rounded-lg p-3">
			<div class="min-w-0">
				<div class="font-medium">Archive agent</div>
				<div class="text-xs text-muted-foreground">Hides it from the list. Its history stays readable.</div>
			</div>
			<Button type="button" variant="outline" size="sm" onclick={() => (confirmArchive = true)}>Archive</Button>
		</Surface>
	{/if}
</form>

{#if agent}
	<ConfirmDialog bind:open={confirmArchive} title="Archive {agent.name}?" description="Its history stays readable." confirmLabel="Archive" onConfirm={archive} />
{/if}
