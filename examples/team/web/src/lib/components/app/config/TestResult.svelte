<script lang="ts">
	import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircle';
	import WarningIcon from 'phosphor-svelte/lib/Warning';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { testSummary, type TestOutcome } from '#lib/config/status.js';

	/** The outcome line of a test, identical for providers and connections. */
	let { result, class: className = 'text-xs' }: { result: TestOutcome | undefined; class?: string } = $props();
</script>

{#if result}
	<p class="flex items-center gap-1.5 {className} {result.busy ? 'text-muted-foreground' : result.ok ? 'text-success-text' : 'text-destructive-text'}" role="status">
		{#if result.busy}<Spinner class="size-3.5" />Testing…{:else if result.ok}<CheckCircleIcon class="size-3.5" />{testSummary(result)}{:else}<WarningIcon class="size-3.5" />{testSummary(result)}{/if}
	</p>
{/if}
