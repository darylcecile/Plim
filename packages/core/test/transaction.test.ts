import { describe, expect, it } from 'vitest';
import {
	type EditorState,
	Transaction,
	applyTransaction,
	blockPlainText,
	newId,
} from '@plim/core';

function p(text: string): { id: string; type: 'paragraph'; text: { text: string }[] } {
	return { id: newId(), type: 'paragraph', text: text ? [{ text }] : [] };
}

function makeState(...paras: string[]): EditorState {
	return {
		doc: { type: 'doc', children: paras.map(p) },
		selection: {
			anchor: { path: [0], offset: 0 },
			head: { path: [0], offset: 0 },
		},
	};
}

describe('Transaction', () => {
	it('insertText appends to a block', () => {
		const state = makeState('hello');
		const tx = new Transaction(state);
		tx.insertText([0], 5, ' world');
		const next = applyTransaction(state, tx);
		expect(blockPlainText(next.doc.children[0]!)).toBe('hello world');
	});

	it('replaceRange removes characters', () => {
		const state = makeState('hello world');
		const tx = new Transaction(state);
		tx.replaceRange([0], 5, 11, []);
		const next = applyTransaction(state, tx);
		expect(blockPlainText(next.doc.children[0]!)).toBe('hello');
	});

	it('splitBlock divides a block at offset', () => {
		const state = makeState('hello world');
		const tx = new Transaction(state);
		tx.splitBlock([0], 5);
		const next = applyTransaction(state, tx);
		expect(next.doc.children).toHaveLength(2);
		expect(blockPlainText(next.doc.children[0]!)).toBe('hello');
		expect(blockPlainText(next.doc.children[1]!)).toBe(' world');
	});

	it('joinBackward merges with the previous block', () => {
		const state = makeState('hello', 'world');
		const tx = new Transaction(state);
		tx.joinBackward([1]);
		const next = applyTransaction(state, tx);
		expect(next.doc.children).toHaveLength(1);
		expect(blockPlainText(next.doc.children[0]!)).toBe('helloworld');
	});

	it('setBlockType changes the block type', () => {
		const state = makeState('hello');
		const tx = new Transaction(state);
		tx.setBlockType([0], 'heading', { level: 1 });
		const next = applyTransaction(state, tx);
		expect(next.doc.children[0]!.type).toBe('heading');
		expect(next.doc.children[0]!.attrs?.level).toBe(1);
	});

	it('insertBlock places a new block at the given path', () => {
		const state = makeState('first', 'third');
		const tx = new Transaction(state);
		tx.insertBlock([1], { id: 'mid', type: 'paragraph', text: [{ text: 'second' }] });
		const next = applyTransaction(state, tx);
		expect(next.doc.children.map(blockPlainText)).toEqual(['first', 'second', 'third']);
	});

	it('removeBlock removes a block', () => {
		const state = makeState('a', 'b', 'c');
		const tx = new Transaction(state);
		tx.removeBlock([1]);
		const next = applyTransaction(state, tx);
		expect(next.doc.children.map(blockPlainText)).toEqual(['a', 'c']);
	});

	it('moveBlock relocates a block (destination index is after-removal)', () => {
		const state = makeState('a', 'b', 'c');
		const tx = new Transaction(state);
		tx.moveBlock([0], [2]);
		const next = applyTransaction(state, tx);
		// 'a' removed → ['b','c']; insert at index 2 → ['b','c','a']
		expect(next.doc.children.map(blockPlainText)).toEqual(['b', 'c', 'a']);
	});

	it('toggleMark applies a mark to a range', () => {
		const state = makeState('hello world');
		const tx = new Transaction(state);
		tx.toggleMark('bold', { path: [0], from: 0, to: 5 });
		const next = applyTransaction(state, tx);
		const spans = next.doc.children[0]!.text!;
		const bolded = spans.find((s) => s.marks?.some((m) => m.type === 'bold'));
		expect(bolded?.text).toBe('hello');
	});

	it('toggleMark twice removes the mark', () => {
		const state = makeState('hello');
		const t1 = new Transaction(state);
		t1.toggleMark('bold', { path: [0], from: 0, to: 5 });
		const mid = applyTransaction(state, t1);
		const t2 = new Transaction(mid);
		t2.toggleMark('bold', { path: [0], from: 0, to: 5 });
		const next = applyTransaction(mid, t2);
		expect(next.doc.children[0]!.text!.some((s) => s.marks?.length)).toBe(false);
	});

	it('toggleMark normalizes a backward range (path-form)', () => {
		const state = makeState('hello world');
		const tx = new Transaction(state);
		// from > to (e.g. selection made backward by Option+Shift+Left)
		tx.toggleMark('bold', { path: [0], from: 5, to: 0 });
		const next = applyTransaction(state, tx);
		const bolded = next.doc.children[0]!.text!.find((s) => s.marks?.some((m) => m.type === 'bold'));
		expect(bolded?.text).toBe('hello');
	});

	it('toggleMark normalizes a backward range (selection-form)', () => {
		const state = makeState('hello world');
		const tx = new Transaction(state);
		// anchor right of head — same shape as Selection.{anchor, head} when shift-selecting backward
		tx.toggleMark('bold', {
			from: { path: [0], offset: 5 },
			to: { path: [0], offset: 0 },
		});
		const next = applyTransaction(state, tx);
		const bolded = next.doc.children[0]!.text!.find((s) => s.marks?.some((m) => m.type === 'bold'));
		expect(bolded?.text).toBe('hello');
	});
});

