// Document-side helpers for comments.
//
// A comment lives in the document as a `comment` mark whose `attrs.threadId`
// links the highlighted range to a thread in the `CommentStore`. These helpers
// translate between the editor's transaction/op surface and thread ids:
//   - apply / remove the mark for a given thread
//   - find every range carrying a given thread (needed to remove it precisely,
//     since marks dedupe by *type* — see `applyMarkToRange`)
//   - discover which threads a selection touches (to open the right popover)

import type { BlockPath, DocumentNode, MarkInstance, Selection, Transaction } from '@plim/core';
import { comparePaths, flattenBlocks } from '@plim/core';

/** The mark type used for comment highlights. */
export const COMMENT_MARK_NAME = 'comment';
/** The mark attribute that carries the thread id. */
export const COMMENT_THREAD_ATTR = 'threadId';

/** A character range within a single block. */
export type DocRange = { path: BlockPath; from: number; to: number };

function threadIdOf(mark: MarkInstance): string | null {
	if (mark.type !== COMMENT_MARK_NAME) return null;
	const id = mark.attrs?.[COMMENT_THREAD_ATTR];
	return typeof id === 'string' ? id : null;
}

function spanThreadId(marks: readonly MarkInstance[] | undefined): string | null {
	if (!marks) return null;
	for (const m of marks) {
		const id = threadIdOf(m);
		if (id) return id;
	}
	return null;
}

/**
 * Walk every block and emit one entry per contiguous run of text that carries a
 * comment mark, grouped by thread id. Runs never span blocks (each carries a
 * single `path`). Order follows document order.
 */
export function findCommentRanges(doc: DocumentNode): Array<{ threadId: string } & DocRange> {
	const out: Array<{ threadId: string } & DocRange> = [];
	for (const { block, path } of flattenBlocks(doc)) {
		const spans = block.text;
		if (!spans || !spans.length) continue;
		let offset = 0;
		let runId: string | null = null;
		let runStart = 0;
		for (const span of spans) {
			const id = spanThreadId(span.marks);
			if (id !== runId) {
				if (runId) out.push({ threadId: runId, path, from: runStart, to: offset });
				runId = id;
				runStart = offset;
			}
			offset += span.text.length;
		}
		if (runId) out.push({ threadId: runId, path, from: runStart, to: offset });
	}
	return out;
}

/** Every range carrying the given thread, in document order. */
export function commentMarkRanges(doc: DocumentNode, threadId: string): DocRange[] {
	return findCommentRanges(doc)
		.filter((r) => r.threadId === threadId)
		.map(({ path, from, to }) => ({ path, from, to }));
}

/** Distinct thread ids present anywhere in the document, in first-seen order. */
export function allCommentThreadIds(doc: DocumentNode): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const r of findCommentRanges(doc)) {
		if (!seen.has(r.threadId)) {
			seen.add(r.threadId);
			out.push(r.threadId);
		}
	}
	return out;
}

// Is block `path` within the inclusive selection range [anchorPath..headPath]?
function pathInSelectionBlocks(path: BlockPath, lo: BlockPath, hi: BlockPath): boolean {
	return comparePaths(path, lo) >= 0 && comparePaths(path, hi) <= 0;
}

/**
 * Thread ids whose highlighted range intersects the current selection. For a
 * collapsed caret this is "the thread(s) under the cursor"; for a range it is
 * every thread the range overlaps. Order follows document order.
 */
export function commentThreadIdsInSelection(doc: DocumentNode, selection: Selection): string[] {
	const a = selection.anchor;
	const h = selection.head;
	const cmp = comparePaths(a.path, h.path);
	const startPath = cmp <= 0 ? a.path : h.path;
	const endPath = cmp <= 0 ? h.path : a.path;
	const startOffset = cmp < 0 ? a.offset : cmp > 0 ? h.offset : Math.min(a.offset, h.offset);
	const endOffset = cmp < 0 ? h.offset : cmp > 0 ? a.offset : Math.max(a.offset, h.offset);
	const collapsed = comparePaths(a.path, h.path) === 0 && a.offset === h.offset;

	const seen = new Set<string>();
	const out: string[] = [];
	for (const r of findCommentRanges(doc)) {
		if (!pathInSelectionBlocks(r.path, startPath, endPath)) continue;
		const sameStart = comparePaths(r.path, startPath) === 0;
		const sameEnd = comparePaths(r.path, endPath) === 0;
		// Clamp the comparison window to the selection on the boundary blocks.
		const lo = sameStart ? startOffset : -Infinity;
		const hi = sameEnd ? endOffset : Infinity;
		const overlaps = collapsed
			? // caret: inside the run, or exactly at a boundary
			  r.path.length === startPath.length &&
			  comparePaths(r.path, startPath) === 0 &&
			  startOffset >= r.from &&
			  startOffset <= r.to
			: r.from < hi && r.to > lo;
		if (!overlaps) continue;
		if (!seen.has(r.threadId)) {
			seen.add(r.threadId);
			out.push(r.threadId);
		}
	}
	return out;
}

/** Stamp a comment mark for `threadId` across `range` on a transaction. */
export function addCommentMark(
	tx: Transaction,
	range:
		| { from: { path: BlockPath; offset: number }; to: { path: BlockPath; offset: number } }
		| { path: BlockPath; from: number; to: number },
	threadId: string,
): void {
	tx.addMark(COMMENT_MARK_NAME, range as never, { [COMMENT_THREAD_ATTR]: threadId });
}

/**
 * Remove every comment mark for `threadId` from the document. Walks the doc to
 * find each run and emits a precise `removeMark` per run (a blanket remove by
 * type would also strip other threads' highlights that happen to be adjacent).
 */
export function removeCommentMark(tx: Transaction, doc: DocumentNode, threadId: string): void {
	for (const range of commentMarkRanges(doc, threadId)) {
		tx.removeMark(COMMENT_MARK_NAME, range);
	}
}
