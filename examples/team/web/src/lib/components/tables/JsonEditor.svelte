<script lang="ts">
	import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircle';
	import WarningCircleIcon from 'phosphor-svelte/lib/WarningCircle';
	import { Button } from '#lib/components/ui/button/index.js';
	import { cn } from '#lib/utils.js';

	/**
	 * A JSON text box that checks itself as you type. `valid` tells the parent whether the text
	 * parses (empty counts as valid when `allowEmpty`); `onSubmit` runs on Cmd/Ctrl+Enter.
	 */
	let {
		value = $bindable(''),
		valid = $bindable(true),
		rows = 8,
		allowEmpty = true,
		label = 'JSON',
		id,
		class: className,
		onSubmit
	}: { value?: string; valid?: boolean; rows?: number; allowEmpty?: boolean; label?: string; id?: string; class?: string; onSubmit?: () => void } = $props();

	const problem = $derived.by(() => {
		if (!value.trim()) return allowEmpty ? '' : 'Type a JSON value';
		try {
			JSON.parse(value);
			return '';
		} catch (e) {
			return e instanceof Error ? e.message : 'Not valid JSON';
		}
	});
	$effect(() => {
		valid = problem === '';
	});

	function format(): void {
		try {
			value = JSON.stringify(JSON.parse(value), null, 2);
		} catch {
			// leave the text as it is: the problem line says why
		}
	}
</script>

<div class={cn('flex flex-col gap-1.5', className)}>
	<textarea
		{id}
		bind:value
		{rows}
		spellcheck="false"
		aria-label={label}
		aria-invalid={!!problem}
		class="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs leading-5 outline-none focus-visible:border-ring focus-visible:shadow-ring aria-invalid:border-destructive"
		onkeydown={(e) => {
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !problem) {
				e.preventDefault();
				onSubmit?.();
			}
		}}
	></textarea>
	<div class="flex min-h-6 items-center gap-2 text-xs">
		{#if problem}
			<span class="flex min-w-0 items-center gap-1 text-destructive-text"><WarningCircleIcon class="size-3.5 shrink-0" /><span class="truncate">{problem}</span></span>
		{:else if value.trim()}
			<span class="flex items-center gap-1 text-success-text"><CheckCircleIcon class="size-3.5" />Valid JSON</span>
		{/if}
		<span class="flex-1"></span>
		<Button variant="ghost" size="xs" disabled={!!problem || !value.trim()} onclick={format}>Format</Button>
	</div>
</div>
