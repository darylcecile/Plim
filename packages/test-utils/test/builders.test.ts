import { describe, expect, it } from 'vitest';
import {
	block,
	bold,
	bulletItem,
	code,
	codeBlock,
	createIdFactory,
	divider,
	doc,
	heading,
	highlight,
	inline,
	italic,
	link,
	mark,
	numberedItem,
	paragraph,
	quote,
	strike,
	text,
	todoItem,
	toggle,
	underline,
} from '@plim/test-utils';

function markTypes(spans: { marks?: Array<{ type: string; }>; }[]): string[][] {
	return spans.map((span) => (span.marks ?? []).map((m) => m.type));
}

describe('document builders', () => {
	it('builds docs and low-level blocks with explicit ids, attrs, text, and children', () => {
		const child = block('child', { id: 'child-1', text: ['nested'] });
		const root = block('custom', {
			id: 'root-1',
			attrs: { tone: 'info' },
			text: ['hello'],
			children: [child],
		});

		expect(doc(root)).toEqual({ type: 'doc', children: [root] });
		expect(root).toMatchObject({ id: 'root-1', type: 'custom', attrs: { tone: 'info' }, text: [{ text: 'hello' }], children: [child] });
	});

	it('builds builtin blocks with canonical types and attrs', () => {
		const ids = createIdFactory('builtins');
		const blocks = [
			paragraph('p', { idFactory: ids }),
			heading(2, 'h', { idFactory: ids }),
			bulletItem('b', { idFactory: ids }),
			numberedItem('n', { idFactory: ids }),
			todoItem(true, 't', { idFactory: ids }),
			quote('q', { idFactory: ids }),
			codeBlock('const x = 1;', 'ts', { idFactory: ids }),
			divider({ idFactory: ids }),
			toggle('open', { idFactory: ids, children: [paragraph('inside', { idFactory: ids })] }),
		];

		expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'heading', 'bulleted_list_item', 'numbered_list_item', 'to_do', 'quote', 'code', 'divider', 'toggle']);
		expect(blocks[1]!.attrs).toEqual({ level: 2 });
		expect(blocks[4]!.attrs).toEqual({ checked: true });
		expect(blocks[6]!.attrs).toEqual({ language: 'ts' });
		expect(blocks[8]!.children?.[0]?.type).toBe('paragraph');
		expect(blocks.map((b) => b.id)).toEqual([
			'builtins_b_1',
			'builtins_b_2',
			'builtins_b_3',
			'builtins_b_4',
			'builtins_b_5',
			'builtins_b_6',
			'builtins_b_7',
			'builtins_b_8',
			'builtins_b_10',
		]);
	});

	it('mints ids by default and respects explicit ids', () => {
		const minted = paragraph('auto');
		const explicit = paragraph('manual', { id: 'fixed' });

		expect(minted.id).toMatch(/^b_/);
		expect(explicit.id).toBe('fixed');
	});

	it('mixes strings, spans, and nested inline arrays, then normalizes adjacent compatible spans', () => {
		const block = paragraph('Hello ', text('plain'), [' and ', bold('bold'), bold(' text')], '!');

		expect(block.text).toEqual([
			{ text: 'Hello plain and ' },
			{ text: 'bold text', marks: [{ type: 'bold' }] },
			{ text: '!' },
		]);
	});

	it('composes multiple and overlapping marks', () => {
		const spans = inline('a', bold('b', italic('c')), italic('d'), link('https://example.com', highlight('e')), strike(underline(code('f'))));

		expect(spans.map((span) => span.text)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
		expect(markTypes(spans)).toEqual([
			[],
			['bold'],
			['italic', 'bold'],
			['italic'],
			['highlight', 'link'],
			['code', 'underline', 'strikethrough'],
		]);
		expect(spans[4]!.marks?.[1]?.attrs).toEqual({ href: 'https://example.com' });
	});

	it('supports generic custom mark attrs without mutating inputs', () => {
		const attrs = { id: 'c1' };
		const spans = mark('comment', attrs, 'note');
		attrs.id = 'changed';

		expect(spans).toEqual([{ text: 'note', marks: [{ type: 'comment', attrs: { id: 'c1' } }] }]);
	});

	it('drops empty inline spans during normalization', () => {
		expect(paragraph('', bold(''), 'x').text).toEqual([{ text: 'x' }]);
	});
});
