// Conflict surface for ledger records.
//
// A `LedgerRecord` carries a pre-computed, **id-keyed** description of the
// regions of the document it touches (`RecordTouch[]`). It is resolved once,
// at record time, against the base document the transaction was authored
// against (see `recordFromTransaction` in `ledger.ts`). Working in block-id
// space — rather than positional `BlockPath` space — is the whole trick: ids
// are stable across concurrent edits, paths are not. Two records can therefore
// be tested for conflict at merge time with **no document on hand**, which
// keeps merge/diff cheap and order-independent.
//
// The model is deliberately conservative: when in doubt it reports a conflict
// rather than silently letting two edits clobber each other. Callers that want
// to *transform* instead of *drop* one side reach for `ledger-rebase.ts`.

import { type DocumentNode } from '@plim/core';
import { type BlockPath, getBlockAt, prevBlockPath } from '@plim/core';
import type { TransactionOp } from '@plim/core';
import type { LedgerRecord } from './ledger.js';

/** Sentinel block id standing in for the document root in structural touches. */
export const ROOT_ID = '#root';

/**
 * One region of the document a record touches, keyed by block id.
 *
 * - `text`  — a character range `[from, to)` of a block's inline content was replaced.
 * - `marks` — a character range `[from, to)` of a block had a mark toggled.
 * - `props` — a block's `type`/`attrs` changed.
 * - `children` — a parent's child list changed (insert/remove/move/split/join).
 *   `affected` lists ids that left/entered that parent, so an edit to a block
 *   another record deleted or moved is detectable as a conflict.
 */
export type RecordTouch = {
	blockId: string;
	scope: 'text' | 'marks' | 'props' | 'children';
	from?: number;
	to?: number;
	affected?: string[];
};

function blockIdAt(doc: DocumentNode, path: BlockPath): string | null {
	return getBlockAt(doc, path)?.id ?? null;
}

function parentIdOf(doc: DocumentNode, path: BlockPath): string {
	if (path.length <= 1) return ROOT_ID;
	return getBlockAt(doc, path.slice(0, -1))?.id ?? ROOT_ID;
}

/**
 * Resolve the id-keyed conflict surface of a list of ops against the document
 * they were authored against. Pure; runs in `O(ops)` plus the cost of path
 * resolution. `setSelection` ops contribute nothing — moving a caret never
 * conflicts with content.
 */
export function computeTouches(ops: readonly TransactionOp[], baseDoc: DocumentNode): RecordTouch[] {
	const touches: RecordTouch[] = [];
	const END = Number.MAX_SAFE_INTEGER;
	for (const op of ops) {
		switch (op.kind) {
			case 'setSelection':
				break;
			case 'replaceText': {
				const id = blockIdAt(baseDoc, op.path);
				if (id) touches.push({ blockId: id, scope: 'text', from: op.from, to: op.to });
				break;
			}
			case 'toggleMark':
			case 'addMark':
			case 'removeMark': {
				const id = blockIdAt(baseDoc, op.path);
				if (id) touches.push({ blockId: id, scope: 'marks', from: op.from, to: op.to === -1 ? END : op.to });
				break;
			}
			case 'setBlockAttrs':
			case 'setBlockType': {
				const id = blockIdAt(baseDoc, op.path);
				if (id) touches.push({ blockId: id, scope: 'props' });
				break;
			}
			case 'insertBlock': {
				touches.push({ blockId: parentIdOf(baseDoc, op.path), scope: 'children' });
				break;
			}
			case 'removeBlock': {
				const id = blockIdAt(baseDoc, op.path);
				touches.push({ blockId: parentIdOf(baseDoc, op.path), scope: 'children', ...(id ? { affected: [id] } : {}) });
				break;
			}
			case 'moveBlock': {
				const id = blockIdAt(baseDoc, op.from);
				const affected = id ? { affected: [id] } : {};
				touches.push({ blockId: parentIdOf(baseDoc, op.from), scope: 'children', ...affected });
				touches.push({ blockId: parentIdOf(baseDoc, op.to), scope: 'children', ...affected });
				break;
			}
			case 'splitBlock': {
				const id = blockIdAt(baseDoc, op.path);
				if (id) touches.push({ blockId: id, scope: 'text', from: op.offset, to: END });
				touches.push({ blockId: parentIdOf(baseDoc, op.path), scope: 'children' });
				break;
			}
			case 'joinBackward': {
				const id = blockIdAt(baseDoc, op.path);
				if (id) touches.push({ blockId: id, scope: 'text', from: 0, to: END });
				const prev = prevBlockPath(baseDoc, op.path);
				if (prev) {
					const pid = blockIdAt(baseDoc, prev);
					if (pid) touches.push({ blockId: pid, scope: 'text', from: 0, to: END });
				}
				touches.push({ blockId: parentIdOf(baseDoc, op.path), scope: 'children' });
				break;
			}
		}
	}
	return touches;
}

/** Half-open range overlap. Zero-width points (insertions) only collide with ranges that strictly contain them. */
function rangesOverlap(aFrom: number, aTo: number, bFrom: number, bTo: number): boolean {
	if (aFrom === aTo) return bFrom < aFrom && aFrom < bTo; // a is an insertion point
	if (bFrom === bTo) return aFrom < bFrom && bFrom < aTo; // b is an insertion point
	return aFrom < bTo && bFrom < aTo;
}

