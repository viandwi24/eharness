<script lang="ts">
	import ShieldIcon from 'phosphor-svelte/lib/Shield';
	import CheckIcon from 'phosphor-svelte/lib/Check';
	import ClockIcon from 'phosphor-svelte/lib/Clock';
	import CircleIcon from 'phosphor-svelte/lib/Circle';
	import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircle';
	import XIcon from 'phosphor-svelte/lib/X';
	import XCircleIcon from 'phosphor-svelte/lib/XCircle';
	import { Badge, type BadgeVariant } from "#lib/components/ui/badge/index.js";
	import type { ToolState } from "./types.js";

	let { state }: { state: ToolState } = $props();

	const labels: Record<ToolState, string> = {
		"approval-requested": "Awaiting approval",
		"approval-responded": "Responded",
		"input-available": "Running",
		"input-streaming": "Pending",
		"output-available": "Completed",
		"output-denied": "Denied",
		"output-error": "Error",
	};

	const variants: Record<ToolState, BadgeVariant> = {
		"approval-requested": "warning",
		"approval-responded": "secondary",
		"input-available": "info",
		"input-streaming": "secondary",
		"output-available": "success",
		"output-denied": "outline",
		"output-error": "destructive",
	};
</script>

<Badge data-slot="ai-tool-status" shape="pill" class="gap-1" variant={variants[state]}>
	{#if state === "approval-requested"}
		<ShieldIcon  />
	{:else if state === "approval-responded"}
		<CheckIcon  />
	{:else if state === "input-available"}
		<ClockIcon class="animate-pulse" />
	{:else if state === "input-streaming"}
		<CircleIcon  />
	{:else if state === "output-available"}
		<CheckCircleIcon  />
	{:else if state === "output-denied"}
		<XIcon  />
	{:else}
		<XCircleIcon  />
	{/if}
	{labels[state]}
</Badge>
