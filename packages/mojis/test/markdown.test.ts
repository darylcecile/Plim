import { describe, expect, it } from 'vitest';
import type { DocumentNode, MarkDescriptor } from '@plim/core';
import { contentToMarkdown } from '@plim/markdown';
import { MOJI_IMAGE_PLACEHOLDER, mojiMark, mojiSpan } from '@plim/mojis';

// Resolve the `moji` mark factory into a descriptor so contentToMarkdown can
// find its `toMarkdown` hook. The factory ignores its editor argument.
const mojiDesc: MarkDescriptor = mojiMark(null as never);

function docWith(text: NonNullable<DocumentNode['children'][number]['text']>): DocumentNode {
	return { type: 'doc', children: [{ id: 'b1', type: 'paragraph', text }] };
}

describe('moji mark → markdown (copy-as-slug)', () => {
	it('serializes a native-glyph moji back to its :slug:', () => {
		const doc = docWith([{ text: 'Hello ' }, { text: '🌑', marks: [{ type: 'moji', attrs: { slug: 'moon' } }] }]);
		expect(contentToMarkdown(doc, { marks: [mojiDesc] })).toBe('Hello :moon:');
	});

	it('serializes an image moji (whose text is a placeholder) to :slug:', () => {
		const doc = docWith([
			{ text: 'Hi ' },
			{ text: MOJI_IMAGE_PLACEHOLDER, marks: [{ type: 'moji', attrs: { slug: 'plim', src: 'p.svg' } }] },
		]);
		expect(contentToMarkdown(doc, { marks: [mojiDesc] })).toBe('Hi :plim:');
	});

	it('handles several mojis in one line', () => {
		const doc = docWith([
			{ text: '🎉', marks: [{ type: 'moji', attrs: { slug: 'tada' } }] },
			{ text: ' and ' },
			{ text: '🚀', marks: [{ type: 'moji', attrs: { slug: 'rocket' } }] },
		]);
		expect(contentToMarkdown(doc, { marks: [mojiDesc] })).toBe(':tada: and :rocket:');
	});

	it('without the descriptor the mark is dropped and the glyph survives', () => {
		// Proves the `toMarkdown` hook (not some built-in) is what produces the
		// slug; without it the serializer keeps the raw text.
		const doc = docWith([{ text: 'Hello ' }, { text: '🌑', marks: [{ type: 'moji', attrs: { slug: 'moon' } }] }]);
		expect(contentToMarkdown(doc)).toBe('Hello 🌑');
	});
});

describe('mojiSpan', () => {
	it('builds a native glyph span (text = glyph, no src attr)', () => {
		const span = mojiSpan({ slug: 'moon', char: '🌑' });
		expect(span.text).toBe('🌑');
		expect(span.marks).toEqual([{ type: 'moji', attrs: { slug: 'moon' } }]);
	});

	it('builds an image span (text = placeholder, carries src attr)', () => {
		const span = mojiSpan({ slug: 'plim', src: 'p.svg' });
		expect(span.text).toBe(MOJI_IMAGE_PLACEHOLDER);
		expect(span.marks).toEqual([{ type: 'moji', attrs: { slug: 'plim', src: 'p.svg' } }]);
	});

	it('round-trips a built span back through markdown to its slug', () => {
		const doc = docWith([mojiSpan({ slug: 'moon', char: '🌑' })]);
		expect(contentToMarkdown(doc, { marks: [mojiDesc] })).toBe(':moon:');
	});
});
