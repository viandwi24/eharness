<script lang="ts">
	import Surface from '#lib/components/app/Surface.svelte';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import ModelPicker from '#lib/components/app/ModelPicker.svelte';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { fieldErrors, type Agent, type ToolName } from '#lib/api/index.js';
	import { agentColors } from '#lib/models.js';
	import { providersStore } from '#lib/providers/store.svelte.js';
	import { agentChoiceOf, agentChoices, storedOfChoice, type AgentChoice } from '#lib/modes.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { toolsStore } from '#lib/stores/tools.svelte.js';

	/** Without `agent` the editor creates one; with it, it edits (the lead cannot be archived). */
	let {
		agent,
		compact = false,
		bare = false,
		formId = 'agent-editor-form',
		saving = $bindable(false),
		valid = $bindable(false),
		onDone
	}: {
		agent?: Agent;
		compact?: boolean;
		/** Dialog mode: no padding or footer; the host renders submit buttons with `form={formId}`. */
		bare?: boolean;
		formId?: string;
		saving?: boolean;
		valid?: boolean;
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
	let tools = $state<ToolName[]>([...(agent?.tools ?? ['library_read', 'memory', 'todos'])]);
	// svelte-ignore state_referenced_locally
	let modeChoice = $state<AgentChoice>(agentChoiceOf(agent?.permissionMode));
	let errors = $state<Record<string, string>>({});
	let formError = $state('');

	$effect(() => {
		valid = !!name.trim() && !!instructions.trim();
	});

	const isLead = $derived(agent?.role === 'lead');
	const toolError = $derived(Object.entries(errors).find(([k]) => k.startsWith('tools'))?.[1]);

	onMount(() => {
		void toolsStore.load();
		void providersStore.load();
	});

	function toggleTool(t: ToolName, on: boolean) {
		tools = on ? [...tools.filter((x) => x !== t), t] : tools.filter((x) => x !== t);
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		saving = true;
		errors = {};
		formError = '';
		const body = {
			name: name.trim(),
			color,
			description,
			instructions,
			model: model || null,
			modelProfile: modelProfile || null,
			tools,
			permissionMode: storedOfChoice(modeChoice) as Agent['permissionMode']
		};
		try {
			if (agent) {
				await agentsStore.update(agent.id, body);
				toast.success('Agent saved');
				onDone?.('saved');
			} else {
				const created = await agentsStore.create(body);
				toast.success(`${created.name} created`);
				onDone?.('created');
				await goto(`/a/${created.id}`);
			}
		} catch (err) {
			errors = fieldErrors(err);
			formError = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}

	async function archive() {
		if (!agent || isLead || !confirm(`Archive ${agent.name}? Its history stays readable.`)) return;
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

	<label class="flex flex-col gap-1">
		<span class="font-medium">Instructions</span>
		<Textarea bind:value={instructions} rows={compact ? 6 : 10} placeholder="What should this agent do?" aria-invalid={!!errors.instructions} />
		{#if errors.instructions}<span class="text-xs text-destructive-text">{errors.instructions}</span>{/if}
	</label>

	<div class="flex flex-col gap-1">
		<span class="font-medium" id="agent-model-label">Model</span>
		<ModelPicker bind:profileId={modelProfile} bind:modelId={model} id="agent-model" />
		{#if errors.model || errors.modelProfile}<span class="text-xs text-destructive-text">{errors.model ?? errors.modelProfile}</span>{/if}
	</div>

	<fieldset class="flex flex-col gap-2">
		<legend class="mb-1 font-medium">Tools</legend>
		{#each toolsStore.state.tools as t (t.name)}
			<label class="flex items-start gap-2">
				<Checkbox checked={tools.includes(t.name)} onCheckedChange={(v) => toggleTool(t.name, v === true)} class="mt-0.5" />
				<span class="min-w-0">
					<span class="font-mono text-xs">{t.name}</span>
					<span class="block text-xs text-muted-foreground">{t.description}</span>
				</span>
			</label>
		{:else}
			<p class="text-xs text-muted-foreground">{toolsStore.state.error ?? 'Loading tools…'}</p>
		{/each}
		{#if toolError}<span class="text-xs text-destructive-text">{toolError}</span>{/if}
	</fieldset>

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

	{#if formError && !Object.keys(errors).length}<p class="text-xs text-destructive-text" role="alert">{formError}</p>{/if}

	{#if !bare}
		<div class="flex items-center gap-2">
			<Button type="submit" disabled={saving || !valid}>
				{saving ? 'Saving…' : agent ? 'Save changes' : 'Create agent'}
			</Button>
			{#if agent}
				<Button type="button" variant="outline" class="ml-auto" disabled={isLead} title={isLead ? 'The lead cannot be archived' : undefined} onclick={archive}>
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
			<Button type="button" variant="outline" size="sm" onclick={archive}>Archive</Button>
		</Surface>
	{/if}
</form>