describe('addMark / removeMark', () => {
	it('addMark applies a mark with attrs to a range', () => {
		const state = makeState('hello world');
		const tx = new Transaction(state);
		tx.addMark('comment', { path: [0], from: 0, to: 5 }, { threadId: 't1' });
		const next = applyTransaction(state, tx);
		const span = next.doc.children[0]!.text!.find((s) => s.marks?.some((m) => m.type === 'comment'));
		expect(span?.text).toBe('hello');
		expect(span?.marks?.find((m) => m.type === 'comment')?.attrs).toEqual({ threadId: 't1' });
	});

	it('addMark applied twice keeps the mark (does not toggle off)', () => {
		const state = makeState('hello');
		const t1 = new Transaction(state);
		t1.addMark('comment', { path: [0], from: 0, to: 5 }, { threadId: 't1' });
		const mid = applyTransaction(state, t1);
		const t2 = new Transaction(mid);
		t2.addMark('comment', { path: [0], from: 0, to: 5 }, { threadId: 't1' });
		const next = applyTransaction(mid, t2);
		const span = next.doc.children[0]!.text!.find((s) => s.marks?.some((m) => m.type === 'comment'));
		expect(span?.text).toBe('hello');
	});

	it('a later addMark with different attrs reassigns the overlap', () => {
		const state = makeState('hello');
		const t1 = new Transaction(state);
		t1.addMark('comment', { path: [0], from: 0, to: 5 }, { threadId: 't1' });
		const mid = applyTransaction(state, t1);
		const t2 = new Transaction(mid);
		t2.addMark('comment', { path: [0], from: 0, to: 5 }, { threadId: 't2' });
		const next = applyTransaction(mid, t2);
		const span = next.doc.children[0]!.text!.find((s) => s.marks?.some((m) => m.type === 'comment'));
		expect(span?.marks?.find((m) => m.type === 'comment')?.attrs).toEqual({ threadId: 't2' });
	});

	it('removeMark removes the mark of a type over a range', () => {
		const state = makeState('hello world');
		const t1 = new Transaction(state);
		t1.addMark('comment', { path: [0], from: 0, to: 11 }, { threadId: 't1' });
		const mid = applyTransaction(state, t1);
		const t2 = new Transaction(mid);
		t2.removeMark('comment', { path: [0], from: 0, to: 5 });
		const next = applyTransaction(mid, t2);
		const text = next.doc.children[0]!.text!;
		// "hello" cleared, " world" still commented
		const stillMarked = text.filter((s) => s.marks?.some((m) => m.type === 'comment')).map((s) => s.text).join('');
		expect(stillMarked).toBe(' world');
	});

	it('removeMark leaves other mark types intact', () => {
		const state = makeState('hello');
		const t1 = new Transaction(state);
		t1.addMark('comment', { path: [0], from: 0, to: 5 }, { threadId: 't1' });
		t1.toggleMark('bold', { path: [0], from: 0, to: 5 });
		const mid = applyTransaction(state, t1);
		const t2 = new Transaction(mid);
		t2.removeMark('comment', { path: [0], from: 0, to: 5 });
		const next = applyTransaction(mid, t2);
		const span = next.doc.children[0]!.text![0]!;
		expect(span.marks?.some((m) => m.type === 'comment')).toBe(false);
		expect(span.marks?.some((m) => m.type === 'bold')).toBe(true);
	});

	it('addMark spans across blocks (selection-form)', () => {
		const state = makeState('hello', 'world');
		const tx = new Transaction(state);
		tx.addMark('comment', { from: { path: [0], offset: 2 }, to: { path: [1], offset: 3 } }, { threadId: 't1' });
		const next = applyTransaction(state, tx);
		const first = next.doc.children[0]!.text!.filter((s) => s.marks?.some((m) => m.type === 'comment')).map((s) => s.text).join('');
		const second = next.doc.children[1]!.text!.filter((s) => s.marks?.some((m) => m.type === 'comment')).map((s) => s.text).join('');
		expect(first).toBe('llo');
		expect(second).toBe('wor');
	});
});

