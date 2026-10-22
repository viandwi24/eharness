// Icons of the navigation (rail, bottom bar, work menu).
import BriefcaseIcon from 'phosphor-svelte/lib/Briefcase';
import GlobeIcon from 'phosphor-svelte/lib/Globe';
import ChatCircleDotsIcon from 'phosphor-svelte/lib/ChatCircleDots';
import ChatsCircleIcon from 'phosphor-svelte/lib/ChatsCircle';
import ClockIcon from 'phosphor-svelte/lib/Clock';
import FolderOpenIcon from 'phosphor-svelte/lib/FolderOpen';
import GavelIcon from 'phosphor-svelte/lib/Gavel';
import GearIcon from 'phosphor-svelte/lib/Gear';
import HeartbeatIcon from 'phosphor-svelte/lib/Heartbeat';
import ListChecksIcon from 'phosphor-svelte/lib/ListChecks';
import PlugsConnectedIcon from 'phosphor-svelte/lib/PlugsConnected';
import CubeIcon from 'phosphor-svelte/lib/Cube';
import PulseIcon from 'phosphor-svelte/lib/Pulse';
import StrategyIcon from 'phosphor-svelte/lib/Strategy';
import UsersThreeIcon from 'phosphor-svelte/lib/UsersThree';
import type { Component } from 'svelte';
import type { RailId, SectionId } from './sections.js';

export const NAV_ICONS: Record<SectionId | RailId, Component> = {
	agents: ChatsCircleIcon,
	work: BriefcaseIcon,
	tasks: ListChecksIcon,
	decisions: GavelIcon,
	programs: StrategyIcon,
	routines: ClockIcon,
	files: FolderOpenIcon,
	artifacts: CubeIcon,
	channels: ChatCircleDotsIcon,
	people: UsersThreeIcon,
	connectors: PlugsConnectedIcon,
	browser: GlobeIcon,
	logs: PulseIcon,
	attention: HeartbeatIcon,
	settings: GearIcon
};
