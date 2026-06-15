import { describe, expect, it } from 'vitest';
import { type EditorState, Transaction, newId } from '@plim/core';
import {
	type LedgerRecord,
	ROOT_ID,
	computeTouches,
	findConflicts,
	firstWriteWins,
	lastWriteWins,
	preferSource,
	recordFromTransaction,
	recordsConflict,
	resolveConflicts,
} from '@plim/ledger';

function p(text: string): { id: string; type: 'paragraph'; text: { text: string }[] } {
	return { id: newId(), type: 'paragraph', text: text ? [{ text }] : [] };
}

function makeState(...paras: string[]): EditorState {
	return {
		doc: { type: 'doc', children: paras.map(p) },
		selection: { anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } },
	};
}

function record(state: EditorState, build: (tx: Transaction) => void, opts: Parameters<typeof recordFromTransaction>[1] = {}): LedgerRecord {
	const tx = new Transaction(state);
	build(tx);
	tx.commit();
	return recordFromTransaction(tx, opts);
}

describe('computeTouches', () => {
	it('resolves a text edit to an id-keyed range', () => {
		const state = makeState('hello', 'world');
		const id0 = state.doc.children[0]!.id;
		const touches = computeTouches([{ kind: 'replaceText', path: [0], from: 1, to: 3, insert: [] }], state.doc);
		expect(touches).toEqual([{ blockId: id0, scope: 'text', from: 1, to: 3 }]);
	});

	it('records a block removal as a structural touch on the parent, naming the affected id', () => {
		const state = makeState('a', 'b');
		const id1 = state.doc.children[1]!.id;
		const touches = computeTouches([{ kind: 'removeBlock', path: [1] }], state.doc);
		expect(touches).toEqual([{ blockId: ROOT_ID, scope: 'children', affected: [id1] }]);
	});

	it('ignores selection changes', () => {
		const state = makeState('a');
		const touches = computeTouches([{ kind: 'setSelection', selection: state.selection }], state.doc);
		expect(touches).toEqual([]);
	});
});

describe('recordsConflict', () => {
	it('flags overlapping text ranges in the same block', () => {
		const state = makeState('hello world');
		const a = record(state, (tx) => tx.replaceRange([0], 0, 5, []), { id: 'a' });
		const b = record(state, (tx) => tx.replaceRange([0], 3, 8, []), { id: 'b' });
		expect(recordsConflict(a, b)).toBe(true);
	});

	it('does not flag disjoint text ranges', () => {
		const state = makeState('hello world');
		const a = record(state, (tx) => tx.replaceRange([0], 0, 5, []), { id: 'a' });
		const b = record(state, (tx) => tx.replaceRange([0], 6, 11, []), { id: 'b' });
		expect(recordsConflict(a, b)).toBe(false);
	});

	it('does not flag edits to different blocks', () => {
		const state = makeState('hello', 'world');
		const a = record(state, (tx) => tx.insertText([0], 0, 'x'), { id: 'a' });
		const b = record(state, (tx) => tx.insertText([1], 0, 'y'), { id: 'b' });
		expect(recordsConflict(a, b)).toBe(false);
	});

	it('flags a structural removal against an edit to the removed block', () => {
		const state = makeState('a', 'b');
		const remove = record(state, (tx) => tx.removeBlock([1]), { id: 'remove' });
		const edit = record(state, (tx) => tx.insertText([1], 0, 'z'), { id: 'edit' });
		expect(recordsConflict(remove, edit)).toBe(true);
	});

	it('treats a props change and a text edit on the same block as independent', () => {
		const state = makeState('hello');
		const props = record(state, (tx) => tx.setBlockType([0], 'heading'), { id: 'props' });
		const text = record(state, (tx) => tx.insertText([0], 0, 'x'), { id: 'text' });
		expect(recordsConflict(props, text)).toBe(false);
	});

	it('treats two props changes on the same block as conflicting', () => {
		const state = makeState('hello');
		const a = record(state, (tx) => tx.setBlockType([0], 'heading'), { id: 'a' });
		const b = record(state, (tx) => tx.setBlockType([0], 'quote'), { id: 'b' });
		expect(recordsConflict(a, b)).toBe(true);
	});

	it('never conflicts a record with itself', () => {
		const state = makeState('hello');
		const a = record(state, (tx) => tx.replaceRange([0], 0, 5, []), { id: 'a' });
		expect(recordsConflict(a, a)).toBe(false);
	});
});

describe('findConflicts', () => {
	it('returns every conflicting pair', () => {
		const state = makeState('hello world');
		const a = record(state, (tx) => tx.replaceRange([0], 0, 5, []), { id: 'a' });
		const b = record(state, (tx) => tx.replaceRange([0], 3, 8, []), { id: 'b' });
		const c = record(state, (tx) => tx.replaceRange([0], 9, 11, []), { id: 'c' });
		const pairs = findConflicts([a, b, c]);
		expect(pairs).toHaveLength(1);
		expect(pairs[0]!.map((r) => r.id).sort()).toEqual(['a', 'b']);
	});
});

describe('resolveConflicts', () => {
	function conflicting() {
		const state = makeState('hello world');
		const a = record(state, (tx) => tx.replaceRange([0], 0, 5, [{ text: 'A' }]), { id: 'a', timestamp: 1, source: 'A' });
		const b = record(state, (tx) => tx.replaceRange([0], 3, 8, [{ text: 'B' }]), { id: 'b', timestamp: 2, source: 'B' });
		return { a, b };
	}

	it('lastWriteWins keeps the later record', () => {
		const { a, b } = conflicting();
		const { kept, dropped } = resolveConflicts([a, b], lastWriteWins);
		expect(kept.map((r) => r.id)).toEqual(['b']);
		expect(dropped).toHaveLength(1);
		expect(dropped[0]!.record.id).toBe('a');
		expect(dropped[0]!.conflictsWith.id).toBe('b');
	});

	it('firstWriteWins keeps the earlier record', () => {
		const { a, b } = conflicting();
		const { kept } = resolveConflicts([a, b], firstWriteWins);
		expect(kept.map((r) => r.id)).toEqual(['a']);
	});

	it('preferSource honours the authority order', () => {
		const { a, b } = conflicting();
		// B ranks ahead of A, so B should win regardless of timestamps.
		const { kept } = resolveConflicts([a, b], preferSource(['B', 'A']));
		expect(kept.map((r) => r.id)).toEqual(['b']);
	});

	it('keeps independent records untouched', () => {
		const state = makeState('hello world');
		const a = record(state, (tx) => tx.replaceRange([0], 0, 5, []), { id: 'a', timestamp: 1 });
		const b = record(state, (tx) => tx.replaceRange([0], 6, 11, []), { id: 'b', timestamp: 2 });
		const { kept, dropped } = resolveConflicts([a, b]);
		expect(kept.map((r) => r.id)).toEqual(['a', 'b']);
		expect(dropped).toHaveLength(0);
	});
});
