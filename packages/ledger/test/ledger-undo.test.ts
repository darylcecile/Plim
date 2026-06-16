import { describe, expect, it } from 'vitest';
import {
	type DocumentNode,
	type EditorHandle,
	type EditorState,
	PlimDriver,
	blockPlainText,
} from '@plim/core';
import { attachContainer, deriveEditor, type AgnosticEditor } from '@plim/editor';
import { TransactionLedger } from '@plim/ledger';

// A stable base document so a replayed doc can deep-equal the live one (ids match).
function makeDoc(): DocumentNode {
	return { type: 'doc', children: [{ id: 'b0', type: 'paragraph', text: [] }] };
}

/**
 * A real `@plim/editor` driven headlessly. The container resolves to `null`
 * (no DOM in the node test env); `destroy()` flips the `destroyed` flag so the
 * self-rescheduling `mount()` retry loop stops on its next tick. `dispatch`,
 * `undo`, and `redo` all work without a mounted view.
 */
function headless(initial: DocumentNode): { editor: AgnosticEditor; plim: PlimDriver } {
	const plim = new PlimDriver({ registeredBlocks: [], registeredMarks: [] });
	const editor = deriveEditor(plim, {
		containerAdapter: attachContainer(() => null),
		initialContent: initial,
		autoFocus: false,
	});
	editor.destroy();
	return { editor, plim };
}

/** Type `text` at `offset` in the first block via the normal dispatch path. */
function type(editor: AgnosticEditor, offset: number, text: string): void {
	const tx = editor.createTransaction();
	tx.insertText([0], offset, text);
	const caret = offset + text.length;
	tx.setMeta('nextSelection', { anchor: { path: [0], offset: caret }, head: { path: [0], offset: caret } });
	tx.commit();
}

/** A minimal replay target seeded with the same base document. */
function replayTarget(initial: DocumentNode): EditorHandle {
	let state: EditorState = {
		doc: structuredClone(initial),
		selection: { anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } },
	};
	return {
		getState: () => state,
		setState: (next: EditorState) => {
			state = next;
		},
		onTransaction: () => () => {},
	} as unknown as EditorHandle;
}

describe('TransactionLedger — undo/redo flow through dispatch and are recorded', () => {
	it('A, B, undo, C → live doc is "AC" and replay reproduces it (not "ACB")', () => {
		const initial = makeDoc();
		const { editor, plim } = headless(initial);
		const ledger = new TransactionLedger();
		ledger.attach(editor);

		type(editor, 0, 'A');
		type(editor, 1, 'B');
		plim.getHistory().undo();
		type(editor, 1, 'C');

		// The live source document is "AC".
		expect(blockPlainText(editor.getState().doc.children[0]!)).toBe('AC');

		// The undo was recorded as a real transaction — four records, not three.
		expect(ledger.length).toBe(4);
		expect(ledger.records.some((r) => r.meta?.history === 'undo')).toBe(true);

		// Replaying the ledger onto a fresh editor reproduces the live doc exactly.
		const fresh = replayTarget(initial);
		ledger.replay(fresh);
		expect(blockPlainText(fresh.getState().doc.children[0]!)).toBe('AC');
		expect(fresh.getState().doc).toEqual(editor.getState().doc);
	});

	it('A, B, undo, redo → live doc is "AB" and replay reproduces it', () => {
		const initial = makeDoc();
		const { editor, plim } = headless(initial);
		const ledger = new TransactionLedger();
		ledger.attach(editor);

		type(editor, 0, 'A');
		type(editor, 1, 'B');
		plim.getHistory().undo();
		plim.getHistory().redo();

		expect(blockPlainText(editor.getState().doc.children[0]!)).toBe('AB');

		// undo + redo both recorded on top of the two edits.
		expect(ledger.length).toBe(4);
		expect(ledger.records.some((r) => r.meta?.history === 'undo')).toBe(true);
		expect(ledger.records.some((r) => r.meta?.history === 'redo')).toBe(true);

		const fresh = replayTarget(initial);
		ledger.replay(fresh);
		expect(blockPlainText(fresh.getState().doc.children[0]!)).toBe('AB');
		expect(fresh.getState().doc).toEqual(editor.getState().doc);
	});

	it('multiple undos replay faithfully (A, B, C, undo, undo → "A")', () => {
		const initial = makeDoc();
		const { editor, plim } = headless(initial);
		const ledger = new TransactionLedger();
		ledger.attach(editor);

		type(editor, 0, 'A');
		type(editor, 1, 'B');
		type(editor, 2, 'C');
		plim.getHistory().undo();
		plim.getHistory().undo();

		expect(blockPlainText(editor.getState().doc.children[0]!)).toBe('A');

		const fresh = replayTarget(initial);
		ledger.replay(fresh);
		expect(fresh.getState().doc).toEqual(editor.getState().doc);
	});
});
