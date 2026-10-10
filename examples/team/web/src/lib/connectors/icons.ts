// Connector icon names (the server sends a name) to Phosphor components. Unknown names fall back to a plug.
import type { Component } from 'svelte';
import BrainIcon from 'phosphor-svelte/lib/Brain';
import ChatCircleIcon from 'phosphor-svelte/lib/ChatCircle';
import FolderIcon from 'phosphor-svelte/lib/Folder';
import GithubLogoIcon from 'phosphor-svelte/lib/GithubLogo';
import GlobeIcon from 'phosphor-svelte/lib/Globe';
import ListChecksIcon from 'phosphor-svelte/lib/ListChecks';
import PlugIcon from 'phosphor-svelte/lib/Plug';
import PlugsIcon from 'phosphor-svelte/lib/Plugs';
import UsersIcon from 'phosphor-svelte/lib/Users';

export const CONNECTOR_ICONS: Record<string, Component<any>> = {
	folder: FolderIcon,
	brain: BrainIcon,
	'list-checks': ListChecksIcon,
	globe: GlobeIcon,
	'message-circle-question': ChatCircleIcon,
	users: UsersIcon,
	'github-logo': GithubLogoIcon,
	plugs: PlugsIcon
};

export const connectorIcon = (name: string | undefined): Component<any> => (name && CONNECTOR_ICONS[name]) || PlugIcon;
