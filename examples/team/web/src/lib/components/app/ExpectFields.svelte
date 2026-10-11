<script lang="ts">
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import type { ExpectForm } from '#lib/rehearsal/model.js';

	/** What a test case expects of its run. */
	let { form = $bindable() }: { form: ExpectForm } = $props();
</script>

<fieldset class="flex flex-col gap-3 rounded-lg border border-border p-3" data-testid="expect-fields">
	<legend class="px-1 font-medium">The test passes when</legend>
	<label class="flex items-start gap-2">
		<input type="checkbox" bind:checked={form.deliverablesPass} class="mt-0.5" />
		<span class="text-xs">Every deliverable of the program passes its check</span>
	</label>
	<label class="flex flex-col gap-1">
		<span class="text-xs font-medium">The run never calls these tools</span>
		<Textarea bind:value={form.mustNotCall} rows={2} placeholder={'docs_create_note\ngithub_*'} class="font-mono text-xs" />
		<span class="text-xs text-muted-foreground">One tool name per line; a trailing * is a prefix. Simulated and refused calls count as calls.</span>
	</label>
	<label class="flex flex-col gap-1 sm:w-64">
		<span class="text-xs font-medium">The report says</span>
		<NativeSelect bind:value={form.reportStatus}>
			<NativeSelectOption value="">Anything</NativeSelectOption>
			<NativeSelectOption value="done">done</NativeSelectOption>
			<NativeSelectOption value="partial">partial</NativeSelectOption>
			<NativeSelectOption value="failed">failed</NativeSelectOption>
			<NativeSelectOption value="needs_decision">needs a decision</NativeSelectOption>
		</NativeSelect>
	</label>
</fieldset>
