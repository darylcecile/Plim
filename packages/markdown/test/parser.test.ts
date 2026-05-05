import { describe, expect, it } from 'vitest';
import { contentFromMarkdown, parseMarkdown } from '@plim/markdown';
import { blockPlainText, defineBlock, type BlockDescriptor } from '@plim/core';

describe('contentFromMarkdown', () => {
	it('parses a heading', () => {
		const doc = contentFromMarkdown('# Hello');
		expect(doc.children).toHaveLength(1);
		expect(doc.children[0]!.type).toBe('heading');
		expect(doc.children[0]!.attrs?.level).toBe(1);
		expect(blockPlainText(doc.children[0]!)).toBe('Hello');
	});

	it('parses h2 and h3', () => {
		const doc = contentFromMarkdown('## Two', '### Three');
		expect(doc.children[0]!.attrs?.level).toBe(2);
		expect(doc.children[1]!.attrs?.level).toBe(3);
	});

	it('parses bullet list items', () => {
		const doc = contentFromMarkdown('- one', '- two');
		expect(doc.children).toHaveLength(2);
		expect(doc.children[0]!.type).toBe('bulleted_list_item');
		expect(blockPlainText(doc.children[0]!)).toBe('one');
		expect(blockPlainText(doc.children[1]!)).toBe('two');
	});

	it('parses bullet list items with * and + markers', () => {
		const doc = contentFromMarkdown('* star', '+ plus');
		expect(doc.children[0]!.type).toBe('bulleted_list_item');
		expect(doc.children[1]!.type).toBe('bulleted_list_item');
	});

	it('parses numbered list items', () => {
		const doc = contentFromMarkdown('1. one', '2. two');
		expect(doc.children[0]!.type).toBe('numbered_list_item');
	});

	it('parses multi-digit numbered list items', () => {
		const doc = contentFromMarkdown('10. ten', '125. lots');
		expect(doc.children[0]!.type).toBe('numbered_list_item');
		expect(blockPlainText(doc.children[0]!)).toBe('ten');
		expect(doc.children[1]!.type).toBe('numbered_list_item');
		expect(blockPlainText(doc.children[1]!)).toBe('lots');
	});

	it('parses to-do items', () => {
		const doc = contentFromMarkdown('- [ ] open', '- [x] done');
		expect(doc.children[0]!.type).toBe('to_do');
		expect(doc.children[0]!.attrs?.checked).toBe(false);
		expect(doc.children[1]!.attrs?.checked).toBe(true);
	});

	it('parses to-do items with capital X', () => {
		const doc = contentFromMarkdown('- [X] caps');
		expect(doc.children[0]!.type).toBe('to_do');
		expect(doc.children[0]!.attrs?.checked).toBe(true);
	});

	it('parses a quote', () => {
		const doc = contentFromMarkdown('> quoted');
		expect(doc.children[0]!.type).toBe('quote');
	});

	it('parses a divider', () => {
		const doc = contentFromMarkdown('---');
		expect(doc.children[0]!.type).toBe('divider');
	});

	it('parses a divider with surrounding whitespace', () => {
		const doc = contentFromMarkdown('   ---   ');
		expect(doc.children[0]!.type).toBe('divider');
	});

	it('parses a code fence', () => {
		const doc = contentFromMarkdown('```', 'function() {}', '```');
		expect(doc.children[0]!.type).toBe('code');
		expect(blockPlainText(doc.children[0]!)).toBe('function() {}');
	});

	it('parses code fence with language attribute', () => {
		const doc = contentFromMarkdown('```typescript', 'const x = 1;', '```');
		expect(doc.children[0]!.type).toBe('code');
		expect(doc.children[0]!.attrs?.language).toBe('typescript');
	});

	it('preserves blank lines and indentation inside a code fence', () => {
		const doc = contentFromMarkdown('```js', 'a', '', '  b', '```');
		expect(blockPlainText(doc.children[0]!)).toBe('a\n\n  b');
	});

	it('treats unclosed code fence as code block to end of input', () => {
		const doc = contentFromMarkdown('```', 'still code');
		expect(doc.children[0]!.type).toBe('code');
		expect(blockPlainText(doc.children[0]!)).toBe('still code');
	});

	it('parses inline bold and italic', () => {
		const doc = contentFromMarkdown('**bold** *ital* `code`');
		const spans = doc.children[0]!.text!;
		expect(spans.find((s) => s.marks?.some((m) => m.type === 'bold'))?.text).toBe('bold');
		expect(spans.find((s) => s.marks?.some((m) => m.type === 'italic'))?.text).toBe('ital');
		expect(spans.find((s) => s.marks?.some((m) => m.type === 'code'))?.text).toBe('code');
	});

	it('parses inline strikethrough', () => {
		const doc = contentFromMarkdown('hello ~strike~ world');
		const spans = doc.children[0]!.text!;
		const strike = spans.find((s) => s.marks?.some((m) => m.type === 'strikethrough'));
		expect(strike?.text).toBe('strike');
	});

	it('parses inline links', () => {
		const doc = contentFromMarkdown('see [home](https://example.com) here');
		const spans = doc.children[0]!.text!;
		const link = spans.find((s) => s.marks?.some((m) => m.type === 'link'));
		expect(link?.text).toBe('home');
		expect(link?.marks?.[0]?.attrs?.href).toBe('https://example.com');
	});

	it('parses inline marks inside headings', () => {
		const doc = contentFromMarkdown('## **Bold** heading');
		expect(doc.children[0]!.type).toBe('heading');
		const spans = doc.children[0]!.text!;
		expect(spans.find((s) => s.marks?.some((m) => m.type === 'bold'))?.text).toBe('Bold');
	});

	it('preserves text when inline asterisks are unmatched', () => {
		const doc = contentFromMarkdown('1 * 2 = 2');
		expect(blockPlainText(doc.children[0]!)).toBe('1 * 2 = 2');
	});

	it('treats four-hash lines as paragraphs (only h1-h3 are headings)', () => {
		const doc = contentFromMarkdown('#### still text');
		expect(doc.children[0]!.type).toBe('paragraph');
		expect(blockPlainText(doc.children[0]!)).toBe('#### still text');
	});

	it('produces an empty paragraph for blank input', () => {
		const doc = contentFromMarkdown();
		expect(doc.children).toHaveLength(1);
		expect(doc.children[0]!.type).toBe('paragraph');
		expect(blockPlainText(doc.children[0]!)).toBe('');
	});

	it('produces empty paragraphs for blank lines between content', () => {
		const doc = contentFromMarkdown('one', '', 'two');
		expect(doc.children).toHaveLength(3);
		expect(doc.children[1]!.type).toBe('paragraph');
		expect(blockPlainText(doc.children[1]!)).toBe('');
	});

	it('parses bare [ ] / [x] task syntax (no leading bullet)', () => {
		const doc = contentFromMarkdown('[ ] todo', '[x] done');
		expect(doc.children[0]!.type).toBe('to_do');
		expect(doc.children[0]!.attrs?.checked).toBe(false);
		expect(doc.children[1]!.type).toBe('to_do');
		expect(doc.children[1]!.attrs?.checked).toBe(true);
	});

	it('combines mixed marks across one line', () => {
		const doc = contentFromMarkdown('**bold** then *ital* and `code` and ~strike~');
		const spans = doc.children[0]!.text!;
		const types = spans.map((s) => s.marks?.[0]?.type);
		expect(types).toContain('bold');
		expect(types).toContain('italic');
		expect(types).toContain('code');
		expect(types).toContain('strikethrough');
	});
});

