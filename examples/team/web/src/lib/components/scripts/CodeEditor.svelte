<script lang="ts">
	import { tick } from 'svelte';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { tabEdit } from '#lib/scripts/scripts.js';
	import { cn } from '#lib/utils.js';

	/**
	 * A plain monospace code box. Tab and Shift+Tab indent; Escape, then Tab, leaves the box
	 * (keyboard users are never trapped).
	 */
	let {
		value = $bindable(''),
		id,
		label,
		invalid = false,
		readonly = false,
		class: className
	}: { value?: string; id?: string; label: string; invalid?: boolean; readonly?: boolean; class?: string } = $props();

	let ref = $state<HTMLTextAreaElement | null>(null);
	let released = false;

	async function keydown(e: KeyboardEvent): Promise<void> {
		if (e.key === 'Escape') {
			released = true;
			return;
		}
		if (e.key !== 'Tab' || readonly || released || e.ctrlKey || e.metaKey || e.altKey) return;
		e.preventDefault();
		const el = e.currentTarget as HTMLTextAreaElement;
		const r = tabEdit(value, el.selectionStart, el.selectionEnd, e.shiftKey);
		value = r.value;
		await tick();
		ref?.setSelectionRange(r.start, r.end);
	}
</script>

<Textarea
	bind:ref
	bind:value
	{id}
	{readonly}
	aria-label={label}
	aria-invalid={invalid}
	spellcheck={false}
	autocapitalize="off"
	autocomplete="off"
	wrap="off"
	class={cn('field-sizing-fixed min-h-48 resize-y overflow-auto font-mono text-xs leading-5 whitespace-pre [tab-size:2]', className)}
	onkeydown={keydown}
	onblur={() => (released = false)}
	onfocus={() => (released = false)}
/>
