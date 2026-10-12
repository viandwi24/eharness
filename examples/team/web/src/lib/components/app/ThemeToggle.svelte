<script lang="ts">
	import MoonIcon from 'phosphor-svelte/lib/Moon';
	import SunIcon from 'phosphor-svelte/lib/Sun';
	import { Button } from '#lib/components/ui/button/index.js';
	import { theme } from '#lib/stores/theme.svelte.js';
</script>

<Button variant="ghost" size="icon-sm" aria-label="Toggle dark mode" aria-pressed={theme.mode === 'dark'} onclick={() => theme.toggle()}>
	{#if theme.mode === 'dark'}<SunIcon class="size-4" />{:else}<MoonIcon class="size-4" />{/if}
</Button>
