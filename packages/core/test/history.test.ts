import { describe, expect, it, vi } from 'vitest';
import { History, type EditorState } from '@plim/core';

const empty: EditorState = {
	doc: { type: 'doc', children: [] },
	selection: { anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } },
};

describe('History', () => {
	it('push/popUndo/popRedo cycle', () => {
		const h = new History();
		expect(h.canUndo).toBe(false);
		expect(h.canRedo).toBe(false);

		h.push({ stateBefore: empty, stateAfter: empty, timestamp: 1 });
		expect(h.canUndo).toBe(true);
		expect(h.canRedo).toBe(false);

		const undone = h.popUndo();
		expect(undone).not.toBeNull();
		expect(h.canUndo).toBe(false);
		expect(h.canRedo).toBe(true);

		const redone = h.popRedo();
		expect(redone).not.toBeNull();
		expect(h.canUndo).toBe(true);
		expect(h.canRedo).toBe(false);
	});

	it('push clears redo stack', () => {
		const h = new History();
		h.push({ stateBefore: empty, stateAfter: empty, timestamp: 1 });
		h.popUndo();
		expect(h.canRedo).toBe(true);
		h.push({ stateBefore: empty, stateAfter: empty, timestamp: 2 });
		expect(h.canRedo).toBe(false);
	});

	it('onChange notifies subscribers', () => {
		const h = new History();
		const cb = vi.fn();
		const off = h.onChange(cb);
		h.push({ stateBefore: empty, stateAfter: empty, timestamp: 1 });
		expect(cb).toHaveBeenCalledTimes(1);
		off();
		h.push({ stateBefore: empty, stateAfter: empty, timestamp: 2 });
		expect(cb).toHaveBeenCalledTimes(1);
	});
});
