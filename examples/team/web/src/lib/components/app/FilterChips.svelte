<script lang="ts">
	/**
	 * A row of filter chips (one is on at a time). The first option is "everything" (value '').
	 * Radio semantics for the screen reader; every chip is a real button in the tab order.
	 */
	let {
		label,
		options,
		value,
		onChange
	}: { label: string; options: { value: string; label: string }[]; value: string; onChange: (value: string) => void } = $props();
</script>

<div class="flex flex-wrap items-center gap-1" role="radiogroup" aria-label={label}>
	{#each options as o (o.value)}
		<button
			type="button"
			role="radio"
			aria-checked={value === o.value}
			class="h-7 rounded-md border px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring {value === o.value ? 'border-transparent bg-primary text-primary-foreground' : 'border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground'}"
			onclick={() => onChange(o.value)}
		>
			{o.label}
		</button>
	{/each}
</div>
