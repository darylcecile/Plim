import { describe, expect, it } from 'vitest';
import { contentFromMarkdown, contentToMarkdown } from '../src/index.js';
import { defineBlock, type BlockMarkdownContext } from '@plim/core';

// Doc → markdown serializer. Mirrors `contentFromMarkdown` so the two
// functions round-trip for built-in block types. Custom blocks delegate
// to `descriptor.toMarkdown(payload, ctx)` when the descriptor is passed
// via `options.blocks`. These tests pin both halves of the contract.

describe('contentToMarkdown — built-in blocks', () => {
	it('serializes paragraphs verbatim', () => {
		const md = contentToMarkdown({
			type: 'doc',
			children: [
				{ id: '1', type: 'paragraph', text: [{ text: 'hello world' }] },
				{ id: '2', type: 'paragraph', text: [{ text: 'second' }] },
			],
		});
		expect(md).toBe('hello world\nsecond');
	});

	it('serializes headings with #/##/### based on level', () => {
		const md = contentToMarkdown({
			type: 'doc',
			children: [
				{ id: '1', type: 'heading', attrs: { level: 1 }, text: [{ text: 'top' }] },
				{ id: '2', type: 'heading', attrs: { level: 2 }, text: [{ text: 'mid' }] },
				{ id: '3', type: 'heading', attrs: { level: 3 }, text: [{ text: 'low' }] },
			],
		});
		expect(md).toBe('# top\n## mid\n### low');
	});

	it('serializes inline marks (bold / italic / code / strike / link)', () => {
		const md = contentToMarkdown({
			type: 'doc',
			children: [
				{
					id: '1',
					type: 'paragraph',
					text: [
						{ text: 'a ' },
						{ text: 'bold', marks: [{ type: 'bold' }] },
						{ text: ' and ' },
						{ text: 'em', marks: [{ type: 'italic' }] },
						{ text: ' and ' },
						{ text: 'x', marks: [{ type: 'code' }] },
						{ text: ' and ' },
						{ text: 'gone', marks: [{ type: 'strikethrough' }] },
						{ text: ' and ' },
						{ text: 'link', marks: [{ type: 'link', attrs: { href: 'https://x.io' } }] },
					],
				},
			],
		});
		expect(md).toBe('a **bold** and *em* and `x` and ~gone~ and [link](https://x.io)');
	});

	it('numbers numbered_list_items contiguously, resetting on non-list siblings', () => {
		const md = contentToMarkdown({
			type: 'doc',
			children: [
				{ id: '1', type: 'numbered_list_item', text: [{ text: 'one' }] },
				{ id: '2', type: 'numbered_list_item', text: [{ text: 'two' }] },
				{ id: '3', type: 'numbered_list_item', text: [{ text: 'three' }] },
				{ id: '4', type: 'paragraph', text: [{ text: 'break' }] },
				{ id: '5', type: 'numbered_list_item', text: [{ text: 'one again' }] },
			],
		});
		expect(md).toBe('1. one\n2. two\n3. three\nbreak\n1. one again');
	});

	it('serializes to_do checkbox state', () => {
		const md = contentToMarkdown({
			type: 'doc',
			children: [
				{ id: '1', type: 'to_do', attrs: { checked: false }, text: [{ text: 'pending' }] },
				{ id: '2', type: 'to_do', attrs: { checked: true }, text: [{ text: 'done' }] },
			],
		});
		expect(md).toBe('- [ ] pending\n- [x] done');
	});

	it('serializes code blocks with fences and optional language', () => {
		const md = contentToMarkdown({
			type: 'doc',
			children: [
				{ id: '1', type: 'code', attrs: { language: 'ts' }, text: [{ text: 'const x = 1;\nconst y = 2;' }] },
			],
		});
		expect(md).toBe('```ts\nconst x = 1;\nconst y = 2;\n```');
	});

	it('serializes dividers as `---`', () => {
		const md = contentToMarkdown({
			type: 'doc',
			children: [{ id: '1', type: 'divider' }],
		});
		expect(md).toBe('---');
	});

	it('escapes inline characters that would otherwise be markdown syntax', () => {
		const md = contentToMarkdown({
			type: 'doc',
			children: [{ id: '1', type: 'paragraph', text: [{ text: 'a *star* and a [bracket]' }] }],
		});
		// `*` and `[` get backslash-escaped so they don't get re-parsed.
		expect(md).toBe('a \\*star\\* and a \\[bracket\\]');
	});

	it('round-trips through contentFromMarkdown for built-in types', () => {
		const original = '# heading\n- one\n- two\n1. a\n2. b\n> quote\n```js\nconst x = 1;\n```\n---';
		const doc = contentFromMarkdown(...original.split('\n'));
		const round = contentToMarkdown(doc);
		expect(round).toBe(original);
	});
});

describe('contentToMarkdown — custom blocks via descriptor.toMarkdown', () => {
	it('delegates to descriptor.toMarkdown when registered', () => {
		const calloutBlock = defineBlock({
			name: 'callout',
			type: 'standalone',
			toMarkdown: (payload, ctx: BlockMarkdownContext) => {
				const tone = String(payload.attrs.tone ?? 'info').toUpperCase();
				const inline = ctx.serializeInline(ctx.spans);
				return [`> [!${tone}] ${inline}`];
			},
		})();
		const md = contentToMarkdown(
			{
				type: 'doc',
				children: [
					{
						id: '1',
						type: 'callout',
						attrs: { tone: 'warn' },
						text: [
							{ text: 'be ' },
							{ text: 'careful', marks: [{ type: 'bold' }] },
						],
					},
				],
			},
			{ blocks: [calloutBlock] },
		);
		expect(md).toBe('> [!WARN] be **careful**');
	});

	it('falls back to plain text when no descriptor and no built-in mapping', () => {
		const md = contentToMarkdown({
			type: 'doc',
			children: [{ id: '1', type: 'unknown_block', text: [{ text: 'fallback' }] } as never],
		});
		expect(md).toBe('fallback');
	});

	it('descriptor returning a single string is treated as one line', () => {
		const block = defineBlock({
			name: 'tag',
			type: 'standalone',
			toMarkdown: (p) => `#${p.textContent}#`,
		})();
		const md = contentToMarkdown(
			{ type: 'doc', children: [{ id: '1', type: 'tag', text: [{ text: 'hi' }] }] },
			{ blocks: [block] },
		);
		expect(md).toBe('#hi#');
	});

	it('descriptor returning multiple lines emits them in order', () => {
		const block = defineBlock({
			name: 'multi',
			type: 'standalone',
			toMarkdown: () => ['line one', 'line two', 'line three'],
		})();
		const md = contentToMarkdown(
			{ type: 'doc', children: [{ id: '1', type: 'multi' }] },
			{ blocks: [block] },
		);
		expect(md).toBe('line one\nline two\nline three');
	});

	it('children are serialized after the parent and indented by depth', () => {
		// Built-in-only path with nested children — toggle has children.
		const md = contentToMarkdown({
			type: 'doc',
			children: [
				{
					id: '1',
					type: 'toggle',
					text: [{ text: 'parent' }],
					children: [
						{ id: '2', type: 'paragraph', text: [{ text: 'child one' }] },
						{ id: '3', type: 'paragraph', text: [{ text: 'child two' }] },
					],
				},
			],
		});
		expect(md).toBe('- parent\n  child one\n  child two');
	});
});
