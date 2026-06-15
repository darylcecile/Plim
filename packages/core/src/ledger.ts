// Transaction ledger — an append-only, serializable, replayable log of
// committed transactions, plus the merge/diff utilities a sync or CRDT engine
// is built on top of. Sits alongside `history.ts` (undo/redo) and
// `snapshot.ts` (full-state capture); where those serve a single editing
// session, the ledger is the unit of exchange *between* editors.
//
// The serialized intermediary type is `LedgerRecord`: a flat, JSON-safe
// snapshot of one transaction's `ops` + `meta`, stamped with identity
// (`id`/`source`), a wall-clock `timestamp`, a logical `lamport` clock, and a
// pre-computed id-keyed `touches` conflict surface. Records carry no document
// — they are pure operations — so they stay small and cheap to ship.
//
// See `ledger-conflict.ts` for conflict detection/resolution and
// `ledger-rebase.ts` for operational-transform position mapping.

import { type DocumentNode, newId } from './document.js';
import { type Selection, cloneSelection } from './selection.js';
import { type EditorState, type Transaction, type TransactionMeta, type TransactionOp, applyOp } from './transaction.js';
import type { EditorHandle } from './editor-handle.js';
import { type RecordTouch, computeTouches } from './ledger-conflict.js';

/** A flat, JSON-serializable snapshot of one committed transaction. */
export type LedgerRecord = {
	/** Stable unique id — the dedupe/diff key across ledgers. */
	id: string;
	/** The transaction's operations, deep-cloned so the record is self-contained. */
	ops: TransactionOp[];
	/** Wall-clock time of authoring (ms since epoch). Primary chronological key. */
	timestamp: number;
	/** Logical (Lamport) clock for deterministic causal ordering and tie-breaking. */
	lamport: number;
	/** Origin of the edit (client/editor/site id), if known. */
	source?: string;
	/** Per-source monotonic counter. Powers version vectors for delta sync; optional. */
	seq?: number;
	/** Carried-through transaction metadata (e.g. `nextSelection`). Best-effort serializable. */
	meta?: TransactionMeta;
	/** Id-keyed conflict surface, resolved against the base doc at record time. */
	touches: RecordTouch[];
};

/** The serialized form of a whole ledger. Versioned like `SnapshotData`. */
export type LedgerSnapshot = {
	version: 1;
	source?: string;
	clock: number;
	records: LedgerRecord[];
};

export type LedgerOptions = {
	/** Stamped onto every record this ledger authors via `record`/`attach`. */
	source?: string;
	/** Total ordering used to keep records sorted. Defaults to `compareRecords`. */
	compare?: (a: LedgerRecord, b: LedgerRecord) => number;
	/** Drop records whose `id` is already present on append/merge. Default `true`. */
	dedupe?: boolean;
};

export type RecordFromTransactionOptions = {
	id?: string;
	source?: string;
	timestamp?: number;
	lamport?: number;
	/** Document to resolve `touches` against. Defaults to the transaction's base state (`tx.state.doc`). */
	baseDoc?: DocumentNode;
};

export type AttachOptions = {
	/** Return `false` to skip recording a given transaction (e.g. ephemeral/selection-only edits). */
	filter?: (tx: Transaction) => boolean;
};

export type LedgerDiff = {
	/** Records present in `a` but not `b`. */
	onlyInA: LedgerRecord[];
	/** Records present in `b` but not `a`. */
	onlyInB: LedgerRecord[];
	/** Records present in both, by id. */
	common: LedgerRecord[];
};

export type RecordSummary = {
	id: string;
	source?: string;
	timestamp: number;
	lamport: number;
	ops: number;
	opKinds: Record<string, number>;
	blocks: string[];
};

