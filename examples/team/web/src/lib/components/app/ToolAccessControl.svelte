<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { api } from '#lib/api/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { effectiveToolAccess, TOOL_ACCESS_LABEL, toolAccessHint, type ToolAccess } from '#lib/connectors/tool-access.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';

	/**
	 * "Tool access" of one agent (Claude's Auto / On demand): how the tools of connected apps reach
	 * the model. `menu` = the compact row of the composer's connectors menu (Auto or On demand, saved
	 * on the agent); `tab` = the Connectors tab of the agent dialog (adds "Workspace default").
	 * `tools` = the agent's third-party tool count, for the hint.
	 */
	let { agentId, variant = 'tab', tools }: { agentId: string; variant?: 'menu' | 'tab'; tools?: number } = $props();

	let workspace = $state<ToolAccess | undefined>(undefined);
	let saving = $state(false);

	async function loadWorkspace(): Promise<void> {
		try {
			workspace = (await api.get('/settings')).toolAccess;
		} catch {
			// the row still works against the default
		}
	}
	$effect(() => {
		void live.state.revs.settings;
		untrack(() => void loadWorkspace());
	});

	const agent = $derived(agentsStore.find(agentId));
	const own = $derived(agent?.toolAccess ?? null);
	const effective = $derived(effectiveToolAccess(own, workspace));

	async function change(e: Event): Promise<void> {
		const v = (e.currentTarget as HTMLSelectElement).value;
		const next = v === 'default' ? null : (v as ToolAccess);
		if (!agent || saving) return;
		saving = true;
		try {
			await agentsStore.update(agent.id, { toolAccess: next });
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not change the tool access');
		} finally {
			saving = false;
		}
	}
	const selectValue = $derived(variant === 'menu' ? effective : (own ?? 'default'));
</script>

{#if agent}
	{#if variant === 'menu'}
		<div class="flex items-center justify-between gap-3 border-t border-border px-3 py-2" data-testid="tool-access-row">
			<div class="min-w-0">
				<p class="text-sm font-medium">Tool access</p>
				<p class="text-xs text-muted-foreground">{effective === 'auto' ? 'Tools load up front' : 'Tools found on demand'}</p>
			</div>
			<NativeSelect value={selectValue} onchange={change} disabled={saving} aria-label="Tool access of this agent" class="w-32 shrink-0" data-testid="tool-access-select">
				<NativeSelectOption value="auto">{TOOL_ACCESS_LABEL.auto}</NativeSelectOption>
				<NativeSelectOption value="on-demand">{TOOL_ACCESS_LABEL['on-demand']}</NativeSelectOption>
			</NativeSelect>
		</div>
	{:else}
		<div class="flex items-center justify-between gap-3 border-t border-border pt-3" data-testid="tool-access-section" title={toolAccessHint(effective, tools)}>
			<div class="min-w-0">
				<h3 class="text-xs font-medium text-muted-foreground">Tool access</h3>
				<p class="truncate text-xs text-muted-foreground/80">{effective === 'auto' ? 'Connector tools load up front' : 'Connector tools are found on demand'}</p>
			</div>
			<NativeSelect value={selectValue} onchange={change} disabled={saving} aria-label="Tool access" title={toolAccessHint(effective, tools)} class="h-8 w-40 shrink-0 text-xs" data-testid="tool-access-select">
				<NativeSelectOption value="default">Default · {TOOL_ACCESS_LABEL[workspace ?? 'auto']}</NativeSelectOption>
				<NativeSelectOption value="auto">{TOOL_ACCESS_LABEL.auto}</NativeSelectOption>
				<NativeSelectOption value="on-demand">{TOOL_ACCESS_LABEL['on-demand']}</NativeSelectOption>
			</NativeSelect>
		</div>
	{/if}
{/if}
