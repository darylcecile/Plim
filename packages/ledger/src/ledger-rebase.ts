// Operational-transform position mapping for ledger records.
//
// `resolveConflicts` (in `ledger-conflict.ts`) is the "drop one side" answer to
// concurrent edits. This module is the "keep both sides" answer: given a record
// authored against some base document and a concurrent change `over` authored
// against the *same* base, `rebaseRecord` transforms the record's operations so
// they can be applied cleanly *after* `over` — the editor equivalent of
// `git rebase`.
//
// It is a deliberately small, honest subset of a full OT/CRDT position map
// (compare ProseMirror's `Mapping`, research/prosemirror/20-history-and-collab.md
// §2.4). It maps positions exactly through text edits, block insert/remove,
// and block split, and composes block moves from a remove+insert. When a
// concurrent change would genuinely make the result ambiguous (e.g. it deleted
// the very block this record edits, or a split tears a text range across two
// blocks), it refuses rather than guess: `rebaseRecord` returns
// `{ ok: false, reason }` and the caller falls back to `resolveConflicts`.
//
// All position mapping mirrors the exact semantics in `transaction.ts`'s
// `applyOp` so a rebased record applies identically to a hand-authored one.

import type { DocumentNode } from '@plim/core';
import { type BlockPath, type Selection, getBlockAt, prevBlockPath, samePath } from '@plim/core';
import { type EditorState, type TransactionOp, applyOp } from '@plim/core';
import { type RecordTouch, computeTouches } from './ledger-conflict.js';
import type { LedgerRecord } from './ledger.js';

/** Whether a boundary position is biased toward content on its left or right when an edit lands exactly on it. */
export type MapBias = 'left' | 'right';

type PathMap = { type: 'ok'; path: BlockPath } | { type: 'deleted' } | { type: 'bail'; reason: string };
type PointMap = { type: 'ok'; path: BlockPath; offset: number } | { type: 'deleted' } | { type: 'bail'; reason: string };
type OpRebase = { type: 'ok'; op: TransactionOp } | { type: 'drop' } | { type: 'bail'; reason: string };

export type RebaseResult = { ok: true; record: LedgerRecord } | { ok: false; reason: string };

// ---- low-level path/point mapping (single op, no document needed) -----------

function prefixMatches(path: BlockPath, prefix: BlockPath): boolean {
	if (path.length < prefix.length) return false;
	for (let i = 0; i < prefix.length; i++) if (path[i] !== prefix[i]) return false;
	return true;
}

/** Map a path across an insertion of a new sibling at `q` (index `q[last]`). */
function mapPathInsert(path: BlockPath, q: BlockPath): BlockPath {
	const depth = q.length - 1;
	if (prefixMatches(path, q.slice(0, depth)) && path.length > depth && path[depth]! >= q[depth]!) {
		const next = path.slice();
		next[depth] = next[depth]! + 1;
		return next;
	}
	return path;
}

/** Map a path across the removal of the block at `q`. `deleted` if `path` was at or inside `q`. */
function mapPathRemove(path: BlockPath, q: BlockPath): PathMap {
	const depth = q.length - 1;
	if (prefixMatches(path, q.slice(0, depth)) && path.length > depth) {
		const idx = path[depth]!;
		if (idx === q[depth]!) return { type: 'deleted' };
		if (idx > q[depth]!) {
			const next = path.slice();
			next[depth] = idx - 1;
			return { type: 'ok', path: next };
		}
	}
	return { type: 'ok', path };
}

/** A split at `q` inserts a new sibling right after it; shift later siblings by +1. */
function mapPathSplit(path: BlockPath, q: BlockPath): BlockPath {
	const depth = q.length - 1;
	if (prefixMatches(path, q.slice(0, depth)) && path.length > depth && path[depth]! >= q[depth]! + 1) {
		const next = path.slice();
		next[depth] = next[depth]! + 1;
		return next;
	}
	return path;
}

