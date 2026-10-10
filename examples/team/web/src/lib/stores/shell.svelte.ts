import type { Snippet } from 'svelte';

/**
 * The page header slot of the app shell: the root layout renders it on the inset panel's shell,
 * above the content plate. Pages register it through `<ShellHeader>`.
 */
export const shell = $state<{ header: Snippet | null }>({ header: null });