describe('parseMarkdown — descriptor.fromMarkdown hook', () => {
	// Custom callout block whose `toMarkdown` emits `> [!TONE] text` and
	// whose `fromMarkdown` reverses that. Without this hook, `parseMarkdown`
	// would route the line to the built-in `quote` parser — losing the
	// callout type and tone attr (lossy round-trip).
	const calloutDesc: BlockDescriptor = {
		name: 'callout',
		type: 'standalone',
		toMarkdown: (p) => `> [!${String(p.attrs.tone ?? 'NOTE').toUpperCase()}] ${p.textContent}`,
		fromMarkdown: ({ lines, index, parseInline }) => {
			const line = lines[index] ?? '';
			const m = /^>\s+\[!(\w+)\]\s+(.*)$/.exec(line);
			if (!m) return null;
			return {
				block: { id: 'callout-id', type: 'callout', attrs: { tone: m[1]!.toLowerCase() }, text: parseInline(m[2]!) },
				consumed: 1,
			};
		},
	};
	const factory = defineBlock(calloutDesc);
	const desc = factory({} as never);

	it('parses a callout via the descriptor instead of falling through to quote', () => {
		const doc = parseMarkdown(['> [!INFO] heads up'], { blocks: [desc] });
		expect(doc.children).toHaveLength(1);
		expect(doc.children[0]!.type).toBe('callout');
		expect(doc.children[0]!.attrs?.tone).toBe('info');
		expect(blockPlainText(doc.children[0]!)).toBe('heads up');
	});

	it('falls through to built-in quote when the descriptor returns null', () => {
		const doc = parseMarkdown(['> just a quote'], { blocks: [desc] });
		expect(doc.children[0]!.type).toBe('quote');
	});

	it('lets earlier descriptors win in registration order', () => {
		const greedy: BlockDescriptor = {
			name: 'greedy',
			type: 'standalone',
			fromMarkdown: ({ lines, index, parseInline }) => ({
				block: { id: 'g', type: 'greedy', text: parseInline(lines[index] ?? '') },
				consumed: 1,
			}),
		};
		const doc = parseMarkdown(['> [!INFO] x'], { blocks: [greedy, desc] });
		// Greedy claims everything; callout never gets a peek.
		expect(doc.children[0]!.type).toBe('greedy');
	});
});

