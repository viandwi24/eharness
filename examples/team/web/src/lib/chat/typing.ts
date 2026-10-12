// A person who starts typing while focus sits on nothing useful (the page body after a navigation,
// a button a closed dialog or an upload picker returned focus to) means the message box. Pure,
// unit-tested; ChatPane applies it.

export type KeyTarget = {
	/** Tag name of the focused element, lower case (`body` when nothing is focused). */
	tag: string;
	editable: boolean;
	/** Inside an open dialog, menu, popover or the pending-approval dock. */
	inOverlay: boolean;
};

export type TypedKey = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing?: boolean; defaultPrevented?: boolean };

export function shouldFocusComposer(e: TypedKey, t: KeyTarget): boolean {
	if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return false;
	if (t.editable || t.inOverlay) return false;
	if (['input', 'textarea', 'select'].includes(t.tag)) return false;
	if (e.key.length !== 1) return false; // arrows, Enter, Tab, Escape keep their meaning
	// Space activates a focused button or link; any other printable key does nothing there
	if (e.key === ' ' && t.tag !== 'body') return false;
	return true;
}
