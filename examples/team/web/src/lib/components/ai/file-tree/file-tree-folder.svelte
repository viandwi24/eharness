<script lang="ts">
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRight';
	import FolderOpenIcon from 'phosphor-svelte/lib/FolderOpen';
	import FolderIcon from 'phosphor-svelte/lib/Folder';
	import {
		Collapsible,
		CollapsibleContent,
		CollapsibleTrigger,
	} from "#lib/components/ui/collapsible/index.js";
	import { cn } from "#lib/utils.js";
	import type { Snippet } from "svelte";
	import type { HTMLAttributes } from "svelte/elements";
	import FileTreeIcon from "./file-tree-icon.svelte";
	import FileTreeName from "./file-tree-name.svelte";
	import { FILE_TREE_ROW, useFileTreeContext } from "./use-file-tree.svelte.js";

	let {
		path,
		name,
		class: className,
		children,
		...restProps
	}: HTMLAttributes<HTMLDivElement> & { path: string; name: string; children?: Snippet } =
		$props();

	const tree = useFileTreeContext();
	const isExpanded = $derived(tree.expandedPaths.has(path));
	const isSelected = $derived(tree.selectedPath === path);
</script>

<Collapsible open={isExpanded} onOpenChange={() => tree.togglePath(path)}>
	<div role="treeitem" aria-selected={isSelected} aria-expanded={isExpanded} tabindex="-1" class={className} {...restProps}>
		<div class={FILE_TREE_ROW} data-selected={isSelected ? "" : undefined}>
			<CollapsibleTrigger
				aria-label={isExpanded ? `Collapse ${name}` : `Expand ${name}`}
				class="flex shrink-0 cursor-pointer items-center border-none bg-transparent p-0 text-muted-foreground"
			>
				<CaretRightIcon class={cn("size-3.5 transition-transform", isExpanded && "rotate-90")} />
			</CollapsibleTrigger>
			<button
				class="flex min-w-0 flex-1 cursor-pointer items-center gap-[7px] border-none bg-transparent p-0 text-left"
				type="button"
				onclick={() => {
					tree.select(path);
					tree.togglePath(path);
				}}
			>
				<FileTreeIcon class="text-chart-3">
					{#if isExpanded}
						<FolderOpenIcon class="size-4" />
					{:else}
						<FolderIcon class="size-4" />
					{/if}
				</FileTreeIcon>
				<FileTreeName>{name}</FileTreeName>
			</button>
		</div>
		<CollapsibleContent>
			<div class="pl-4">
				{@render children?.()}
			</div>
		</CollapsibleContent>
	</div>
</Collapsible>
