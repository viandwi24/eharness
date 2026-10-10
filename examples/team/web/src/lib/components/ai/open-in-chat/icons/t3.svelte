<script lang="ts">
	import ChatCircleIcon from 'phosphor-svelte/lib/ChatCircle';
	import type { SVGAttributes } from "svelte/elements";

	let { ...restProps }: SVGAttributes<SVGSVGElement> = $props();
</script>

<ChatCircleIcon {...(restProps as object)} />
