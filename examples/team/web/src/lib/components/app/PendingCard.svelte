<script lang="ts">
	import type { Approval } from '#lib/api/client.js';
	import ApprovalCard from './ApprovalCard.svelte';
	import QuestionCard from './QuestionCard.svelte';

	let {
		approval,
		onOpenTask,
		onAnswered
	}: { approval: Approval; onOpenTask?: (taskId: string) => void; onAnswered?: () => void } = $props();
</script>

{#if approval.kind === 'question'}
	<QuestionCard {approval} {onOpenTask} {onAnswered} />
{:else}
	<ApprovalCard {approval} {onOpenTask} {onAnswered} />
{/if}
