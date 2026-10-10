<script lang="ts">
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { STATUS_BADGE, type ConfigStatus } from '#lib/config/status.js';

	/** One badge for every status of a provider profile or connection (`lib/config/status.ts`). */
	let { status, label, class: className }: { status: ConfigStatus; label?: string; class?: string } = $props();
	const info = $derived(STATUS_BADGE[status]);
</script>

<Badge variant={info.variant} class={className}>{label ?? info.label}</Badge>
