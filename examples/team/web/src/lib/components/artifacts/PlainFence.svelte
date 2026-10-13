<script lang="ts">
	import { useStreamdown, type CodeToken } from 'svelte-streamdown';

	/** An ordinary code block, as Streamdown draws it without a highlighter (also an unfinished fence). */
	let { token, id, incomplete = false }: { token: CodeToken; id: string; incomplete?: boolean } = $props();

	const streamdown = useStreamdown();
	const code = $derived(token.text.replace(/\n+$/, ''));
</script>

<div data-streamdown-code={id} data-incomplete={incomplete || undefined} class={streamdown.theme.code.base}>
	<div class={streamdown.theme.code.header}><span class={streamdown.theme.code.language}>{token.lang}</span></div>
	<div style="height: fit-content; width: 100%;" class={streamdown.theme.code.container}>
		<pre class={streamdown.theme.code.pre}><code>{#each code.split('\n') as line}<span class={streamdown.theme.code.line}>{line.trim().length > 0 ? line : '​'}</span>{/each}</code></pre>
	</div>
</div>
