<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { fieldErrors, type Agent, type PermissionMode, type ToolName } from '#lib/api/index.js';
	import { agentColors, modelOptions, permissionModes } from '#lib/models.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { toolsStore } from '#lib/stores/tools.svelte.js';

	/** Without `agent` the editor creates one; with it, it edits (the lead cannot be archived). */
	let { agent, compact = false }: { agent?: Agent; compact?: boolean } = $props();

	// svelte-ignore state_referenced_locally
	let name = $state(agent?.name ?? '');
	// svelte-ignore state_referenced_locally
	let color = $state(agent?.color ?? agentColors[0]);
	// svelte-ignore state_referenced_locally
	let description = $state(agent?.description ?? '');
	// svelte-ignore state_referenced_locally
	let instructions = $state(agent?.instructions ?? '');
	// svelte-ignore state_referenced_locally
	let model = $state<string>(agent?.model ?? '');
	// svelte-ignore state_referenced_locally
	let tools = $state<ToolName[]>([...(agent?.tools ?? ['library_read', 'memory', 'todos'])]);
	// svelte-ignore state_referenced_locally
	let permissionMode = $state<PermissionMode>(agent?.permissionMode ?? 'default');
	let errors = $state<Record<string, string>>({});
	let formError = $state('');
	let saving = $state(false);

	const isLead = $derived(agent?.role === 'lead');
	const models = $derived(
		agent?.model && !modelOptions.some((m) => m.id === agent.model)
			? [...modelOptions, { id: agent.model, label: agent.model }]
			: modelOptions
	);
	const toolError = $derived(Object.entries(errors).find(([k]) => k.startsWith('tools'))?.[1]);

	onMount(() => void toolsStore.load());

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
			tools,
			permissionMode
		};
		try {
			if (agent) {
				await agentsStore.update(agent.id, body);
				toast.success('Agent saved');
			} else {
				const created = await agentsStore.create(body);
				toast.success(`${created.name} created`);
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
			await goto('/');
		} catch (err) {
			formError = err instanceof Error ? err.message : String(err);
		}
	}
</script>

<form class="flex flex-col gap-4 {compact ? 'text-sm' : 'max-w-xl p-4'}" onsubmit={submit}>
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

	<label class="flex flex-col gap-1">
		<span class="font-medium">Model</span>
		<NativeSelect bind:value={model}>
			{#each models as m (m.id ?? '')}
				<NativeSelectOption value={m.id ?? ''}>{m.label}</NativeSelectOption>
			{/each}
		</NativeSelect>
		{#if errors.model}<span class="text-xs text-destructive-text">{errors.model}</span>{/if}
	</label>

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
		<NativeSelect bind:value={permissionMode}>
			{#each permissionModes as m (m.id)}
				<NativeSelectOption value={m.id}>{m.label}</NativeSelectOption>
			{/each}
		</NativeSelect>
		<span class="text-xs text-muted-foreground">{permissionModes.find((m) => m.id === permissionMode)?.hint}</span>
	</label>

	{#if agent}
		<a href="/a/{agent.id}" class="text-xs text-info-text underline underline-offset-4">Routines and files are in the chat side panel</a>
	{/if}

	{#if formError && !Object.keys(errors).length}<p class="text-xs text-destructive-text" role="alert">{formError}</p>{/if}

	<div class="flex items-center gap-2">
		<Button type="submit" disabled={saving || !name.trim() || !instructions.trim()}>
			{saving ? 'Saving…' : agent ? 'Save changes' : 'Create agent'}
		</Button>
		{#if agent}
			<Button
				type="button"
				variant="outline"
				class="ml-auto"
				disabled={isLead}
				title={isLead ? 'The lead cannot be archived' : undefined}
				onclick={archive}
			>
				Archive
			</Button>
		{/if}
	</div>
</form>