function jsonClone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/** Canonical total order: `timestamp → lamport → source → id`. Deterministic. */
export function compareRecords(a: LedgerRecord, b: LedgerRecord): number {
	if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
	if (a.lamport !== b.lamport) return a.lamport - b.lamport;
	const as = a.source ?? '';
	const bs = b.source ?? '';
	if (as !== bs) return as < bs ? -1 : 1;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Fold one record's ops over an `EditorState`, then apply its recorded final
 * selection (`meta.nextSelection`) if present — mirroring `applyTransaction`.
 * Pure; the input state is never mutated.
 */
export function applyLedgerRecord(state: EditorState, record: LedgerRecord): EditorState {
	let next = state;
	for (const op of record.ops) next = applyOp(next, op);
	const nextSel = record.meta?.nextSelection as Selection | undefined;
	if (nextSel) next = { doc: next.doc, selection: cloneSelection(nextSel) };
	return next;
}

/**
 * Build a self-contained `LedgerRecord` from a committed (or in-flight)
 * transaction. Ops and meta are deep-cloned to JSON so the record never
 * aliases live editor state, and `touches` is resolved once against the base
 * document the transaction was authored against.
 */
export function recordFromTransaction(tx: Transaction, options: RecordFromTransactionOptions = {}): LedgerRecord {
	const baseDoc = options.baseDoc ?? tx.state.doc;
	const ops = jsonClone(tx.ops as TransactionOp[]);
	const meta = jsonClone(tx.meta) as TransactionMeta;
	const record: LedgerRecord = {
		id: options.id ?? newId('rec'),
		ops,
		timestamp: options.timestamp ?? Date.now(),
		lamport: options.lamport ?? 0,
		touches: computeTouches(ops, baseDoc),
		...(options.source !== undefined ? { source: options.source } : {}),
		...(Object.keys(meta).length > 0 ? { meta } : {}),
	};
	return record;
}

/** A lightweight, human-readable précis of a record — handy for diff UIs and logging. */
export function summarizeRecord(record: LedgerRecord): RecordSummary {
	const opKinds: Record<string, number> = {};
	for (const op of record.ops) opKinds[op.kind] = (opKinds[op.kind] ?? 0) + 1;
	const blocks = [...new Set(record.touches.map((t) => t.blockId))];
	return {
		id: record.id,
		...(record.source !== undefined ? { source: record.source } : {}),
		timestamp: record.timestamp,
		lamport: record.lamport,
		ops: record.ops.length,
		opKinds,
		blocks,
	};
}

export type LedgerListener = (record: LedgerRecord) => void;

/**
 * An ordered, append-only log of `LedgerRecord`s.
 *
 * The internal array is kept sorted by the configured comparator at all times
 * (binary-search insertion), so `records` is always in chronological order and
 * `merge` is a stable union. Records are immutable once appended; the ledger
 * never mutates them.
 */
export class TransactionLedger {
	/** Source id stamped onto records this ledger authors. */
	readonly source: string | undefined;

	private _records: LedgerRecord[] = [];
	private _ids = new Set<string>();
	private clockValue = 0;
	private readonly compareFn: (a: LedgerRecord, b: LedgerRecord) => number;
	private readonly dedupe: boolean;
	private readonly listeners = new Set<LedgerListener>();

	constructor(options: LedgerOptions = {}) {
		this.source = options.source;
		this.compareFn = options.compare ?? compareRecords;
		this.dedupe = options.dedupe ?? true;
	}

	/** All records, in chronological order. Treat as read-only. */
	get records(): readonly LedgerRecord[] {
		return this._records;
	}

	get length(): number {
		return this._records.length;
	}

	/** The ledger's logical (Lamport) clock — the high-water mark of observed lamports. */
	get clock(): number {
		return this.clockValue;
	}

	/** The total-ordering comparator this ledger sorts by. */
	get comparator(): (a: LedgerRecord, b: LedgerRecord) => number {
		return this.compareFn;
	}

	at(index: number): LedgerRecord | undefined {
		return this._records[index];
	}

	slice(start?: number, end?: number): LedgerRecord[] {
		return this._records.slice(start, end);
	}

	[Symbol.iterator](): Iterator<LedgerRecord> {
		return this._records[Symbol.iterator]();
	}

	/**
	 * Record a transaction as a new entry authored by this ledger. Assigns the
	 * next lamport tick (unless one is supplied) and the ledger's `source`.
	 */
	record(tx: Transaction, options: RecordFromTransactionOptions = {}): LedgerRecord {
		const lamport = options.lamport ?? ++this.clockValue;
		if (options.lamport !== undefined) this.clockValue = Math.max(this.clockValue, options.lamport);
		const rec = recordFromTransaction(tx, {
			...(this.source !== undefined ? { source: this.source } : {}),
			...options,
			lamport,
		});
		if (this.insertOrdered(rec)) this.emit(rec);
		return rec;
	}

	/**
	 * Append an already-formed record (e.g. received from another ledger or the
	 * network). Advances the logical clock to at least the record's lamport.
	 * Returns `false` if it was a duplicate and `dedupe` is on.
	 */
	append(record: LedgerRecord): boolean {
		this.clockValue = Math.max(this.clockValue, record.lamport);
		const added = this.insertOrdered(record);
		if (added) this.emit(record);
		return added;
	}

	/** Append many records; returns how many were newly added. */
	appendAll(records: Iterable<LedgerRecord>): number {
		let added = 0;
		for (const r of records) if (this.append(r)) added++;
		return added;
	}

	/**
	 * Subscribe an editor so every future committed transaction is recorded.
	 * Returns a detach function. Undo/redo bypass `dispatch` and so are not
	 * recorded — only forward edits are. Use `options.filter` to skip
	 * transactions you don't want in the log.
	 */
	attach(editor: EditorHandle, options: AttachOptions = {}): () => void {
		return editor.onTransaction((tx) => {
			if (options.filter && !options.filter(tx)) return;
			this.record(tx);
		});
	}

	/** Fold the whole ledger over a state. Pure — the canonical replay primitive. */
	apply(state: EditorState): EditorState {
		let next = state;
		for (const rec of this._records) next = applyLedgerRecord(next, rec);
		return next;
	}

	/** Fold a `[start, end)` slice of the ledger over a state. */
	applyRange(state: EditorState, start?: number, end?: number): EditorState {
		let next = state;
		for (const rec of this._records.slice(start, end)) next = applyLedgerRecord(next, rec);
		return next;
	}

	/**
	 * Replay the ledger onto a live editor in a single `setState` — no history
	 * pollution, one view update. The editor's current state is the base the
	 * records are applied on top of, so replay onto a fresh editor seeded with
	 * the same base reproduces the source document exactly.
	 */
	replay(editor: EditorHandle): void {
		editor.setState(this.apply(editor.getState()));
	}

	/** Chronological union with other ledgers (deduped by id). Returns a new ledger. */
	merge(...others: TransactionLedger[]): TransactionLedger {
		return mergeLedgers(this, ...others);
	}

	/** Set-difference against another ledger, by record id. */
	diff(other: TransactionLedger): LedgerDiff {
		return diffLedgers(this, other);
	}

	/** A shallow copy (records are shared, never mutated). */
	clone(): TransactionLedger {
		const next = new TransactionLedger(this.toOptions());
		next._records = this._records.slice();
		next._ids = new Set(this._ids);
		next.clockValue = this.clockValue;
		return next;
	}

	/** Drop all records. The logical clock is preserved (it must never run backwards). */
	clear(): void {
		this._records = [];
		this._ids.clear();
	}

	onRecord(listener: LedgerListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	toJSON(): LedgerSnapshot {
		return {
			version: 1,
			...(this.source !== undefined ? { source: this.source } : {}),
			clock: this.clockValue,
			records: this._records,
		};
	}

	serialize(): string {
		return JSON.stringify(this.toJSON());
	}

	static fromSnapshot(snapshot: LedgerSnapshot, options: LedgerOptions = {}): TransactionLedger {
		const ledger = new TransactionLedger({
			...(snapshot.source !== undefined ? { source: snapshot.source } : {}),
			...options,
		});
		ledger.appendAll(snapshot.records ?? []);
		ledger.clockValue = Math.max(ledger.clockValue, snapshot.clock ?? 0);
		return ledger;
	}

	static deserialize(payload: string, options: LedgerOptions = {}): TransactionLedger {
		return TransactionLedger.fromSnapshot(JSON.parse(payload) as LedgerSnapshot, options);
	}

	private toOptions(): LedgerOptions {
		return {
			...(this.source !== undefined ? { source: this.source } : {}),
			compare: this.compareFn,
			dedupe: this.dedupe,
		};
	}

	private insertOrdered(rec: LedgerRecord): boolean {
		if (this.dedupe && this._ids.has(rec.id)) return false;
		const arr = this._records;
		let lo = 0;
		let hi = arr.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (this.compareFn(arr[mid]!, rec) <= 0) lo = mid + 1;
			else hi = mid;
		}
		arr.splice(lo, 0, rec);
		this._ids.add(rec.id);
		return true;
	}

	private emit(rec: LedgerRecord): void {
		for (const l of this.listeners) l(rec);
	}
}

/**
 * Merge any number of ledgers into a new one, preserving chronological order
 * and de-duplicating by record id. The result inherits the first ledger's
 * comparator so the ordering is well-defined.
 */
export function mergeLedgers(...ledgers: TransactionLedger[]): TransactionLedger {
	const first = ledgers[0];
	const merged = new TransactionLedger(first ? { compare: first.comparator } : {});
	for (const ledger of ledgers) {
		for (const rec of ledger.records) merged.append(rec);
	}
	return merged;
}

/** Set-difference of two ledgers by record id. */
export function diffLedgers(a: TransactionLedger, b: TransactionLedger): LedgerDiff {
	const aIds = new Set(a.records.map((r) => r.id));
	const bIds = new Set(b.records.map((r) => r.id));
	return {
		onlyInA: a.records.filter((r) => !bIds.has(r.id)),
		onlyInB: b.records.filter((r) => !aIds.has(r.id)),
		common: a.records.filter((r) => bIds.has(r.id)),
	};
}
