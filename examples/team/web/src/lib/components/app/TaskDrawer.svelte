<script lang="ts">
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import { closeTask, drawer } from '#lib/stores/drawer.svelte.js';
	import SessionView from './SessionView.svelte';
</script>

<Sheet.Root open={drawer.taskId !== null} onOpenChange={(o) => !o && closeTask()}>
	<Sheet.Content side="right" showCloseButton={false} class="flex w-full flex-col gap-0 p-0 sm:max-w-3xl lg:max-w-4xl">
		<Sheet.Title class="sr-only">Task session</Sheet.Title>
		{#if drawer.taskId}
			{#key drawer.taskId}
				<SessionView taskId={drawer.taskId} onClose={closeTask} />
			{/key}
		{/if}
	</Sheet.Content>
</Sheet.Root>
