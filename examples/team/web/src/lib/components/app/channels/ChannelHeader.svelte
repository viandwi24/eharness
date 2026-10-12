<script lang="ts">
	import type { Snippet } from 'svelte';
	import PageHeader, { type Crumb } from '#lib/components/app/PageHeader.svelte';
	import { channelHref, SECTION_TITLE, type SectionId } from '#lib/channels/model.js';
	import { useConnection } from '#lib/channels/connection.svelte.js';

	/**
	 * The header of a Channels page: `Channels / <name> / <section>` as the breadcrumb trail and the
	 * title of the page last. A detail page (one chat, one person) gives its `section` (the list it
	 * belongs to) and its own `title`; a section page gives only the section.
	 */
	let {
		section,
		title,
		detail = false,
		description,
		actions
	}: { section: SectionId; title?: string; detail?: boolean; description?: string; actions?: Snippet } = $props();

	const cs = useConnection();
	const conn = $derived(cs.conn);
	const trail = $derived<Crumb[]>([
		{ label: 'Channels', href: '/channels' },
		{ label: conn?.label ?? 'Channel', href: channelHref(cs.id(), 'overview') },
		...(detail ? [{ label: SECTION_TITLE[section], href: channelHref(cs.id(), section) }] : [])
	]);
</script>

<PageHeader title={title ?? SECTION_TITLE[section]} {description} breadcrumb={trail} backHref={detail ? channelHref(cs.id(), section) : '/channels'} {actions} />