function touchPairConflicts(x: RecordTouch, y: RecordTouch): boolean {
	// A structural change to a parent that removed/moved a block conflicts with
	// any edit to that block (or vice-versa).
	if (x.scope === 'children' && x.affected?.includes(y.blockId)) return true;
	if (y.scope === 'children' && y.affected?.includes(x.blockId)) return true;

	if (x.blockId !== y.blockId) return false;

	// Same target block from here on.
	if (x.scope === 'children' || y.scope === 'children') {
		// Two concurrent structural edits to the same parent conflict; a
		// structural edit and an in-place edit (text/marks/props) of the same
		// node are independent.
		return x.scope === 'children' && y.scope === 'children';
	}
	if (x.scope === 'props' || y.scope === 'props') {
		// props↔props conflict; props↔text and props↔marks are independent.
		return x.scope === 'props' && y.scope === 'props';
	}
	// text↔text, marks↔marks, and text↔marks all conflict when the ranges overlap.
	return rangesOverlap(x.from ?? 0, x.to ?? 0, y.from ?? 0, y.to ?? 0);
}

/**
 * Do two records touch overlapping regions of the document? Order-independent
 * and document-free — it only inspects the records' pre-computed `touches`.
 */
export function recordsConflict(a: LedgerRecord, b: LedgerRecord): boolean {
	if (a.id === b.id) return false;
	for (const ta of a.touches) {
		for (const tb of b.touches) {
			if (touchPairConflicts(ta, tb)) return true;
		}
	}
	return false;
}

/** Every unordered pair of records in `records` that conflict. `O(n²)` in the worst case. */
export function findConflicts(records: readonly LedgerRecord[]): Array<[LedgerRecord, LedgerRecord]> {
	const pairs: Array<[LedgerRecord, LedgerRecord]> = [];
	for (let i = 0; i < records.length; i++) {
		for (let j = i + 1; j < records.length; j++) {
			const a = records[i]!;
			const b = records[j]!;
			if (recordsConflict(a, b)) pairs.push([a, b]);
		}
	}
	return pairs;
}

// ---- Resolution strategies -------------------------------------------------

/**
 * Given two conflicting records, return the one to **keep**. Used by
 * `resolveConflicts` to break ties deterministically.
 */
export type ConflictStrategy = (a: LedgerRecord, b: LedgerRecord) => LedgerRecord;

/** Recency comparator independent of the ledger's configurable ordering: timestamp → lamport → source → id. */
function chrono(a: LedgerRecord, b: LedgerRecord): number {
	if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
	if (a.lamport !== b.lamport) return a.lamport - b.lamport;
	const as = a.source ?? '';
	const bs = b.source ?? '';
	if (as !== bs) return as < bs ? -1 : 1;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Keep the chronologically later record. */
export const lastWriteWins: ConflictStrategy = (a, b) => (chrono(a, b) >= 0 ? a : b);

/** Keep the chronologically earlier record. */
export const firstWriteWins: ConflictStrategy = (a, b) => (chrono(a, b) <= 0 ? a : b);

/**
 * Keep the record whose `source` ranks earliest in `order` (a deterministic
 * authority list, e.g. `['server', 'clientA', 'clientB']`). Sources absent from
 * the list rank last; genuine ties fall back to chronological order.
 */
export function preferSource(order: readonly string[]): ConflictStrategy {
	const rank = new Map<string, number>();
	order.forEach((s, i) => rank.set(s, i));
	const rankOf = (r: LedgerRecord) => rank.get(r.source ?? '') ?? Number.MAX_SAFE_INTEGER;
	return (a, b) => {
		const ra = rankOf(a);
		const rb = rankOf(b);
		if (ra !== rb) return ra < rb ? a : b;
		return lastWriteWins(a, b);
	};
}

export type ResolveResult = {
	/** Conflict-free subset, in chronological order. */
	kept: LedgerRecord[];
	/** Records dropped to resolve a conflict, each paired with the record it lost to. */
	dropped: Array<{ record: LedgerRecord; conflictsWith: LedgerRecord }>;
};

/**
 * Reduce a set of records to a conflict-free subset using `strategy`. Records
 * are considered in chronological order; each candidate is kept unless it
 * conflicts with an already-kept record, in which case `strategy` decides the
 * winner (a winning candidate evicts the records it beats). Greedy and
 * deterministic — the same inputs always yield the same result.
 *
 * This is the "drop one side" path. To keep *both* sides by transforming
 * positions instead, use `rebaseRecords` from `ledger-rebase.ts`.
 */
export function resolveConflicts(records: readonly LedgerRecord[], strategy: ConflictStrategy = lastWriteWins): ResolveResult {
	const ordered = [...records].sort(chrono);
	const kept: LedgerRecord[] = [];
	const dropped: Array<{ record: LedgerRecord; conflictsWith: LedgerRecord }> = [];
	for (const candidate of ordered) {
		const clashes = kept.filter((k) => recordsConflict(k, candidate));
		if (clashes.length === 0) {
			kept.push(candidate);
			continue;
		}
		const candidateLoses = clashes.find((k) => strategy(k, candidate) === k);
		if (candidateLoses) {
			dropped.push({ record: candidate, conflictsWith: candidateLoses });
			continue;
		}
		// Candidate beat every record it clashed with — evict the losers.
		for (const loser of clashes) {
			const idx = kept.indexOf(loser);
			if (idx >= 0) kept.splice(idx, 1);
			dropped.push({ record: loser, conflictsWith: candidate });
		}
		kept.push(candidate);
	}
	kept.sort(chrono);
	return { kept, dropped };
}