/** Compose a block move (remove at `from`, insert at `to`) into a single path map. */
function mapPathMove(path: BlockPath, from: BlockPath, to: BlockPath): PathMap {
	const removed = mapPathRemove(path, from);
	if (removed.type === 'deleted') return { type: 'bail', reason: 'edits a block relocated by a concurrent moveBlock' };
	if (removed.type !== 'ok') return removed;
	// `applyOp` removes `from` first, then resolves `op.to` against the post-removal
	// document and splices there literally (transaction.ts:421-427). `removed.path`
	// is likewise already in post-removal space, so `to` must be applied as-is —
	// re-mapping it through the removal would double-adjust and mislocate any
	// bystander sitting between `from` and `to` on a forward move.
	return { type: 'ok', path: mapPathInsert(removed.path, to) };
}

function mapPathThroughOp(path: BlockPath, over: TransactionOp): PathMap {
	switch (over.kind) {
		case 'insertBlock':
			return { type: 'ok', path: mapPathInsert(path, over.path) };
		case 'removeBlock':
			return mapPathRemove(path, over.path);
		case 'splitBlock':
			return { type: 'ok', path: mapPathSplit(path, over.path) };
		case 'moveBlock':
			return mapPathMove(path, over.from, over.to);
		case 'replaceText':
		case 'toggleMark':
		case 'addMark':
		case 'removeMark':
		case 'setBlockType':
		case 'setBlockAttrs':
		case 'setSelection':
			return { type: 'ok', path };
		case 'joinBackward':
			// Joins are rewritten to an equivalent removeBlock before mapping (see
			// effectiveOverOps); reaching here means we lack the base doc to do so.
			return { type: 'bail', reason: 'cannot map through joinBackward without a base document' };
	}
}

function mapPointThroughOp(path: BlockPath, offset: number, over: TransactionOp, bias: MapBias): PointMap {
	switch (over.kind) {
		case 'replaceText': {
			if (!samePath(path, over.path)) return { type: 'ok', path, offset };
			// Mirror applyOp's own selection adjustment (transaction.ts:297-302).
			const insertedLen = over.insert.reduce((n, s) => n + s.text.length, 0);
			const delta = insertedLen - (over.to - over.from);
			if (offset > over.to) return { type: 'ok', path, offset: offset + delta };
			if (offset > over.from) return { type: 'ok', path, offset: over.from + insertedLen };
			return { type: 'ok', path, offset };
		}
		case 'splitBlock': {
			if (samePath(path, over.path)) {
				const moves = bias === 'right' ? offset >= over.offset : offset > over.offset;
				if (moves) {
					const rightPath: BlockPath = [...over.path.slice(0, -1), over.path[over.path.length - 1]! + 1];
					return { type: 'ok', path: rightPath, offset: offset - over.offset };
				}
				return { type: 'ok', path, offset };
			}
			return { type: 'ok', path: mapPathSplit(path, over.path), offset };
		}
		case 'insertBlock':
			return { type: 'ok', path: mapPathInsert(path, over.path), offset };
		case 'removeBlock': {
			const mapped = mapPathRemove(path, over.path);
			return mapped.type === 'ok' ? { type: 'ok', path: mapped.path, offset } : mapped;
		}
		case 'moveBlock': {
			const mapped = mapPathMove(path, over.from, over.to);
			return mapped.type === 'ok' ? { type: 'ok', path: mapped.path, offset } : mapped;
		}
		case 'toggleMark':
		case 'addMark':
		case 'removeMark':
		case 'setBlockType':
		case 'setBlockAttrs':
		case 'setSelection':
			return { type: 'ok', path, offset };
		case 'joinBackward':
			return { type: 'bail', reason: 'cannot map through joinBackward without a base document' };
	}
}

/**
 * Map a block path through a single concurrent op. Returns the transformed path,
 * or `null` if the block was deleted or the transform is unsupported (e.g.
 * `joinBackward`, which needs the base document — use `rebaseRecord` for that).
 */
export function rebaseBlockPath(path: BlockPath, over: TransactionOp): BlockPath | null {
	const r = mapPathThroughOp(path, over);
	return r.type === 'ok' ? r.path : null;
}

/**
 * Map a `(block path, text offset)` point through a single concurrent op.
 * Returns the transformed point, or `null` if its block was deleted or the
 * transform is unsupported. `bias` decides which side a point biases toward when
 * an edit lands exactly on it (default `'right'`).
 */
