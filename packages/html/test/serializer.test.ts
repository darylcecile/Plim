import { Snapshot, type BlockNode, type DocumentNode, type EditorState } from '@plim/core';
import { describe, expect, it } from 'vitest';
import { defaultBlockRenderers, defaultMarkRenderers, escape, serializeToHTML, toDocumentNode, type BlockRenderer, type MarkRenderer } from '@plim/html';

function block(type: string, text = '', attrs?: Record<string, unknown>, children?: BlockNode[]): BlockNode {
return {
id: `${type}-${Math.random().toString(36).slice(2)}`,
type,
...(attrs ? { attrs } : {}),
...(text ? { text: [{ text }] } : {}),
...(children ? { children } : {}),
};
}

function doc(children: BlockNode[]): DocumentNode {
return { type: 'doc', children };
}

function state(document: DocumentNode): EditorState {
return {
doc: document,
selection: {
anchor: { path: [0], offset: 0 },
head: { path: [0], offset: 0 },
},
};
}

describe('@plim/html', () => {
it('exports defaults and escapes text and attributes', () => {
expect(defaultBlockRenderers.paragraph).toBeTypeOf('function');
expect(defaultMarkRenderers.bold).toBeTypeOf('function');
expect(escape(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
const html = serializeToHTML(doc([
block('paragraph', `<script>alert("x" & 'y')</script>`),
block('image', '', { src: `x" onerror="alert('x')`, alt: `<bad & "quote" 'apostrophe'>` }),
]));
expect(html).toContain('&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;');
expect(html).toContain('src="x&quot; onerror=&quot;alert(&#39;x&#39;)"');
expect(html).toContain('alt="&lt;bad &amp; &quot;quote&quot; &#39;apostrophe&#39;&gt;"');
expect(html).not.toContain('<script>');
});

it('renders every builtin block', () => {
const nested = block('paragraph', 'nested');
const tableRow = block('table_row', '', undefined, [block('table_cell', 'A'), block('table_header_cell', 'B')]);
const html = serializeToHTML(doc([
block('paragraph', 'Plain'),
block('heading', 'Head', { level: 9 }),
block('quote', 'Quote'),
block('toggle', 'Toggle', undefined, [nested]),
block('divider'),
block('image', '', { src: '/cat.png', alt: 'Cat', caption: 'Caption' }),
block('image', '', { src: '/plain.png', alt: 'Plain image' }),
block('embed', '', { url: 'https://example.com/embed' }),
block('table', '', undefined, [tableRow]),
]));
expect(html).toContain('<p class="plim-paragraph">Plain</p>');
expect(html).toContain('<h3 class="plim-heading">Head</h3>');
expect(html).toContain('<blockquote class="plim-quote">Quote</blockquote>');
expect(html).toContain('<details class="plim-toggle"><summary>Toggle</summary><p class="plim-paragraph">nested</p></details>');
expect(html).toContain('<hr class="plim-divider">');
expect(html).toContain('<figure class="plim-image"><img src="/cat.png" alt="Cat"><figcaption>Caption</figcaption></figure>');
expect(html).toContain('<figure class="plim-image"><img src="/plain.png" alt="Plain image"></figure>');
expect(html).toContain('<div class="plim-embed" data-embed-url="https://example.com/embed"><iframe src="https://example.com/embed" loading="lazy"></iframe></div>');
expect(html).toContain('<table class="plim-table"><tr class="plim-table-row"><td class="plim-table-cell">A</td><th class="plim-table-header-cell">B</th></tr></table>');
});

it('groups consecutive list items and recurses into nested children', () => {
const html = serializeToHTML(doc([
block('bulleted_list_item', 'a'),
block('bulleted_list_item', 'b', undefined, [block('numbered_list_item', 'nested 1'), block('numbered_list_item', 'nested 2')]),
block('numbered_list_item', 'one'),
block('numbered_list_item', 'two'),
block('bulleted_list_item', 'c'),
]));
expect(html).toBe('<ul class="plim-ul"><li class="plim-bulleted-list-item">a</li><li class="plim-bulleted-list-item">b<ol class="plim-ol"><li class="plim-numbered-list-item">nested 1</li><li class="plim-numbered-list-item">nested 2</li></ol></li></ul><ol class="plim-ol"><li class="plim-numbered-list-item">one</li><li class="plim-numbered-list-item">two</li></ol><ul class="plim-ul"><li class="plim-bulleted-list-item">c</li></ul>');
});

it('renders to_do checked and unchecked as disabled checkboxes', () => {
const html = serializeToHTML(doc([block('to_do', 'done', { checked: true }), block('to_do', 'todo', { checked: false })]));
expect(html).toBe('<li class="plim-to-do"><input type="checkbox" disabled checked>done</li><li class="plim-to-do"><input type="checkbox" disabled>todo</li>');
});

it('escapes code block text and does not process inline marks inside code blocks', () => {
const code: BlockNode = {
id: 'code-1',
type: 'code',
attrs: { language: 'ts<script>' },
text: [{ text: '<tag>&value', marks: [{ type: 'bold' }] }],
};
expect(serializeToHTML(doc([code]))).toBe('<pre class="plim-code"><code class="language-ts-script-">&lt;tag&gt;&amp;value</code></pre>');
});

it('passes raw_html through verbatim', () => {
expect(serializeToHTML(doc([block('raw_html', '', { html: '<section><script>x()</script></section>' })]))).toBe('<section><script>x()</script></section>');
});

it('renders every builtin mark and nests multiple marks deterministically', () => {
const rich: BlockNode = {
id: 'marks',
type: 'paragraph',
text: [
{ text: 'b', marks: [{ type: 'bold' }] },
{ text: 'i', marks: [{ type: 'italic' }] },
{ text: 'u', marks: [{ type: 'underline' }] },
{ text: 's', marks: [{ type: 'strikethrough' }] },
{ text: 'c', marks: [{ type: 'code' }] },
{ text: 'l', marks: [{ type: 'link', attrs: { href: 'https://example.com?a=1&b=2', target: '_self', rel: 'nofollow' } }] },
{ text: 'h', marks: [{ type: 'highlight' }] },
{ text: '@d', marks: [{ type: 'mention', attrs: { id: 'u<1', href: '/users/daryl?x=1&y=2' } }] },
{ text: 'multi', marks: [{ type: 'link', attrs: { href: '/x' } }, { type: 'bold' }, { type: 'highlight' }] },
],
};
const html = serializeToHTML(doc([rich]));
expect(html).toBe('<p class="plim-paragraph"><strong>b</strong><em>i</em><u>u</u><s>s</s><code class="plim-inline-code">c</code><a href="https://example.com?a=1&amp;b=2" target="_self" rel="nofollow">l</a><mark>h</mark><span class="plim-mention" data-mention-id="u&lt;1" data-mention-href="/users/daryl?x=1&amp;y=2" data-atomic="true">@d</span><mark><a href="/x" target="_blank" rel="noreferrer"><strong>multi</strong></a></mark></p>');
});

it('supports custom block and mark overrides', () => {
const customBlock: BlockRenderer = (node, ctx) => `<aside${ctx.attr('class', ctx.classFor('callout'))}>${ctx.renderInline(node.text)}</aside>`;
const customBold: MarkRenderer = (innerHtml) => `<b data-bold="true">${innerHtml}</b>`;
const html = serializeToHTML(doc([{ id: 'x', type: 'callout', text: [{ text: 'Hi', marks: [{ type: 'bold' }] }] }]), {
classPrefix: 'x-',
blocks: { callout: customBlock },
marks: { bold: customBold },
});
expect(html).toBe('<aside class="x-callout"><b data-bold="true">Hi</b></aside>');
});

it('falls back for unknown blocks and marks without throwing', () => {
const html = serializeToHTML(doc([{ id: 'unknown', type: 'mystery<block>', text: [{ text: 'Safe', marks: [{ type: 'comment', attrs: { id: 'c1' } }] }] }]));
expect(html).toBe('<div class="plim-mystery-block-" data-block-type="mystery&lt;block&gt;">Safe</div>');
});

it('normalizes all supported input forms', () => {
const blocks = [block('paragraph', 'Input')];
const document = doc(blocks);
const editorState = state(document);
const snapshot = new Snapshot(editorState);
expect(toDocumentNode(blocks)).toEqual(document);
expect(serializeToHTML(document)).toBe('<p class="plim-paragraph">Input</p>');
expect(serializeToHTML(editorState)).toBe('<p class="plim-paragraph">Input</p>');
expect(serializeToHTML(snapshot)).toBe('<p class="plim-paragraph">Input</p>');
expect(serializeToHTML(blocks, { document: true })).toBe('<!doctype html><html><body><p class="plim-paragraph">Input</p></body></html>');
});

it('renders table attrs.rows as a best-effort table structure', () => {
const html = serializeToHTML(doc([block('table', '', { rows: [[{ text: 'H', header: true }, 'C']] })]));
expect(html).toBe('<table class="plim-table"><tr><th>H</th><td>C</td></tr></table>');
});
});
