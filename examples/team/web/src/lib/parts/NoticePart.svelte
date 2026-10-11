<script lang="ts">
	import WarningCircleIcon from 'phosphor-svelte/lib/WarningCircle';
	import InfoIcon from 'phosphor-svelte/lib/Info';
	import { cn } from '#lib/utils.js';

	/** The `eh.notice` kind: what the core says about a turn (an error, a timeout, a recovered crash, a warning). */
	let { level, text, code }: { level: 'info' | 'warning' | 'error'; text: string; code?: string } = $props();
</script>

<div
	class={cn('flex w-full items-start gap-2 rounded-lg px-3 py-2 text-[13px]', level === 'error' ? 'bg-destructive-soft text-destructive-text' : 'border border-border text-muted-foreground')}
	role={level === 'error' ? 'alert' : 'status'}
	data-testid="chat-notice"
	data-code={code}
>
	{#if level === 'info'}<InfoIcon class="mt-0.5 size-4 shrink-0" />{:else}<WarningCircleIcon class="mt-0.5 size-4 shrink-0" />{/if}
	<span class="min-w-0 flex-1 break-words">{text}</span>
</div>