export function rebaseTextPoint(path: BlockPath, offset: number, over: TransactionOp, bias: MapBias = 'right'): { path: BlockPath; offset: number } | null {
	const r = mapPointThroughOp(path, offset, over, bias);
	return r.type === 'ok' ? { path: r.path, offset: r.offset } : null;
}

// ---- threading a position through a sequence of concurrent ops --------------

function threadPath(path: BlockPath, overOps: readonly TransactionOp[]): PathMap {
	let cur = path;
	for (const o of overOps) {
		const r = mapPathThroughOp(cur, o);
		if (r.type !== 'ok') return r;
		cur = r.path;
	}
	return { type: 'ok', path: cur };
}

function threadPoint(path: BlockPath, offset: number, overOps: readonly TransactionOp[], bias: MapBias): PointMap {
	let curPath = path;
	let curOffset = offset;
	for (const o of overOps) {
		const r = mapPointThroughOp(curPath, curOffset, o, bias);
		if (r.type !== 'ok') return r;
		curPath = r.path;
		curOffset = r.offset;
	}
	return { type: 'ok', path: curPath, offset: curOffset };
}

// ---- record-level rebase ----------------------------------------------------

const TRIVIAL_SELECTION: Selection = { anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } };

/** Fold a list of ops onto a document. `applyOp` ignores selection for doc mutation, so a trivial one is safe. */
function applyOpsToDoc(doc: DocumentNode, ops: readonly TransactionOp[]): DocumentNode {
	let state: EditorState = { doc, selection: TRIVIAL_SELECTION };
	for (const op of ops) state = applyOp(state, op);
	return state.doc;
}

/**
 * Rewrite the concurrent ops into an equivalent sequence for *position mapping*,
 * replacing each `joinBackward` with the `removeBlock` it is structurally
 * equivalent to (removing the joined-away block — the empty divider when the
 * previous block is non-text, otherwise the current block). Indices are resolved
 * against the document as it evolves, so each emitted op lives in the same space
 * as the real op it stands in for. Touch recomputation still uses the real ops.
 */
function effectiveOverOps(overOps: readonly TransactionOp[], baseDoc: DocumentNode): TransactionOp[] {
	const out: TransactionOp[] = [];
	let doc = baseDoc;
	for (const op of overOps) {
		if (op.kind === 'joinBackward') {
			const prevPath = prevBlockPath(doc, op.path);
			if (prevPath) {
				const prevBlock = getBlockAt(doc, prevPath);
				const removalPath = prevBlock && prevBlock.text === undefined ? prevPath : op.path;
				out.push({ kind: 'removeBlock', path: removalPath });
			}
		} else {
			out.push(op);
		}
		doc = applyOpsToDoc(doc, [op]);
	}
	return out;
}

// Thread a mark op's `[from, to)` range through the concurrent ops. Shared by
// toggleMark/addMark/removeMark: `from` biases right and `to` biases left (so the
// marked span shrinks to stay within surviving text), the `-1` "to end of block"
// sentinel is preserved, and the op bails if its text was deleted or split across
// blocks. `label` only shapes the bail message so each op reads naturally.
function rebaseMarkRange(
	label: string,
	op: { path: BlockPath; from: number; to: number },
	overOps: readonly TransactionOp[],
): { type: 'ok'; path: BlockPath; from: number; to: number } | { type: 'bail'; reason: string } {
	const from = threadPoint(op.path, op.from, overOps, 'right');
	if (from.type === 'deleted') return { type: 'bail', reason: `${label} targets text removed by the concurrent change` };
	if (from.type !== 'ok') return { type: 'bail', reason: from.reason };
	if (op.to === -1) return { type: 'ok', path: from.path, from: from.offset, to: -1 };
	const to = threadPoint(op.path, op.to, overOps, 'left');
	if (to.type === 'deleted') return { type: 'bail', reason: `${label} targets text removed by the concurrent change` };
	if (to.type !== 'ok') return { type: 'bail', reason: to.reason };
	if (!samePath(from.path, to.path)) return { type: 'bail', reason: `${label} range was split across blocks by a concurrent split` };
	return { type: 'ok', path: from.path, from: from.offset, to: to.offset };
}

