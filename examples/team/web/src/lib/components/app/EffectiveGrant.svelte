<script lang="ts">
	import { grantLines, type EffectiveGrant } from '#lib/programs/grant.js';
	import { cn } from '#lib/utils.js';

	/** What an authority really gives for the agent: resolved tools per connector, and what is refused. */
	let { grant, title = 'What this really grants', always = false, skip = new Set<string>() }: { grant: EffectiveGrant | null | undefined; title?: string; always?: boolean; /** Names whose problem is already shown elsewhere. */ skip?: ReadonlySet<string> } = $props();
	const lines = $derived(grantLines(grant, skip));
</script>

{#if lines.length || always}
	<div class="rounded-md border border-border bg-muted/40 px-3 py-2" data-testid="effective-grant">
		<div class="mb-1 text-xs font-medium text-muted-foreground">{title}</div>
		{#if !lines.length}<p class="text-xs text-muted-foreground">Nothing yet: pick what it may use above.</p>{/if}
		<ul class="flex flex-col gap-1 text-[13px]">
			{#each lines as l, i (i)}
				<li>
					<span class={cn('font-mono text-xs', l.tone === 'bad' && 'text-destructive-text', l.tone === 'warn' && 'text-warning-text')}>{l.text}</span>
					{#if l.detail}<span class="block text-xs text-muted-foreground">{l.detail}</span>{/if}
				</li>
			{/each}
		</ul>
	</div>
{/if}
