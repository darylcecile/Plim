import { describe, expect, it } from 'vitest';
import { builders, evalRule, newId, type EditorState, type ValidationContext } from '@plim/core';

function ctx(text: string, offset: number, selOffset?: number): ValidationContext {
	const state: EditorState = {
		doc: { type: 'doc', children: [{ id: newId(), type: 'paragraph', text: text ? [{ text }] : [] }] },
		selection: {
			anchor: { path: [0], offset: selOffset ?? offset },
			head: { path: [0], offset },
		},
	};
	return { state, supportsDecoration: () => true };
}

describe('validation rules', () => {
	it('selectionNotEmpty respects collapse', () => {
		expect(evalRule('selectionNotEmpty', ctx('hello', 2))).toBe(false);
		expect(evalRule('selectionNotEmpty', ctx('hello', 4, 1))).toBe(true);
	});

	it('startOfBlock', () => {
		expect(evalRule('startOfBlock', ctx('hello', 0))).toBe(true);
		expect(evalRule('startOfBlock', ctx('hello', 2))).toBe(false);
	});

	it('endOfBlock', () => {
		expect(evalRule('endOfBlock', ctx('hello', 5))).toBe(true);
		expect(evalRule('endOfBlock', ctx('hello', 3))).toBe(false);
	});

	it('precededByWhitespace at offset 0', () => {
		expect(evalRule('precededByWhitespace', ctx('hello', 0))).toBe(true);
	});

	it('precededByWhitespace after a space', () => {
		expect(evalRule('precededByWhitespace', ctx('a hello', 2))).toBe(true);
	});

	it('precededByWhitespace after a letter', () => {
		expect(evalRule('precededByWhitespace', ctx('hello', 3))).toBe(false);
	});

	it('and combinator', () => {
		const rule = builders.and(['startOfBlock', 'inTextBlock']);
		expect(evalRule(rule, ctx('hello', 0))).toBe(true);
		expect(evalRule(rule, ctx('hello', 1))).toBe(false);
	});

	it('or combinator', () => {
		const rule = builders.or(['startOfBlock', 'endOfBlock']);
		expect(evalRule(rule, ctx('hello', 0))).toBe(true);
		expect(evalRule(rule, ctx('hello', 5))).toBe(true);
		expect(evalRule(rule, ctx('hello', 2))).toBe(false);
	});

	it('markActiveInSelection — collapsed selection is never active', () => {
		const state: EditorState = {
			doc: {
				type: 'doc',
				children: [
					{
						id: newId(),
						type: 'paragraph',
						text: [{ text: 'hello', marks: [{ type: 'bold' }] }],
					},
				],
			},
			selection: { anchor: { path: [0], offset: 2 }, head: { path: [0], offset: 2 } },
		};
		expect(evalRule(builders.markActiveInSelection('bold'), { state, supportsDecoration: () => true })).toBe(false);
	});

	it('markActiveInSelection — fully covered range is active', () => {
		const state: EditorState = {
			doc: {
				type: 'doc',
				children: [
					{ id: newId(), type: 'paragraph', text: [{ text: 'hello', marks: [{ type: 'bold' }] }] },
				],
			},
			selection: { anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 5 } },
		};
		expect(evalRule(builders.markActiveInSelection('bold'), { state, supportsDecoration: () => true })).toBe(true);
		expect(evalRule(builders.markActiveInSelection('italic'), { state, supportsDecoration: () => true })).toBe(false);
	});

	it('markActiveInSelection — partially covered range is not active', () => {
		const state: EditorState = {
			doc: {
				type: 'doc',
				children: [
					{
						id: newId(),
						type: 'paragraph',
						text: [
							{ text: 'hel', marks: [{ type: 'bold' }] },
							{ text: 'lo' },
						],
					},
				],
			},
			selection: { anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 5 } },
		};
		expect(evalRule(builders.markActiveInSelection('bold'), { state, supportsDecoration: () => true })).toBe(false);
	});

	it('markActiveInSelection — backward selection is normalised', () => {
		const state: EditorState = {
			doc: {
				type: 'doc',
				children: [
					{ id: newId(), type: 'paragraph', text: [{ text: 'hello', marks: [{ type: 'bold' }] }] },
				],
			},
			// head before anchor (backward selection).
			selection: { anchor: { path: [0], offset: 5 }, head: { path: [0], offset: 0 } },
		};
		expect(evalRule(builders.markActiveInSelection('bold'), { state, supportsDecoration: () => true })).toBe(true);
	});

	it('blockTypeIs reads the head block type', () => {
		const state: EditorState = {
			doc: {
				type: 'doc',
				children: [
					{ id: newId(), type: 'heading', attrs: { level: 1 }, text: [{ text: 'Title' }] },
					{ id: newId(), type: 'paragraph', text: [{ text: 'body' }] },
				],
			},
			selection: { anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } },
		};
		expect(evalRule(builders.blockTypeIs('heading'), { state, supportsDecoration: () => true })).toBe(true);
		expect(evalRule(builders.blockTypeIs('paragraph'), { state, supportsDecoration: () => true })).toBe(false);
		// Move head to the paragraph.
		state.selection = { anchor: { path: [1], offset: 0 }, head: { path: [1], offset: 0 } };
		expect(evalRule(builders.blockTypeIs('paragraph'), { state, supportsDecoration: () => true })).toBe(true);
	});
});