function rebaseOp(op: TransactionOp, overOps: readonly TransactionOp[]): OpRebase {
	switch (op.kind) {
		case 'setSelection': {
			const anchor = threadPoint(op.selection.anchor.path, op.selection.anchor.offset, overOps, 'right');
			const head = threadPoint(op.selection.head.path, op.selection.head.offset, overOps, 'right');
			if (anchor.type !== 'ok' || head.type !== 'ok') return { type: 'drop' }; // selection is cosmetic
			return {
				type: 'ok',
				op: { kind: 'setSelection', selection: { anchor: { path: anchor.path, offset: anchor.offset }, head: { path: head.path, offset: head.offset } } },
			};
		}
		case 'replaceText': {
			const from = threadPoint(op.path, op.from, overOps, 'right');
			const to = threadPoint(op.path, op.to, overOps, 'left');
			if (from.type === 'deleted' || to.type === 'deleted') return { type: 'bail', reason: 'replaceText targets text removed by the concurrent change' };
			if (from.type !== 'ok' || to.type !== 'ok') return { type: 'bail', reason: from.type === 'bail' ? from.reason : (to as { reason: string }).reason };
			if (!samePath(from.path, to.path)) return { type: 'bail', reason: 'replaceText range was split across blocks by a concurrent split' };
			return { type: 'ok', op: { kind: 'replaceText', path: from.path, from: from.offset, to: to.offset, insert: op.insert } };
		}
		case 'toggleMark': {
			const r = rebaseMarkRange('toggleMark', op, overOps);
			if (r.type !== 'ok') return r;
			return { type: 'ok', op: { kind: 'toggleMark', path: r.path, from: r.from, to: r.to, mark: op.mark } };
		}
		case 'addMark': {
			const r = rebaseMarkRange('addMark', op, overOps);
			if (r.type !== 'ok') return r;
			return { type: 'ok', op: { kind: 'addMark', path: r.path, from: r.from, to: r.to, mark: op.mark } };
		}
		case 'removeMark': {
			const r = rebaseMarkRange('removeMark', op, overOps);
			if (r.type !== 'ok') return r;
			return { type: 'ok', op: { kind: 'removeMark', path: r.path, from: r.from, to: r.to, mark: op.mark } };
		}
		case 'splitBlock': {
			const at = threadPoint(op.path, op.offset, overOps, 'right');
			if (at.type === 'deleted') return { type: 'bail', reason: 'splitBlock targets a block removed by the concurrent change' };
			if (at.type !== 'ok') return { type: 'bail', reason: at.reason };
			return {
				type: 'ok',
				op: {
					kind: 'splitBlock',
					path: at.path,
					offset: at.offset,
					...(op.newType !== undefined ? { newType: op.newType } : {}),
					...(op.newAttrs !== undefined ? { newAttrs: op.newAttrs } : {}),
				},
			};
		}
		case 'joinBackward': {
			const mapped = threadPath(op.path, overOps);
			if (mapped.type === 'deleted') return { type: 'bail', reason: 'joinBackward targets a block removed by the concurrent change' };
			if (mapped.type !== 'ok') return { type: 'bail', reason: mapped.reason };
			return { type: 'ok', op: { kind: 'joinBackward', path: mapped.path } };
		}
		case 'setBlockType': {
			const mapped = threadPath(op.path, overOps);
			if (mapped.type === 'deleted') return { type: 'bail', reason: 'setBlockType targets a block removed by the concurrent change' };
			if (mapped.type !== 'ok') return { type: 'bail', reason: mapped.reason };
			return { type: 'ok', op: { kind: 'setBlockType', path: mapped.path, type: op.type, ...(op.attrs !== undefined ? { attrs: op.attrs } : {}) } };
		}
		case 'setBlockAttrs': {
			const mapped = threadPath(op.path, overOps);
			if (mapped.type === 'deleted') return { type: 'bail', reason: 'setBlockAttrs targets a block removed by the concurrent change' };
			if (mapped.type !== 'ok') return { type: 'bail', reason: mapped.reason };
			return { type: 'ok', op: { kind: 'setBlockAttrs', path: mapped.path, attrs: op.attrs } };
		}
		case 'insertBlock': {
			const mapped = threadPath(op.path, overOps);
			if (mapped.type === 'deleted') return { type: 'bail', reason: 'insertBlock targets a parent removed by the concurrent change' };
			if (mapped.type !== 'ok') return { type: 'bail', reason: mapped.reason };
			return { type: 'ok', op: { kind: 'insertBlock', path: mapped.path, block: op.block } };
		}
		case 'removeBlock': {
			const mapped = threadPath(op.path, overOps);
			if (mapped.type === 'deleted') return { type: 'drop' }; // already removed by the concurrent change
			if (mapped.type !== 'ok') return { type: 'bail', reason: mapped.reason };
			return { type: 'ok', op: { kind: 'removeBlock', path: mapped.path } };
		}
		case 'moveBlock': {
			const from = threadPath(op.from, overOps);
			if (from.type === 'deleted') return { type: 'bail', reason: 'moveBlock source was removed by the concurrent change' };
			if (from.type !== 'ok') return { type: 'bail', reason: from.reason };
			const to = threadPath(op.to, overOps);
			if (to.type === 'deleted') return { type: 'bail', reason: 'moveBlock target was removed by the concurrent change' };
			if (to.type !== 'ok') return { type: 'bail', reason: to.reason };
			return { type: 'ok', op: { kind: 'moveBlock', from: from.path, to: to.path } };
		}
	}
}

