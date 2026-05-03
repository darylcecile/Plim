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
});
