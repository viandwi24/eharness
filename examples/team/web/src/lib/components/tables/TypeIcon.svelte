<script lang="ts">
	import BracketsCurlyIcon from 'phosphor-svelte/lib/BracketsCurly';
	import CalendarBlankIcon from 'phosphor-svelte/lib/CalendarBlank';
	import CheckSquareIcon from 'phosphor-svelte/lib/CheckSquare';
	import ClockIcon from 'phosphor-svelte/lib/Clock';
	import FingerprintIcon from 'phosphor-svelte/lib/Fingerprint';
	import HashIcon from 'phosphor-svelte/lib/Hash';
	import TextAaIcon from 'phosphor-svelte/lib/TextAa';
	import UserIcon from 'phosphor-svelte/lib/User';
	import type { SystemKey } from '#lib/tables/grid.js';
	import type { ColumnType } from '#lib/tables/tables.js';
	import { cn } from '#lib/utils.js';

	/** The small icon of a field type (Text, Number, Checkbox, Date, JSON) or of a system column. */
	let { type, system, class: className }: { type: ColumnType; system?: SystemKey; class?: string } = $props();

	const Icon = $derived(
		system === 'createdAt' || system === 'updatedAt'
			? ClockIcon
			: system === 'by'
				? UserIcon
				: system === 'id'
					? FingerprintIcon
					: { string: TextAaIcon, number: HashIcon, boolean: CheckSquareIcon, date: CalendarBlankIcon, json: BracketsCurlyIcon }[type]
	);
</script>

<Icon class={cn('size-3.5 shrink-0', className)} aria-hidden="true" />
