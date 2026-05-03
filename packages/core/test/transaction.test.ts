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