function normalizeOver(over: LedgerRecord | LedgerRecord[] | TransactionOp[]): TransactionOp[] {
	if (!Array.isArray(over)) return [...over.ops];
	if (over.length === 0) return [];
	const first = over[0]!;
	if ('ops' in first) return (over as LedgerRecord[]).flatMap((r) => r.ops);
	return [...(over as TransactionOp[])];
}

/**
 * Rebase a record so it applies after `over`, where both were authored against
 * `baseDoc`. `over` may be a single record, a list of records, or a raw op list
 * (applied in the given order). The returned record keeps the same `id` and
 * timestamps — it is the same logical change, repositioned — with its `ops` and
 * `touches` transformed into the post-`over` document space.
 *
 * Returns `{ ok: false, reason }` when the rebase is ambiguous (the concurrent
 * change deleted/relocated content this record depends on, or a split tore one
 * of its ranges across blocks). Callers should then fall back to
 * `resolveConflicts`.
 */
export function rebaseRecord(record: LedgerRecord, over: LedgerRecord | LedgerRecord[] | TransactionOp[], baseDoc: DocumentNode): RebaseResult {
	const overOps = normalizeOver(over);
	if (overOps.length === 0) return { ok: true, record };
	const eff = effectiveOverOps(overOps, baseDoc);
	const rebasedOps: TransactionOp[] = [];
	for (const op of record.ops) {
		const r = rebaseOp(op, eff);
		if (r.type === 'bail') return { ok: false, reason: r.reason };
		if (r.type === 'drop') continue;
		rebasedOps.push(r.op);
	}
	const docAfter = applyOpsToDoc(baseDoc, overOps);
	const touches: RecordTouch[] = computeTouches(rebasedOps, docAfter);
	return { ok: true, record: { ...record, ops: rebasedOps, touches } };
}

export type RebaseManyResult = {
	/** Successfully rebased records, in the same order they were given. */
	rebased: LedgerRecord[];
	/** Records that could not be rebased, each with the reason, in input order. */
	failed: Array<{ record: LedgerRecord; reason: string }>;
};

/**
 * Rebase many records onto the same concurrent change. Assumes the records are
 * concurrent with `over` and mutually independent (the common case: a batch of
 * remote edits transformed past your local unshared ops). Records that cannot be
 * rebased are collected in `failed` rather than aborting the batch.
 */
export function rebaseRecords(records: readonly LedgerRecord[], over: LedgerRecord | LedgerRecord[] | TransactionOp[], baseDoc: DocumentNode): RebaseManyResult {
	const rebased: LedgerRecord[] = [];
	const failed: Array<{ record: LedgerRecord; reason: string }> = [];
	for (const record of records) {
		const result = rebaseRecord(record, over, baseDoc);
		if (result.ok) rebased.push(result.record);
		else failed.push({ record, reason: result.reason });
	}
	return { rebased, failed };
}
