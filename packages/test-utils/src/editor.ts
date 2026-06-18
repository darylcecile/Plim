import {
	History,
	PlimDriver,
	Snapshot,
	Transaction,
	applyTransaction,
	builtInBlocks,
	builtInMarks,
	cloneSelection,
	processExtension,
} from '@plim/core';
import type {
	ActionContext,
	ActionDescriptor,
	AsyncEventHandler,
	BlockDescriptor,
	BlockNode,
	DocumentNode,
	EditorHandle,
	EditorState,
	ExtensionFactory,
	ExtensionShape,
	MarkDescriptor,
	Selection,
} from '@plim/core';
import { doc, paragraph } from './builders.js';

export type TestEditorOptions = {
	content?: DocumentNode | BlockNode[];
	selection?: Selection;
	blocks?: Array<(editor: EditorHandle) => BlockDescriptor>;
	marks?: Array<(editor: EditorHandle) => MarkDescriptor>;
	extensions?: ExtensionFactory[];
};

export type TestEditor = EditorHandle;

type AsyncListener = (event: { name: string; payload?: unknown; }, state: EditorState, ctx: ActionContext) => Promise<unknown> | unknown;

export function createTestEditor(options: TestEditorOptions = {}): TestEditor {
	let state: EditorState = {
		doc: contentToDoc(options.content),
		selection: cloneSelection(options.selection ?? { anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } }),
	};
	const plim = new PlimDriver({
		registeredBlocks: [...builtInBlocks, ...(options.blocks ?? [])],
		registeredMarks: [...builtInMarks, ...(options.marks ?? [])],
		extensions: options.extensions ?? [],
	});
	const history = new History();
	const txListeners = new Set<(tx: Transaction, state: EditorState) => void>();
	const asyncListeners = new Map<string, AsyncListener[]>();
	const readyCallbacks: Array<() => void> = [];
	const blocks: BlockDescriptor[] = [];
	const marks: MarkDescriptor[] = [];
	const actions: ActionDescriptor[] = [...plim.actions];
	const extensionShapes: ExtensionShape[] = [];

	function dispatch(tx: Transaction): void {
		const next = applyTransaction(state, tx);
		state = next;
		for (const cb of txListeners) cb(tx, state);
		for (const ext of extensionShapes) ext.onTransaction?.(tx, { state, editor });
	}

	function createTransaction(): Transaction {
		const tx = new Transaction(state);
		tx.__bindCommitter((committed) => dispatch(committed));
		return tx;
	}

	const ctx: ActionContext = {
		createTransaction,
		triggerAsyncEvent,
		dispatch,
		get state() {
			return state;
		},
	};

	async function triggerAsyncEvent<T = unknown>(name: string, payload?: unknown): Promise<T> {
		const event = payload === undefined ? { name } : { name, payload };
		const results: unknown[] = [];
		for (const handler of asyncListeners.get(name) ?? []) results.push(await handler(event, state, ctx));
		for (const ext of extensionShapes) {
			if (ext.onAsyncEvent) results.push(await ext.onAsyncEvent(name, state, ctx));
		}
		return (results.find((result) => result !== undefined) as T) ?? (undefined as T);
	}

	const editor: TestEditor = {
		plim,
		isReady: true,
		history,
		blocks,
		marks,
		actions,
		supportsDecoration: (blockType) => blocks.find((desc) => desc.name === blockType)?.supportsDecoration !== false,
		getState: () => state,
		setState: (next) => {
			state = cloneState(next);
		},
		dispatch,
		createTransaction,
		onTransaction: (cb) => {
			txListeners.add(cb);
			return () => txListeners.delete(cb);
		},
		onAsyncEvent: (name, handler) => {
			const listeners = asyncListeners.get(name) ?? [];
			listeners.push(handler as AsyncEventHandler<unknown>);
			asyncListeners.set(name, listeners);
			return () => {
				const current = asyncListeners.get(name);
				if (!current) return;
				const index = current.indexOf(handler as AsyncEventHandler<unknown>);
				if (index >= 0) current.splice(index, 1);
			};
		},
		triggerAsyncEvent,
		whenReady: (cb) => {
			readyCallbacks.push(cb);
			cb();
		},
		restoreSnapshot: (snap: Snapshot) => {
			editor.setState(snap.data.state);
		},
	};

	blocks.push(...plim.resolveBlocks(editor));
	marks.push(...plim.resolveMarks(editor));
	for (const factory of plim.extensions) {
		const shape = processExtension(factory, editor);
		extensionShapes.push(shape);
		if (shape.registeredBlocks) blocks.push(...shape.registeredBlocks.map((factory) => factory(editor)));
		if (shape.registeredMarks) marks.push(...shape.registeredMarks.map((factory) => factory(editor)));
		if (shape.registeredActions) actions.push(...shape.registeredActions);
	}
	plim.__setPrimaryHistory({
		undo: () => {},
		redo: () => {},
		get canUndo() {
			return history.canUndo;
		},
		get canRedo() {
			return history.canRedo;
		},
		onChange: (cb) => history.onChange(cb),
	});
	return editor;
}

export function applyTx(editor: TestEditor, build: (tx: Transaction) => void): EditorState {
	const tx = editor.createTransaction();
	build(tx);
	tx.commit();
	return editor.getState();
}

export function apply(state: EditorState, build: (tx: Transaction) => void): EditorState {
	const tx = new Transaction(state);
	build(tx);
	tx.commit();
	return applyTransaction(state, tx);
}

function contentToDoc(content: DocumentNode | BlockNode[] | undefined): DocumentNode {
	if (!content) return doc(paragraph());
	if (Array.isArray(content)) return doc(...content);
	return content;
}

function cloneState(stateToClone: EditorState): EditorState {
	return JSON.parse(JSON.stringify(stateToClone)) as EditorState;
}
