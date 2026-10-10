<script lang="ts">
	import type { CapabilityMode } from '#lib/api/index.js';
	import { MODE_LABEL, MODES } from '#lib/connectors/core.js';
	import { cn } from '#lib/utils.js';

	/**
	 * Segmented Allowed / Ask first / Off control, shared by the connector detail (default permissions)
	 * and the agent's Connectors tab (per-agent overrides). `locked` shows the value without editing.
	 */
	let {
		mode,
		label,
		disabled = false,
		onPick,
		class: className
	}: { mode: CapabilityMode; label: string; disabled?: boolean; onPick: (m: CapabilityMode) => void; class?: string } = $props();
</script>

<div class={cn('inline-flex shrink-0 rounded-lg border border-border bg-muted p-0.5', className)} role="radiogroup" aria-label={label}>
	{#each MODES as m (m)}
		<button
			type="button"
			role="radio"
			aria-checked={mode === m}
			{disabled}
			onclick={() => mode !== m && onPick(m)}
			class={cn(
				'h-6 rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-colors outline-none focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default',
				mode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground disabled:hover:text-muted-foreground',
				disabled && mode !== m && 'opacity-60'
			)}>{MODE_LABEL[m]}</button
		>
	{/each}
</div>
