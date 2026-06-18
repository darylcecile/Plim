import { describe, expect, it } from 'vitest';
import { Snapshot, Transaction } from '@plim/core';
import type { EditorState } from '@plim/core';
import { apply, applyTx, createTestEditor, doc, paragraph, plainText } from '@plim/test-utils';

describe('test editor', () => {
	it('creates an editor with default content and registered builtin descriptors', () => {
		const editor = createTestEditor();

		expect(editor.getState().doc.children[0]!.type).toBe('paragraph');
		expect(editor.blocks.some((block) => block.name === 'paragraph')).toBe(true);
		expect(editor.marks.some((mark) => mark.name === 'bold')).toBe(true);
		expect(editor.supportsDecoration('divider')).toBe(false);
	});

	it('accepts document, block array, and selection options', () => {
		const fromDoc = createTestEditor({ content: doc(paragraph('a')) });
		const fromBlocks = createTestEditor({ content: [paragraph('b')], selection: { anchor: { path: [0], offset: 1 }, head: { path: [0], offset: 1 } } });

		expect(plainText(fromDoc.getState())).toBe('a');
		expect(plainText(fromBlocks.getState())).toBe('b');
		expect(fromBlocks.getState().selection.head.offset).toBe(1);
	});

	it('fires onTransaction for committed created transactions but not setState', () => {
		const editor = createTestEditor({ content: doc(paragraph('abc')) });
		const seen: string[] = [];
		editor.onTransaction((tx, state) => seen.push(`${tx.ops.length}:${plainText(state)}`));

		editor.setState({ doc: doc(paragraph('reset')), selection: editor.getState().selection });
		expect(seen).toEqual([]);

		const tx = editor.createTransaction();
		tx.insertText([0], 5, '!');
		tx.commit();

		expect(seen).toEqual(['1:reset!']);
		expect(plainText(editor.getState())).toBe('reset!');
	});

	it('fires onTransaction for explicit dispatch and supports unsubscribe', () => {
		const editor = createTestEditor({ content: doc(paragraph('a')) });
		let count = 0;
		const off = editor.onTransaction(() => count++);

		const tx = new Transaction(editor.getState());
		tx.insertText([0], 1, 'b');
		editor.dispatch(tx);
		off();
		editor.dispatch(new Transaction(editor.getState()).insertText([0], 2, 'c'));

		expect(count).toBe(1);
		expect(plainText(editor.getState())).toBe('abc');
	});

	it('applyTx commits, applies, fires listeners, and returns next state', () => {
		const editor = createTestEditor({ content: doc(paragraph('a')) });
		let fired = 0;
		editor.onTransaction(() => fired++);

		const next = applyTx(editor, (tx) => tx.insertText([0], 1, 'b'));

		expect(next).toBe(editor.getState());
		expect(plainText(next)).toBe('ab');
		expect(fired).toBe(1);
	});

	it('apply is pure and does not mutate the input state', () => {
		const state: EditorState = { doc: doc(paragraph('a')), selection: { anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } } };
		const next = apply(state, (tx) => tx.insertText([0], 1, 'b'));

		expect(plainText(state)).toBe('a');
		expect(plainText(next)).toBe('ab');
	});

	it('restoreSnapshot round-trips a serialized Snapshot without firing transactions', () => {
		const editor = createTestEditor({ content: doc(paragraph('start')) });
		const snapshot = new Snapshot(editor).serialize();
		let fired = 0;
		editor.onTransaction(() => fired++);

		applyTx(editor, (tx) => tx.insertText([0], 5, '!'));
		editor.restoreSnapshot(Snapshot.deserialize(snapshot));

		expect(plainText(editor.getState())).toBe('start');
		expect(fired).toBe(1);
	});

	it('supports async event handlers and ready callbacks', async () => {
		const editor = createTestEditor();
		let ready = false;
		editor.whenReady(() => {
			ready = true;
		});
		editor.onAsyncEvent('lookup', (_event, state) => plainText(state));

		await expect(editor.triggerAsyncEvent('lookup')).resolves.toBe('');
		expect(ready).toBe(true);
	});
});
