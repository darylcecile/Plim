import { describe, expect, it } from 'vitest';
import {
	assertBlockText,
	assertBlockType,
	assertDocEquals,
	assertHasMark,
	assertNoMark,
	assertPlainText,
	block,
	blockText,
	bold,
	createIdFactory,
	debugTree,
	doc,
	getBlock,
	highlight,
	link,
	marksAt,
	normalizeDoc,
	paragraph,
	plainText,
	quote,
} from '@plim/test-utils';

describe('inspection helpers', () => {
	it('gets blocks by path and throws for missing paths', () => {
		const fixture = doc(quote('parent', { id: 'q', children: [paragraph('child', { id: 'p' })] }));

		expect(getBlock(fixture, [0, 0]).id).toBe('p');
		expect(() => getBlock(fixture, [1])).toThrow(/No block found/);
	});

	it('reads plain text across empty, text-less, and nested blocks', () => {
		const fixture = doc(paragraph('one'), block('divider', { id: 'd' }), quote('two', { children: [paragraph('three')] }));

		expect(plainText(fixture)).toBe('one\ntwo\nthree');
		expect(blockText(fixture.children[1]!)).toBe('');
	});

	it('reads inherited marks at offsets', () => {
		const fixture = doc(paragraph('a', bold('bc'), link('https://example.com', highlight('d'))));

		expect(marksAt(fixture, [0], 2).map((mark) => mark.type)).toEqual(['bold']);
		expect(marksAt(fixture, [0], 4).map((mark) => mark.type)).toEqual([]);
		expect(marksAt(fixture, [0], 3).map((mark) => mark.type)).toEqual([]);
	});

	it('normalizes docs by stripping ids and sorting attrs and marks', () => {
		const idsA = createIdFactory('a');
		const idsB = createIdFactory('b');
		const left = doc(paragraph(link('x', bold('same')), { idFactory: idsA }));
		const right = doc(paragraph(link('x', bold('same')), { idFactory: idsB }));

		expect(normalizeDoc(left)).toEqual(normalizeDoc(right));
		expect(JSON.stringify(normalizeDoc(left))).not.toContain(left.children[0]!.id);
	});

	it('prints a readable debug tree', () => {
		const fixture = doc(quote('parent', { id: 'q', children: [paragraph('child', { id: 'p' })] }));

		expect(debugTree(fixture)).toContain('quote#q "parent"');
		expect(debugTree(fixture)).toContain('\t\t- paragraph#p "child"');
	});

	it('asserts success cases', () => {
		const fixture = doc(paragraph('hello ', bold('world')));

		expect(() => assertPlainText(fixture, 'hello world')).not.toThrow();
		expect(() => assertBlockType(fixture, [0], 'paragraph')).not.toThrow();
		expect(() => assertBlockText(fixture.children[0]!, 'hello world')).not.toThrow();
		expect(() => assertHasMark(fixture, [0], 8, 'bold')).not.toThrow();
		expect(() => assertNoMark(fixture, [0], 1, 'bold')).not.toThrow();
		expect(() => assertDocEquals(fixture, doc(paragraph('hello ', bold('world'))))).not.toThrow();
	});

	it('asserts failure cases with useful errors', () => {
		const fixture = doc(paragraph('hello ', bold('world')));

		expect(() => assertPlainText(fixture, 'nope')).toThrow(/Expected plain text/);
		expect(() => assertBlockType(fixture, [0], 'heading')).toThrow(/Expected block/);
		expect(() => assertBlockText(fixture.children[0]!, 'nope')).toThrow(/Expected block text/);
		expect(() => assertHasMark(fixture, [0], 1, 'bold')).toThrow(/Expected mark/);
		expect(() => assertHasMark(fixture, [0], 8, 'bold', { strong: true })).toThrow(/Expected mark/);
		expect(() => assertNoMark(fixture, [0], 8, 'bold')).toThrow(/Expected no mark/);
		expect(() => assertDocEquals(fixture, doc(paragraph('different')))).toThrow(/Documents differ/);
	});

	it('handles empty docs', () => {
		const empty = doc();

		expect(plainText(empty)).toBe('');
		expect(normalizeDoc(empty)).toEqual({ type: 'doc', children: [] });
		expect(debugTree(empty)).toBe('doc');
	});
});
