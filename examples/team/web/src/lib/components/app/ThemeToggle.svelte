<script lang="ts">
	import MoonIcon from 'phosphor-svelte/lib/Moon';
	import SunIcon from 'phosphor-svelte/lib/Sun';
	import { Button } from '#lib/components/ui/button/index.js';

	let dark = $state(
		typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
	);

	function toggle() {
		dark = !dark;
		document.documentElement.classList.toggle('dark', dark);
		document.cookie = `edmi-mode=${dark ? 'dark' : 'light'}; path=/; max-age=31536000; samesite=lax`;
	}
</script>

<Button variant="ghost" size="icon-sm" aria-label="Toggle dark mode" onclick={toggle}>
	{#if dark}<SunIcon class="size-4" />{:else}<MoonIcon class="size-4" />{/if}
</Button>
