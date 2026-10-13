<script lang="ts">
	import type { ViewerInput } from '#lib/artifacts/input.js';
	import { viewerFor } from '#lib/artifacts/viewers.js';

	/** The viewer of `input`, chosen by kind in the registry. */
	let { input, onFix }: { input: ViewerInput; onFix?: (error: string) => void } = $props();
	const Viewer = $derived(viewerFor(input.kind));
</script>

<Viewer {input} {onFix} />
