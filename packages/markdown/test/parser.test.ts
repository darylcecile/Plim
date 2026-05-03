import { describe, expect, it } from 'vitest';
import { contentFromMarkdown } from '@plim/markdown';
import { blockPlainText } from '@plim/core';

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

	it('parses numbered list items', () => {
		const doc = contentFromMarkdown('1. one', '2. two');
		expect(doc.children[0]!.type).toBe('numbered_list_item');
	});

	it('parses to-do items', () => {
		const doc = contentFromMarkdown('- [ ] open', '- [x] done');
		expect(doc.children[0]!.type).toBe('to_do');
		expect(doc.children[0]!.attrs?.checked).toBe(false);
		expect(doc.children[1]!.attrs?.checked).toBe(true);
	});

	it('parses a quote', () => {
		const doc = contentFromMarkdown('> quoted');
		expect(doc.children[0]!.type).toBe('quote');
	});

	it('parses a divider', () => {
		const doc = contentFromMarkdown('---');
		expect(doc.children[0]!.type).toBe('divider');
	});

	it('parses a code fence', () => {
		const doc = contentFromMarkdown('```', 'function() {}', '```');
		expect(doc.children[0]!.type).toBe('code');
		expect(blockPlainText(doc.children[0]!)).toBe('function() {}');
	});

	it('parses inline bold and italic', () => {
		const doc = contentFromMarkdown('**bold** *ital* `code`');
		const spans = doc.children[0]!.text!;
		expect(spans.find((s) => s.marks?.some((m) => m.type === 'bold'))?.text).toBe('bold');
		expect(spans.find((s) => s.marks?.some((m) => m.type === 'italic'))?.text).toBe('ital');
		expect(spans.find((s) => s.marks?.some((m) => m.type === 'code'))?.text).toBe('code');
	});

	it('parses inline links', () => {
		const doc = contentFromMarkdown('see [home](https://example.com) here');
		const spans = doc.children[0]!.text!;
		const link = spans.find((s) => s.marks?.some((m) => m.type === 'link'));
		expect(link?.text).toBe('home');
		expect(link?.marks?.[0]?.attrs?.href).toBe('https://example.com');
	});
});
