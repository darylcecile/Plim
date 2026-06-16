import type { EditorState, TransactionOp } from './transaction.js';
import type { Selection } from './selection.js';

export type HistoryEntry = {
	stateBefore: EditorState;
	stateAfter: EditorState;
	label?: string;
	timestamp: number;
	/** The forward ops of the transaction, deep-cloned. Replayed on redo. */
	ops?: TransactionOp[];
	/**
	 * The op-based inverse of the transaction, computed at dispatch time.
	 * Replayed on undo so undo/redo flow through `dispatch` as real recorded
	 * transactions. `undefined` when the transaction was not invertible — the
	 * controller then falls back to a snapshot restore.
	 */
	inverse?: TransactionOp[];
	/** Selection before the transaction; restored as the caret on undo. */
	selectionBefore?: Selection;
};

export type HistoryListener = (snapshot: { canUndo: boolean; canRedo: boolean; past: HistoryEntry[]; future: HistoryEntry[] }) => void;

export class History {
	private past: HistoryEntry[] = [];
	private future: HistoryEntry[] = [];
	private listeners = new Set<HistoryListener>();
	private maxSize = 200;

	push(entry: HistoryEntry): void {
		this.past.push(entry);
		if (this.past.length > this.maxSize) this.past.shift();
		this.future.length = 0;
		this.notify();
	}

	popUndo(): HistoryEntry | null {
		const e = this.past.pop();
		if (!e) return null;
		this.future.push(e);
		this.notify();
		return e;
	}

	popRedo(): HistoryEntry | null {
		const e = this.future.pop();
		if (!e) return null;
		this.past.push(e);
		this.notify();
		return e;
	}

	get canUndo(): boolean {
		return this.past.length > 0;
	}
	get canRedo(): boolean {
		return this.future.length > 0;
	}

	onChange(cb: HistoryListener): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	private notify() {
		const snap = { canUndo: this.canUndo, canRedo: this.canRedo, past: [...this.past], future: [...this.future] };
		for (const l of this.listeners) l(snap);
	}
}
