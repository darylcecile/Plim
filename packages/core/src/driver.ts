import type { ActionDescriptor } from './actions.js';
import type { BlockDescriptor, MarkDescriptor } from './blocks.js';
import type { EditorHandle } from './editor-handle.js';
import type { ExtensionFactory, Theme } from './extension.js';

export type PlimDriverConfig = {
	theme?: Theme;
	extensions?: ExtensionFactory[];
	registeredMarks?: Array<(editor: EditorHandle) => MarkDescriptor>;
	registeredBlocks?: Array<(editor: EditorHandle) => BlockDescriptor>;
	registeredActions?: ActionDescriptor[];
};

export class PlimDriver {
	readonly theme: Theme;
	readonly markFactories: Array<(editor: EditorHandle) => MarkDescriptor>;
	readonly blockFactories: Array<(editor: EditorHandle) => BlockDescriptor>;
	readonly actions: ActionDescriptor[];
	readonly extensions: ExtensionFactory[];

	private historyControllers = new Set<unknown>();

	constructor(config: PlimDriverConfig = {}) {
		this.theme = config.theme ?? 'light';
		this.markFactories = config.registeredMarks ?? [];
		this.blockFactories = config.registeredBlocks ?? [];
		this.actions = config.registeredActions ?? [];
		this.extensions = config.extensions ?? [];
	}

	resolveBlocks(editor: EditorHandle): BlockDescriptor[] {
		return this.blockFactories.map((f) => f(editor));
	}

	resolveMarks(editor: EditorHandle): MarkDescriptor[] {
		return this.markFactories.map((f) => f(editor));
	}

	getHistory(): {
		undo: () => void;
		redo: () => void;
		canUndo: boolean;
		canRedo: boolean;
		onChange: (cb: (s: unknown) => void) => () => void;
	} {
		// returns the most recently created editor's history controller; or a stub
		const ctrl = this.__primaryHistory;
		if (ctrl) return ctrl;
		return {
			undo: () => {},
			redo: () => {},
			canUndo: false,
			canRedo: false,
			onChange: () => () => {},
		};
	}

	/** @internal */ __primaryHistory: ReturnType<PlimDriver['getHistory']> | null = null;
	/** @internal */ __setPrimaryHistory(ctrl: ReturnType<PlimDriver['getHistory']>) {
		this.__primaryHistory = ctrl;
	}
}