describe('Structural sharing across transactions', () => {
	// `withDocChange` deep-clones the doc, mutates, then re-aliases
	// any subtree whose shape matches the previous version. This
	// preserves reference equality for blocks the tx didn't touch,
	// which the view layer uses to skip per-block render work.

	it('preserves references for untouched siblings on a single-block edit', () => {
		const state = makeState('one', 'two', 'three');
		const tx = new Transaction(state);
		tx.insertText([1], 3, '!');
		const next = applyTransaction(state, tx);
		// Block at index 0 and 2 weren't mutated — their shape is
		// identical, so the re-alias pass should restore the original
		// references.
		expect(next.doc.children[0]).toBe(state.doc.children[0]);
		expect(next.doc.children[2]).toBe(state.doc.children[2]);
		// The mutated block must NOT be the previous reference.
		expect(next.doc.children[1]).not.toBe(state.doc.children[1]);
	});

	it('preserves nested untouched subtrees', () => {
		const state: EditorState = {
			doc: {
				type: 'doc',
				children: [
					{
						id: 'parent',
						type: 'paragraph',
						text: [{ text: 'p' }],
						children: [p('child-a'), p('child-b')],
					},
					p('sibling'),
				],
			},
			selection: { anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } },
		};
		const tx = new Transaction(state);
		// Edit child-a (path [0,0]).
		tx.insertText([0, 0], 7, '!');
		const next = applyTransaction(state, tx);
		// Sibling at root level untouched — same reference.
		expect(next.doc.children[1]).toBe(state.doc.children[1]);
		// child-b untouched even though parent changed.
		const prevParent = state.doc.children[0]!;
		const nextParent = next.doc.children[0]!;
		expect(nextParent).not.toBe(prevParent);
		expect(nextParent.children![1]).toBe(prevParent.children![1]);
		// The actually-edited block has a new reference.
		expect(nextParent.children![0]).not.toBe(prevParent.children![0]);
	});

	it('does not reuse references when a sibling was added (positions changed)', () => {
		const state = makeState('a', 'c');
		const tx = new Transaction(state);
		tx.insertBlock([1], { id: 'mid', type: 'paragraph', text: [{ text: 'b' }] });
		const next = applyTransaction(state, tx);
		// Inserted at index 1 — original index-1 block ('c') shifted
		// to index 2. Index-0 still 'a' and unchanged → reused.
		expect(next.doc.children).toHaveLength(3);
		expect(next.doc.children[0]).toBe(state.doc.children[0]);
		// Index-2 'c' has the same id/shape as previous index-1, but
		// the re-alias pass keys on positional id-equality so it sees
		// a different id at index 2 (was different in prev) and keeps
		// the cloned reference. The important contract is correctness
		// of the doc shape — verify by id and content rather than
		// reference here.
		expect(next.doc.children[2]!.id).toBe(state.doc.children[1]!.id);
		expect(blockPlainText(next.doc.children[2]!)).toBe('c');
	});
});

describe('marksAtOffset', () => {
	it('returns the marks of the run when offset is strictly inside it', async () => {
		const { marksAtOffset } = await import('@plim/core');
		// "hello world" — single span, all `code`
		const spans = [{ text: 'hello world', marks: [{ type: 'code' }] }];
		// Cursor before "world" → offset 6, strictly inside the span
		expect(marksAtOffset(spans, 6).map((m) => m.type)).toEqual(['code']);
	});

	it('returns no marks at the very start or very end of the block', async () => {
		const { marksAtOffset } = await import('@plim/core');
		const spans = [{ text: 'hello', marks: [{ type: 'code' }] }];
		expect(marksAtOffset(spans, 0)).toEqual([]);
		expect(marksAtOffset(spans, 5)).toEqual([]);
	});

	it('intersects adjacent runs at an internal boundary', async () => {
		const { marksAtOffset } = await import('@plim/core');
		// "hello" (bold+code) + "world" (bold) → boundary at offset 5
		const spans = [
			{ text: 'hello', marks: [{ type: 'bold' }, { type: 'code' }] },
			{ text: 'world', marks: [{ type: 'bold' }] },
		];
		const got = marksAtOffset(spans, 5).map((m) => m.type).sort();
		expect(got).toEqual(['bold']);
	});

	it('returns empty at boundary when neighbors share no marks', async () => {
		const { marksAtOffset } = await import('@plim/core');
		// "hello" (code) + "world" (no marks)
		const spans = [
			{ text: 'hello', marks: [{ type: 'code' }] },
			{ text: 'world' },
		];
		expect(marksAtOffset(spans, 5)).toEqual([]);
	});
});
