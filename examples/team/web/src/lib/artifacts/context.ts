// What a fence or an artifact card needs from the message and the chat around it (Svelte context).
import { getContext, setContext } from 'svelte';
import type { Fence } from './fences.js';

export type MessageEnv = { messageId: string; fences: () => Fence[] };
export type ChatEnv = {
	sessionId: () => string;
	/** Send a message to the agent of this chat (the "fix it" and "adopt this file" requests). */
	ask: (text: string) => void;
};

const MESSAGE = Symbol('artifacts.message');
const CHAT = Symbol('artifacts.chat');

export const setMessageEnv = (e: MessageEnv): void => void setContext(MESSAGE, e);
export const getMessageEnv = (): MessageEnv | undefined => getContext<MessageEnv | undefined>(MESSAGE);
export const setChatEnv = (e: ChatEnv): void => void setContext(CHAT, e);
export const getChatEnv = (): ChatEnv | undefined => getContext<ChatEnv | undefined>(CHAT);
