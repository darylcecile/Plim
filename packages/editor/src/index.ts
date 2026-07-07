import {
	type ActionContext,
	type ActionDescriptor,
	type BlockDescriptor,
	type BlockPayload,
	type DocumentNode,
	type EditorHandle,
	type EditorState,
	type ExtensionShape,
	type MarkDescriptor,
	History,
	PlimDriver,
	Snapshot,
	Transaction,
	type TransactionOp,
	type Trigger,
	type ValidationContext,
	applyTransaction,
	builders,
	cloneSelection,
	evalRule,
	invertOps,
	matchKeyboardEvent,
	newId,
	processExtension,
} from '@plim/core';
import { mountView, type View, type ViewOptions } from './view.js';
import { runBuiltInBeforeAction, runBuiltInKey } from './builtin-actions.js';
import { pastePlainText, pasteMarkdown, pasteHtml, pastePlimNative, pasteUrlOnSelection, pasteSingleBlock, looksLikeMarkdown, type PasteData } from './paste.js';

export type ContainerAdapter = {
	resolve(): HTMLElement | null;
};

export function attachContainer(getter: () => HTMLElement | null): ContainerAdapter {
	return { resolve: getter };
}

export type DeriveEditorOptions = {
	containerAdapter: ContainerAdapter;
	initialContent?: DocumentNode;
	readonly?: boolean;
	autoFocus?: boolean;
	// Bridge for `BlockDescriptor.toComponent`: called with the host element
	// the editor created inside a custom block's wrapper, the current payload,
	// and the descriptor. The implementation is expected to mount/update its
	// component tree into `host` (e.g., via `react-dom`'s `createRoot`).
	renderReactBlock?: (host: HTMLElement, payload: BlockPayload, desc: BlockDescriptor) => void;
	// Single-block ("input box") mode. Suppresses block handles, prevents Enter
	// from splitting into new blocks, and keeps paste within the single block.
	// Inline marks, markdown input rules, slash commands, mentions and mojis
	// all keep working. See `@plim/react`'s `PlimInputBox` for the React wrapper.
	singleBlock?: boolean;
	// Placeholder text shown while the (single) block is empty. Only rendered
	// in `singleBlock` mode.
	placeholder?: string;
	// Called on a plain Enter (no Shift) in `singleBlock` mode. Return `true`
	// to consume the keystroke (e.g. after submitting); return falsy to insert
	// a soft line break instead. Ignored outside single-block mode.
	onEnter?: () => boolean | void;
};

export type AgnosticEditor = EditorHandle & {
	mount(): void;
	destroy(): void;
	readonly view: View | null;
};

const EMPTY_DOC: DocumentNode = {
	type: 'doc',
	children: [{ id: newId(), type: 'paragraph', text: [] }],
};

