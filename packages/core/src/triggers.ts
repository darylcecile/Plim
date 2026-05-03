// Trigger system: a trigger describes an event that may invoke an action.
// Triggers are matched by the input pipeline.

export type ModifierKey = 'Mod' | 'Ctrl' | 'Meta' | 'Alt' | 'Shift';

export type Trigger =
	| { kind: 'keyboard.shortcut'; combo: string; parts: { key: string; mods: Set<ModifierKey> } }
	| { kind: 'keyboard.character'; char: string }
	| { kind: 'keyboard.key'; key: string }
	| { kind: 'clipboard.action'; action: 'cut' | 'copy' | 'paste' };

function parseShortcut(combo: string): { key: string; mods: Set<ModifierKey> } {
	const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
	const mods = new Set<ModifierKey>();
	let key = '';
	for (const part of parts) {
		const lower = part.toLowerCase();
		if (lower === 'mod') mods.add('Mod');
		else if (lower === 'ctrl' || lower === 'control') mods.add('Ctrl');
		else if (lower === 'meta' || lower === 'cmd' || lower === 'command') mods.add('Meta');
		else if (lower === 'alt' || lower === 'option') mods.add('Alt');
		else if (lower === 'shift') mods.add('Shift');
		else key = part;
	}
	return { key, mods };
}

export const triggers = {
	keyboard: {
		shortcut(combo: string): Trigger {
			return { kind: 'keyboard.shortcut', combo, parts: parseShortcut(combo) };
		},
		character(char: string): Trigger {
			return { kind: 'keyboard.character', char };
		},
		key(key: string): Trigger {
			return { kind: 'keyboard.key', key };
		},
	},
	clipboard: {
		action(action: 'cut' | 'copy' | 'paste'): Trigger {
			return { kind: 'clipboard.action', action };
		},
	},
};

export function isMacLike(): boolean {
	if (typeof navigator === 'undefined') return false;
	return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
}

export function matchKeyboardEvent(trigger: Trigger, ev: KeyboardEvent): boolean {
	if (trigger.kind === 'keyboard.shortcut') {
		const { key, mods } = trigger.parts;
		const wantMod = mods.has('Mod');
		const wantCtrl = mods.has('Ctrl');
		const wantMeta = mods.has('Meta');
		const wantAlt = mods.has('Alt');
		const wantShift = mods.has('Shift');
		const macMod = isMacLike() ? ev.metaKey : ev.ctrlKey;
		if (wantMod && !macMod) return false;
		if (wantCtrl && !ev.ctrlKey) return false;
		if (wantMeta && !ev.metaKey) return false;
		if (wantAlt !== ev.altKey) return false;
		if (wantShift !== ev.shiftKey) return false;
		if (!wantMod && !wantCtrl && !wantMeta) {
			if (ev.ctrlKey || ev.metaKey) return false;
		}
		// loose key match: case-insensitive, also accept code like "KeyB"
		return ev.key.toLowerCase() === key.toLowerCase();
	}
	if (trigger.kind === 'keyboard.character') {
		// printable single-character; ignore if modifiers held (except shift for capitals)
		if (ev.ctrlKey || ev.metaKey || ev.altKey) return false;
		return ev.key === trigger.char;
	}
	if (trigger.kind === 'keyboard.key') {
		return ev.key === trigger.key;
	}
	return false;
}
