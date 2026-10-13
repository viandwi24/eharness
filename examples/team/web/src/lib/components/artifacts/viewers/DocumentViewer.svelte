<script lang="ts">
	import { loadText, type ViewerInput } from '#lib/artifacts/input.js';
	import { MessageResponse } from '#lib/components/ai/message/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';

	let { input }: { input: ViewerInput } = $props();

	let md = $state<string>();
	let trusted = $state<string[]>([]);
	let error = $state('');

	// `![](chart.png)` names a file of the artifact: it becomes that file's signed URL.
	const RELATIVE_IMAGE = /!\[[^\]]*\]\(\s*<?(?!https?:|data:|\/|#)([^)\s>]+)/g;

	$effect(() => {
		const i = input;
		md = undefined;
		error = '';
		const ctl = new AbortController();
		loadText(i, ctl.signal)
			.then(async (text) => {
				let out = text;
				const prefixes: string[] = [];
				const rels = [...new Set([...text.matchAll(RELATIVE_IMAGE)].map((m) => m[1] as string))];
				if (rels.length && i.resolve) {
					const urls = await Promise.all(rels.map((r) => i.resolve!(r).catch(() => undefined)));
					rels.forEach((rel, k) => {
						const u = urls[k];
						if (!u) return;
						out = out.split(`](${rel}`).join(`](${u}`).split(`](<${rel}`).join(`](<${u}`);
						try {
							prefixes.push(`${new URL(u, location.href).origin}/`);
						} catch {
							// a URL that does not parse is left as the markdown had it
						}
					});
				}
				if (ctl.signal.aborted) return;
				trusted = [...new Set(prefixes)];
				md = out;
			})
			.catch((e: unknown) => {
				if (!ctl.signal.aborted) error = e instanceof Error ? e.message : 'Could not load the document';
			});
		return () => ctl.abort();
	});
</script>

<div class="h-full overflow-y-auto p-5">
	{#if error}
		<p class="text-sm text-destructive-text" role="alert">{error}</p>
	{:else if md === undefined}
		<div class="flex flex-col gap-2"><Skeleton class="h-4 w-2/3" /><Skeleton class="h-4 w-full" /><Skeleton class="h-4 w-5/6" /></div>
	{:else}
		<MessageResponse content={md || '*(empty)*'} class="max-w-none" trustedImagePrefixes={trusted} />
	{/if}
</div>
