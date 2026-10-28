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
	import { api } from '#lib/api/index.js';
	import { formatTokens, formatUsd } from '#lib/context.js';
	import { costAtThreshold, DEFAULT_COMPACT_AT, effectiveWindow, windowPresets, windowProblem } from '#lib/context-window.js';
	import { effectiveModel, type ModelPick } from '#lib/providers/effective.js';
	import { formatContext, type ProviderModel } from '#lib/providers/models.js';
	import { THINKING_LABEL, thinkingChoices, type Thinking } from '#lib/thinking.js';

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
	// the context window: `model` = always the full window of the current model, a preset, or a custom number
	const PRESET_VALUES = [800_000, 500_000, 256_000, 128_000, 64_000];
	// svelte-ignore state_referenced_locally
	let windowChoice = $state<string>(agent?.contextWindow == null ? 'model' : PRESET_VALUES.includes(agent.contextWindow) ? String(agent.contextWindow) : 'custom');
	// svelte-ignore state_referenced_locally
	let customWindow = $state(agent?.contextWindow == null ? '' : String(agent.contextWindow));
	// svelte-ignore state_referenced_locally
	let compactAt = $state(String(agent?.compactAtPercent ?? DEFAULT_COMPACT_AT));
	// svelte-ignore state_referenced_locally
	let thinking = $state<Thinking>((agent?.thinking ?? 'default') as Thinking);
	let errors = $state<Record<string, string>>({});
	let formError = $state('');

	$effect(() => {
		// an existing agent's voice and rules are the Persona tab's; a new agent starts from its instructions
		valid = !!name.trim() && (!!agent || !!instructions.trim()) && !customError;
	});

	$effect(() => {
		dirty = agent
			? name !== agent.name || color !== agent.color || description !== agent.description || (model || null) !== (agent.model ?? null) || (modelProfile || null) !== (agent.modelProfile ?? null) || modeChoice !== agentChoiceOf(agent.permissionMode) || taskConcurrency !== String(agent.taskConcurrency ?? 1) || windowValue() !== (agent.contextWindow ?? null) || compactAt !== String(agent.compactAtPercent ?? DEFAULT_COMPACT_AT) || thinking !== (agent.thinking ?? 'default')
			: !!name.trim() || !!instructions.trim();
	});

	const isLead = $derived(agent?.role === 'lead');

	onMount(() => {
		void providersStore.load();
	});

	/** The custom limit the form holds: null = the model's window. */
	function windowValue(): number | null {
		if (windowChoice === 'model') return null;
		const n = Number.parseInt(windowChoice === 'custom' ? customWindow : windowChoice, 10);
		return Number.isFinite(n) ? n : null;
	}

	// the model this agent ends up on (its own pick or the workspace default) and what the catalog knows of it
	let workspacePick = $state<ModelPick>({ profileId: null, modelId: null });
	onMount(() => {
		void api.get('/settings').then((s) => (workspacePick = { profileId: s.defaultProfile, modelId: s.defaultModel }), () => {});
	});
	const effective = $derived(effectiveModel(providersStore.state.profiles, { profileId: modelProfile, modelId: model }, workspacePick));
	let modelInfo = $state<ProviderModel | undefined>(undefined);
	let infoSeq = 0;
	$effect(() => {
		const e = effective;
		const mine = ++infoSeq;
		if (!e) {
			modelInfo = undefined;
			return;
		}
		void providersStore.models(e.profileId).then(
			(list) => {
				if (mine === infoSeq) modelInfo = list.find((m) => m.id === e.modelId);
			},
			() => {
				if (mine === infoSeq) modelInfo = undefined;
			}
		);
	});
	const modelWindow = $derived(modelInfo?.contextWindow);
	const presets = $derived(windowPresets(modelWindow));
	const customError = $derived(windowChoice === 'custom' ? windowProblem(Number.parseInt(customWindow, 10), modelWindow) : undefined);
	const effWindow = $derived(effectiveWindow(modelWindow, windowValue()));
	const clamped = $derived(modelWindow !== undefined && (windowValue() ?? 0) > modelWindow);
	const pct = $derived(Math.min(95, Math.max(50, Number.parseInt(compactAt, 10) || DEFAULT_COMPACT_AT)));
	const callCost = $derived(costAtThreshold(effWindow, pct, modelInfo?.pricing?.input));
	const thinkingInfo = $derived(thinkingChoices(modelInfo));
	/** A stored level the current model does not list: still shown, the server sends the nearest one. */
	const thinkingOff = $derived(thinking !== 'default' && !thinkingInfo.levels.includes(thinking));

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
			taskConcurrency: Number.parseInt(taskConcurrency, 10) || 1,
			contextWindow: windowValue(),
			compactAtPercent: pct,
			thinking
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

	<label class="flex flex-col gap-1" data-testid="thinking-setting">
		<span class="font-medium">Thinking</span>
		<NativeSelect bind:value={thinking} aria-label="Thinking" data-testid="thinking">
			<NativeSelectOption value="default">{THINKING_LABEL.default}{thinkingInfo.defaultLevel ? ` (${THINKING_LABEL[thinkingInfo.defaultLevel]})` : ''}</NativeSelectOption>
			{#each thinkingInfo.levels as l (l)}<NativeSelectOption value={l}>{THINKING_LABEL[l]}</NativeSelectOption>{/each}
			{#if thinkingOff}<NativeSelectOption value={thinking}>{THINKING_LABEL[thinking]} (not offered by this model)</NativeSelectOption>{/if}
		</NativeSelect>
		{#if errors.thinking}<span class="text-xs text-destructive-text">{errors.thinking}</span>{/if}
		<span class="text-xs text-muted-foreground" data-testid="thinking-hint">
			How long the model thinks before it answers. Off or Low answers faster and cheaper; higher levels help hard problems.
			{thinkingInfo.hint}
			{#if thinkingOff}This model does not take {THINKING_LABEL[thinking]}: the nearest level it takes is used{thinking === 'none' && thinkingInfo.mandatory ? ' (it always thinks, so its own level is used)' : ''}.{/if}
		</span>
	</label>

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

	<div class="flex flex-col gap-1" data-testid="context-window-setting">
		<span class="font-medium" id="agent-window-label">Context window</span>
		<div class="flex flex-wrap items-center gap-2">
			<NativeSelect bind:value={windowChoice} aria-label="Context window" data-testid="context-window">
				<NativeSelectOption value="model">Model maximum{modelWindow ? ` (${formatContext(modelWindow)})` : ''}</NativeSelectOption>
				{#each presets as p (p)}<NativeSelectOption value={String(p)}>{formatContext(p)}</NativeSelectOption>{/each}
				{#if windowChoice !== 'model' && windowChoice !== 'custom' && !presets.includes(Number(windowChoice))}
					<NativeSelectOption value={windowChoice}>{formatContext(Number(windowChoice))} (above this model)</NativeSelectOption>
				{/if}
				<NativeSelectOption value="custom">Custom…</NativeSelectOption>
			</NativeSelect>
			{#if windowChoice === 'custom'}
				<Input type="number" bind:value={customWindow} min={16000} max={modelWindow} step={1000} placeholder="Tokens" class="w-40" aria-label="Custom context window in tokens" aria-invalid={!!customError || !!errors.contextWindow} />
			{/if}
		</div>
		{#if customError}<span class="text-xs text-destructive-text">{customError}</span>{/if}
		{#if errors.contextWindow}<span class="text-xs text-destructive-text">{errors.contextWindow}</span>{/if}
		<span class="text-xs text-muted-foreground">
			{#if modelWindow}The model's window is {formatTokens(modelWindow)} tokens.{:else}The model's window is not known to the catalog.{/if}
			{#if windowChoice === 'model'}This agent always uses the full window of its current model, also after you switch models.{/if}
			{#if clamped}This limit is above the model's window: the agent works in {formatTokens(effWindow ?? 0)} (the smaller of the two) until the model or the limit changes.{/if}
		</span>
		<label class="mt-2 flex flex-col gap-1">
			<span class="font-medium">Summarize at (%)</span>
			<Input type="number" bind:value={compactAt} min={50} max={95} step={5} class="w-28" aria-label="Summarize at percent of the window" data-testid="compact-at" />
			{#if errors.compactAtPercent}<span class="text-xs text-destructive-text">{errors.compactAtPercent}</span>{/if}
		</label>
		<span class="text-xs text-muted-foreground" data-testid="context-cost">
			{#if effWindow}
				Older messages are summarized at {formatTokens(Math.floor((effWindow * pct) / 100))} tokens.
				{#if callCost !== undefined}A full call at that size costs about {formatUsd(callCost)} of input at the model's price (before prompt caching).{:else}The model's price is not known, so the cost of a call cannot be estimated.{/if}
			{/if}
			Changes apply to every chat of this agent from its next message.
		</span>
	</div>

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
