<script lang="ts">
	/** "Read-only: set by <vars> in the server environment": providers' env profiles and env-set OAuth apps. */
	let { vars, hint = 'Change it there, or add a custom one here.' }: { vars: string[]; hint?: string } = $props();
</script>

<p class="text-xs text-muted-foreground">
	Read-only: set by <span class="font-mono">{vars.length ? vars.join(', ') : 'environment variables'}</span> in the server environment. {hint}
</p>