export function deriveEditor(plim: PlimDriver, options: DeriveEditorOptions): AgnosticEditor {
	let state: EditorState = {
		doc: options.initialContent ?? EMPTY_DOC,
		selection: {
			anchor: { path: [0], offset: 0 },
			head: { path: [0], offset: 0 },
		},
	};

	const history = new History();
	const txListeners = new Set<(tx: Transaction, state: EditorState) => void>();
	const asyncListeners = new Map<string, Array<(event: { name: string; payload?: unknown }, state: EditorState, ctx: ActionContext) => Promise<unknown> | unknown>>();
	const readyCallbacks: Array<() => void> = [];
	let ready = false;
	let view: View | null = null;
	let destroyed = false;
	const extensionShapes: ExtensionShape[] = [];

	function dispatch(tx: Transaction): void {
		const before = state;
		const next = applyTransaction(state, tx);
		state = next;
		if (tx.meta.addToHistory !== false) {
			const inverse = invertOps(tx.ops, before);
			history.push({
				stateBefore: before,
				stateAfter: next,
				timestamp: Date.now(),
				ops: cloneOps(tx.ops),
				...(inverse ? { inverse } : {}),
				selectionBefore: before.selection,
			});
		}
		for (const cb of txListeners) cb(tx, state);
		for (const ext of extensionShapes) {
			ext.onTransaction?.(tx, ctx);
		}
		view?.update(state);
	}

	function cloneOps(ops: readonly TransactionOp[]): TransactionOp[] {
		return JSON.parse(JSON.stringify(ops)) as TransactionOp[];
	}

	function createTransaction(): Transaction {
		const tx = new Transaction(state);
		tx.__bindCommitter((t) => dispatch(t));
		return tx;
	}

	async function triggerAsyncEvent<T = unknown>(name: string, payload?: unknown): Promise<T> {
		const event = { name, payload };
		const handlers = asyncListeners.get(name);
		if (!handlers || handlers.length === 0) return undefined as T;
		// Run handlers in registration order; resolve when all resolve, returning first non-undefined
		const results: unknown[] = [];
		for (const h of handlers) {
			results.push(await h(event, state, ctx));
		}
		// also notify extensions
		for (const ext of extensionShapes) {
			if (ext.onAsyncEvent) await ext.onAsyncEvent(name, state, ctx);
		}
		return (results.find((r) => r !== undefined) as T) ?? (undefined as T);
	}

	const ctx: ActionContext = {
		createTransaction,
		triggerAsyncEvent,
		dispatch,
		get state() {
			return state;
		},
	};

	// ---- Build registries (extensions can contribute) ----
	// We must resolve blocks/marks AFTER the editor handle exists so factories
	// can close over it (e.g., a `<CounterCard>` that commits transactions on
	// click). The arrays themselves are declared up-front and the editor
	// holds references to them; we mutate in place once the handle is built.
	const blocks: BlockDescriptor[] = [];
	const marks: MarkDescriptor[] = [];
	const actions: ActionDescriptor[] = [...plim.actions];

	function supportsDecoration(blockType: string): boolean {
		const desc = blocks.find((b) => b.name === blockType);
		if (!desc) return true;
		if (desc.supportsDecoration === false) return false;
		return true;
	}

	// ---- Ready management ----
	function markReady() {
		if (ready) return;
		ready = true;
		while (readyCallbacks.length) readyCallbacks.shift()!();
	}

	const editor: AgnosticEditor = {
		plim,
		get isReady() {
			return ready;
		},
		get view() {
			return view;
		},
		history,
		blocks,
		marks,
		actions,
		supportsDecoration,
		triggerAsyncEvent,
		getState: () => state,
		setState: (s) => {
			state = s;
			view?.update(state);
		},
		dispatch,
		createTransaction,
		onTransaction: (cb) => {
			txListeners.add(cb);
			return () => txListeners.delete(cb);
		},
		onAsyncEvent: (name, handler) => {
			let arr = asyncListeners.get(name);
			if (!arr) {
				arr = [];
				asyncListeners.set(name, arr);
			}
			arr.push(handler as (event: { name: string; payload?: unknown }, state: EditorState, ctx: ActionContext) => Promise<unknown> | unknown);
			return () => {
				const a = asyncListeners.get(name);
				if (!a) return;
				const idx = a.indexOf(handler as (event: { name: string; payload?: unknown }, state: EditorState, ctx: ActionContext) => Promise<unknown> | unknown);
				if (idx >= 0) a.splice(idx, 1);
			};
		},
		whenReady: (cb) => {
			if (ready) cb();
			else readyCallbacks.push(cb);
		},
		restoreSnapshot: (snap) => {
			editor.setState(JSON.parse(JSON.stringify(snap.data.state)) as EditorState);
		},
		mount() {
			if (destroyed) return;
			const container = options.containerAdapter.resolve();
			if (!container) {
				queueMicrotask(() => editor.mount());
				return;
			}
			if (view) return; // already mounted
			const viewOptions: ViewOptions = {
				container,
				readonly: options.readonly ?? false,
				blocks,
				marks,
				getState: () => state,
				dispatch,
				editor,
				onKeyboardEvent: handleKeyboardEvent,
				onClipboardEvent: handleClipboardEvent,
				onBeforeInput: handleBeforeInput,
				onPaste: handlePaste,
				...(options.renderReactBlock ? { renderReactBlock: options.renderReactBlock } : {}),
				...(options.singleBlock ? { singleBlock: true } : {}),
				...(options.placeholder != null ? { placeholder: options.placeholder } : {}),
				...(options.onEnter ? { onEnter: options.onEnter } : {}),
			};
			view = mountView(viewOptions);
			view.update(state);
			if (options.autoFocus) view.focus();
			markReady();
		},
		destroy() {
			destroyed = true;
			view?.destroy();
			view = null;
		},
	};

	// expose a primary history controller on the driver
	plim.__setPrimaryHistory({
		undo: () => {
			const e = history.popUndo();
			if (!e) return;
			if (e.inverse) {
				// Replay the op-based inverse through the normal dispatch path so
				// `txListeners` fire (an attached ledger records the undo) and the
				// live document stays the single source of truth.
				const tx = createTransaction();
				for (const op of cloneOps(e.inverse)) tx.ops.push(op);
				tx.setMeta('addToHistory', false);
				tx.setMeta('history', 'undo');
				if (e.selectionBefore) tx.setMeta('nextSelection', cloneSelection(e.selectionBefore));
				tx.commit();
			} else {
				// Non-invertible transaction: fall back to snapshot restore so undo
				// never breaks (the ledger will not record this step).
				state = e.stateBefore;
				view?.update(state);
			}
		},
		redo: () => {
			const e = history.popRedo();
			if (!e) return;
			if (e.ops) {
				const tx = createTransaction();
				for (const op of cloneOps(e.ops)) tx.ops.push(op);
				tx.setMeta('addToHistory', false);
				tx.setMeta('history', 'redo');
				tx.setMeta('nextSelection', cloneSelection(e.stateAfter.selection));
				tx.commit();
			} else {
				state = e.stateAfter;
				view?.update(state);
			}
		},
		get canUndo() {
			return history.canUndo;
		},
		get canRedo() {
			return history.canRedo;
		},
		onChange: (cb) => history.onChange(cb),
	});

	// Now that the editor handle exists, resolve blocks/marks and process
	// extensions with the real editor passed in. Factories close over it so
	// custom blocks (`defineBlock((editor) => ...)`) can commit transactions
	// without a deferred `() => editorAccess` lookup.
	for (const desc of plim.resolveBlocks(editor)) blocks.push(desc);
	for (const desc of plim.resolveMarks(editor)) marks.push(desc);
	for (const factory of plim.extensions) {
		const ext = processExtension(factory, editor);
		extensionShapes.push(ext);
		if (ext.registeredBlocks) for (const f of ext.registeredBlocks) blocks.push(f(editor));
		if (ext.registeredMarks) for (const f of ext.registeredMarks) marks.push(f(editor));
		if (ext.registeredActions) for (const a of ext.registeredActions) actions.push(a);
	}

	// ---- Input pipeline ----
	const pendingCancellations = new Map<ActionDescriptor, { cancel: () => void }>();

	async function tryFireActions(matched: ActionDescriptor[], ev: KeyboardEvent | ClipboardEvent | null): Promise<boolean> {
		matched.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
		const valCtx: ValidationContext = { state, supportsDecoration };
		for (const action of matched) {
			if (action.triggerValidationRules) {
				const rule = action.triggerValidationRules(builders);
				if (!evalRule(rule, valCtx)) continue;
			}
			// For `keyboard.character` triggers we let the browser insert the
			// character normally (so users see it as they type, e.g. `/`, `@`).
			// All other triggers (shortcuts, named keys, clipboard) get prevented.
			const triggers = Array.isArray(action.trigger) ? action.trigger : [action.trigger];
			const isCharTrigger = triggers.every((t) => t.kind === 'keyboard.character');
			if (!isCharTrigger) {
				ev?.preventDefault?.();
			}
			let cancelled = false;
			let resolved = false;
			const cancellation = {
				cancel: () => {
					cancelled = true;
				},
			};
			pendingCancellations.set(action, cancellation);
			try {
				const result = action.perform(state, ctx);
				if (result instanceof Promise) {
					result.finally(() => {
						resolved = true;
						pendingCancellations.delete(action);
					});
					await result;
				} else {
					resolved = true;
					pendingCancellations.delete(action);
				}
			} catch (err) {
				console.error('plim action error', err);
				pendingCancellations.delete(action);
			}
			if (cancelled && !resolved) {
				// ignore
			}
			return true;
		}
		return false;
	}

	function handleKeyboardEvent(ev: KeyboardEvent): void {
		// Run cancellation triggers for in-flight actions first
		for (const [action, cancellation] of [...pendingCancellations.entries()]) {
			if (action.cancellationTriggers?.some((t) => matchKeyboardEvent(t, ev))) {
				cancellation.cancel();
				pendingCancellations.delete(action);
			}
		}
		// Match registered actions
		const matched: ActionDescriptor[] = [];
		for (const a of actions) {
			const triggers = Array.isArray(a.trigger) ? a.trigger : [a.trigger];
			if (triggers.some((t) => matchKeyboardEvent(t, ev))) matched.push(a);
		}
		if (matched.length) {
			tryFireActions(matched, ev);
			return;
		}
		// Built-in core key handling (split, join, navigation, list shortcuts)
		const handled = runBuiltInKey(ev, state, ctx, blocks);
		if (handled) ev.preventDefault();
	}

	function handleClipboardEvent(action: 'cut' | 'copy' | 'paste', ev: ClipboardEvent): void {
		const matched: ActionDescriptor[] = [];
		for (const a of actions) {
			const triggers = Array.isArray(a.trigger) ? a.trigger : [a.trigger];
			if (triggers.some((t) => t.kind === 'clipboard.action' && t.action === action)) matched.push(a);
		}
		if (matched.length) tryFireActions(matched, ev);
	}

	function handleBeforeInput(text: string): void {
		// Match character triggers (e.g., `/`, `@`, `:`)
		if (text.length === 1) {
			const ch = text;
			const matched: ActionDescriptor[] = [];
			for (const a of actions) {
				const triggers = Array.isArray(a.trigger) ? a.trigger : [a.trigger];
				if (triggers.some((t) => t.kind === 'keyboard.character' && t.char === ch)) matched.push(a);
			}
			if (matched.length) {
				// validate, then run before-action then fire
				const valCtx: ValidationContext = { state, supportsDecoration };
				const ok = matched.find((a) => !a.triggerValidationRules || evalRule(a.triggerValidationRules(builders), valCtx));
				if (ok) {
					// Insert the trigger character first so the user sees it (Notion behavior)
					runBuiltInBeforeAction(text, state, ctx);
					tryFireActions([ok], null);
					return;
				}
			}
		}
		runBuiltInBeforeAction(text, state, ctx);
	}

	/**
	 * Paste pipeline entry point. Returns true if it fully handled the paste
	 * (caller skips its plain-text fallback), false to fall through. Phases
	 * are added incrementally; the present phase covers plain text with
	 * Notion-style block splitting on blank lines.
	 */
	function handlePaste(data: PasteData): boolean {
		// Phase 4 — extension hook. Each extension that registered a
		// `transformPaste` gets first crack at the payload, in registration
		// order. The first to return `true` is treated as authoritative;
		// later extensions and the built-in pipeline don't run.
		for (const ext of extensionShapes) {
			if (!ext.transformPaste) continue;
			const handled = ext.transformPaste(data, ctx);
			if (handled === true) return true;
		}
		// Single-block ("input box") mode: never insert block structure. After
		// giving extensions their turn above (so mojis/mentions can still
		// transform a pasted payload), flatten the plain text into the current
		// block. Returning here short-circuits the native/URL/HTML/markdown/
		// plaintext phases below, all of which can create extra blocks.
		if (options.singleBlock) {
			if (data.text) return pasteSingleBlock(data.text, ctx);
			return false;
		}
		// Phase 0 — Plim-native lossless. Set by `clipboard.ts` whenever the
		// copy source is another plim editor. Preserves block types/attrs/
		// nesting that would degrade through markdown (e.g. callouts → quote
		// without `fromMarkdown` registered, image attrs, code language).
		if (data.plim && pastePlimNative(data.plim, ctx)) return true;
		// Phase 0.5 — auto-link a URL onto a non-collapsed selection.
		// Runs before HTML/markdown so a user pasting a bare URL onto
		// selected text always gets a link, not a replacement. Bails
		// (returns false) when payload isn't a URL, selection is
		// collapsed, or `link` mark isn't registered — caller falls
		// through to the rest of the pipeline.
		if (data.text && pasteUrlOnSelection(data.text, ctx, marks)) return true;
		// Phase 3 — HTML clipboard.
		if (data.html && pasteHtml(data.html, ctx)) return true;
		// Phase 2 — markdown auto-detect on plain text. Threading `blocks`
		// here lets descriptor `fromMarkdown` hooks restore custom blocks
		// (callouts etc.) from `text/plain` clipboards (other apps, plim
		// editors without the custom MIME).
		if (data.text && looksLikeMarkdown(data.text)) {
			if (pasteMarkdown(data.text, ctx, blocks)) return true;
		}
		// Phase 1 — plain text with paragraph splitting.
		if (data.text) {
			return pastePlainText(data.text, ctx);
		}
		return false;
	}

	queueMicrotask(() => editor.mount());

	return editor;
}
