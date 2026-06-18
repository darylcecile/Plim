import type { BlockNode, DocumentNode, EditorState, MarkInstance, Snapshot, TextSpan } from '@plim/core';

export type HTMLInput = DocumentNode | EditorState | Snapshot | BlockNode[];

export type BlockRenderer = (node: BlockNode, ctx: RenderContext) => string;
export type MarkRenderer = (innerHtml: string, mark: MarkInstance, ctx: RenderContext) => string;

export type HTMLSerializerOptions = {
blocks?: Record<string, BlockRenderer>;
marks?: Record<string, MarkRenderer>;
classPrefix?: string;
document?: boolean;
onUnknownBlock?: (node: BlockNode, ctx: RenderContext) => string;
};

export type RenderContext = {
renderBlock: (node: BlockNode) => string;
renderBlocks: (nodes: BlockNode[]) => string;
renderInline: (spans: TextSpan[] | undefined) => string;
renderText: (span: TextSpan) => string;
escape: (value: unknown) => string;
attr: (name: string, value: unknown) => string;
classFor: (type: string) => string;
classPrefix: string;
blocks: Record<string, BlockRenderer>;
marks: Record<string, MarkRenderer>;
options: HTMLSerializerOptions;
};

const MARK_RENDER_ORDER = [
'code',
'bold',
'italic',
'underline',
'strikethrough',
'link',
'highlight',
'mention',
] as const;

const MARK_ORDER = new Map<string, number>(MARK_RENDER_ORDER.map((type, index) => [type, index]));

export function escape(value: unknown): string {
return String(value ?? '')
.replaceAll('&', '&amp;')
.replaceAll('<', '&lt;')
.replaceAll('>', '&gt;')
.replaceAll('"', '&quot;')
.replaceAll("'", '&#39;');
}

export function attr(name: string, value: unknown): string {
if (value === undefined || value === null || value === false) return '';
if (!/^[A-Za-z_:][A-Za-z0-9:._-]*$/.test(name)) return '';
if (value === true) return ` ${name}`;
return ` ${name}="${escape(value)}"`;
}

function className(prefix: string, type: string): string {
return `${prefix}${type.replaceAll('_', '-').replace(/[^a-zA-Z0-9-]/g, '-')}`;
}

function textContent(node: BlockNode): string {
return (node.text ?? []).map((span) => span.text).join('');
}

function blockText(node: BlockNode, ctx: RenderContext): string {
return ctx.renderInline(node.text);
}

function blockChildren(node: BlockNode, ctx: RenderContext): string {
return node.children?.length ? ctx.renderBlocks(node.children) : '';
}

function blockBody(node: BlockNode, ctx: RenderContext): string {
return `${blockText(node, ctx)}${blockChildren(node, ctx)}`;
}

function clampHeadingLevel(value: unknown): 1 | 2 | 3 {
const level = Math.trunc(Number(value ?? 1));
if (level <= 1 || Number.isNaN(level)) return 1;
if (level >= 3) return 3;
return 2;
}

function firstAttr(attrs: Record<string, unknown> | undefined, names: string[]): unknown {
for (const name of names) {
const value = attrs?.[name];
if (value !== undefined && value !== null) return value;
}
return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
return typeof value === 'object' && value !== null;
}

function renderListItem(node: BlockNode, ctx: RenderContext): string {
return `<li${ctx.attr('class', ctx.classFor(node.type))}>${blockBody(node, ctx)}</li>`;
}

function renderTodo(node: BlockNode, ctx: RenderContext): string {
const checked = node.attrs?.checked === true;
return `<li${ctx.attr('class', ctx.classFor(node.type))}><input type="checkbox" disabled${checked ? ' checked' : ''}>${blockBody(node, ctx)}</li>`;
}

function renderTableCell(cell: BlockNode, tag: 'td' | 'th', ctx: RenderContext): string {
return `<${tag}${ctx.attr('class', ctx.classFor(cell.type))}>${blockBody(cell, ctx)}</${tag}>`;
}

function renderTableFromChildren(node: BlockNode, ctx: RenderContext): string {
const rows = node.children ?? [];
return rows
.map((row) => {
const cells = row.children ?? [];
const renderedCells = cells.length
? cells.map((cell) => renderTableCell(cell, cell.type === 'table_header_cell' ? 'th' : 'td', ctx)).join('')
: renderTableCell(row, row.type === 'table_header_cell' ? 'th' : 'td', ctx);
return `<tr${ctx.attr('class', ctx.classFor(row.type))}>${renderedCells}</tr>`;
})
.join('');
}

function renderTableFromAttrs(node: BlockNode, ctx: RenderContext): string | null {
const rawRows = node.attrs?.rows;
if (!Array.isArray(rawRows)) return null;
const rows = rawRows
.map((row) => {
const rawCells = Array.isArray(row) ? row : isRecord(row) && Array.isArray(row.cells) ? row.cells : [];
const cells = rawCells
.map((cell) => {
const text = isRecord(cell) && 'text' in cell ? cell.text : cell;
const isHeader = isRecord(cell) && cell.header === true;
const tag = isHeader ? 'th' : 'td';
return `<${tag}>${ctx.escape(text)}</${tag}>`;
})
.join('');
return `<tr>${cells}</tr>`;
})
.join('');
return rows;
}

function renderUnknownBlock(node: BlockNode, ctx: RenderContext): string {
if (ctx.options.onUnknownBlock) return ctx.options.onUnknownBlock(node, ctx);
return `<div${ctx.attr('class', ctx.classFor(node.type))}${ctx.attr('data-block-type', node.type)}>${blockBody(node, ctx)}</div>`;
}

export const defaultBlockRenderers: Record<string, BlockRenderer> = {
paragraph: (node, ctx) => `<p${ctx.attr('class', ctx.classFor('paragraph'))}>${blockBody(node, ctx)}</p>`,
heading: (node, ctx) => {
const level = clampHeadingLevel(node.attrs?.level);
return `<h${level}${ctx.attr('class', ctx.classFor('heading'))}>${blockBody(node, ctx)}</h${level}>`;
},
bulleted_list_item: renderListItem,
numbered_list_item: renderListItem,
to_do: renderTodo,
toggle: (node, ctx) => `<details${ctx.attr('class', ctx.classFor('toggle'))}><summary>${blockText(node, ctx)}</summary>${blockChildren(node, ctx)}</details>`,
quote: (node, ctx) => `<blockquote${ctx.attr('class', ctx.classFor('quote'))}>${blockBody(node, ctx)}</blockquote>`,
code: (node, ctx) => {
const language = firstAttr(node.attrs, ['language', 'lang']);
const languageClass = language ? `language-${String(language).replace(/[^a-zA-Z0-9_+-]/g, '-')}` : '';
return `<pre${ctx.attr('class', ctx.classFor('code'))}><code${ctx.attr('class', languageClass || undefined)}>${ctx.escape(textContent(node))}</code></pre>`;
},
divider: (_node, ctx) => `<hr${ctx.attr('class', ctx.classFor('divider'))}>`,
image: (node, ctx) => {
const src = firstAttr(node.attrs, ['src', 'url']);
const alt = firstAttr(node.attrs, ['alt']);
const caption = firstAttr(node.attrs, ['caption']);
const figcaption = caption ? `<figcaption>${ctx.escape(caption)}</figcaption>` : '';
return `<figure${ctx.attr('class', ctx.classFor('image'))}><img${ctx.attr('src', src)}${ctx.attr('alt', alt)}>${figcaption}</figure>`;
},
embed: (node, ctx) => {
const url = firstAttr(node.attrs, ['url', 'src', 'href']);
return `<div${ctx.attr('class', ctx.classFor('embed'))}${ctx.attr('data-embed-url', url)}><iframe${ctx.attr('src', url)} loading="lazy"></iframe></div>`;
},
raw_html: (node) => String(firstAttr(node.attrs, ['html', 'content', 'raw']) ?? textContent(node)),
table: (node, ctx) => {
const rows = renderTableFromAttrs(node, ctx) ?? renderTableFromChildren(node, ctx);
return `<table${ctx.attr('class', ctx.classFor('table'))}>${rows}</table>`;
},
};

export const defaultMarkRenderers: Record<string, MarkRenderer> = {
bold: (innerHtml) => `<strong>${innerHtml}</strong>`,
italic: (innerHtml) => `<em>${innerHtml}</em>`,
underline: (innerHtml) => `<u>${innerHtml}</u>`,
strikethrough: (innerHtml) => `<s>${innerHtml}</s>`,
code: (innerHtml, _mark, ctx) => `<code${ctx.attr('class', ctx.classFor('inline-code'))}>${innerHtml}</code>`,
link: (innerHtml, mark, ctx) => {
const href = mark.attrs?.href ?? '#';
const target = mark.attrs?.target ?? '_blank';
const rel = mark.attrs?.rel ?? 'noreferrer';
return `<a${ctx.attr('href', href)}${ctx.attr('target', target)}${ctx.attr('rel', rel)}>${innerHtml}</a>`;
},
highlight: (innerHtml) => `<mark>${innerHtml}</mark>`,
mention: (innerHtml, mark, ctx) => {
const id = mark.attrs?.id;
const href = mark.attrs?.href;
return `<span${ctx.attr('class', ctx.classFor('mention'))}${ctx.attr('data-mention-id', id)}${ctx.attr('data-mention-href', href)} data-atomic="true">${innerHtml}</span>`;
},
};

function sortMarks(marks: MarkInstance[]): MarkInstance[] {
return [...marks].sort((a, b) => {
const orderA = MARK_ORDER.get(a.type) ?? Number.MAX_SAFE_INTEGER;
const orderB = MARK_ORDER.get(b.type) ?? Number.MAX_SAFE_INTEGER;
if (orderA !== orderB) return orderA - orderB;
return a.type.localeCompare(b.type);
});
}

function createContext(options: HTMLSerializerOptions = {}): RenderContext {
const blocks = { ...defaultBlockRenderers, ...(options.blocks ?? {}) };
const marks = { ...defaultMarkRenderers, ...(options.marks ?? {}) };
const classPrefix = options.classPrefix ?? 'plim-';
let ctx: RenderContext;
ctx = {
renderBlock: (node: BlockNode): string => (blocks[node.type] ?? renderUnknownBlock)(node, ctx),
renderBlocks: (nodes: BlockNode[]): string => renderBlocks(nodes, ctx),
renderInline: (spans: TextSpan[] | undefined): string => (spans ?? []).map((span) => ctx.renderText(span)).join(''),
renderText: (span: TextSpan): string => sortMarks(span.marks ?? []).reduce((innerHtml, mark) => (marks[mark.type] ?? ((html: string) => html))(innerHtml, mark, ctx), escape(span.text)),
escape,
attr,
classFor: (type: string) => className(classPrefix, type),
classPrefix,
blocks,
marks,
options,
};
return ctx;
}

function renderBlocks(nodes: BlockNode[], ctx: RenderContext): string {
let html = '';
for (let index = 0; index < nodes.length; index++) {
const node = nodes[index]!;
if (node.type === 'bulleted_list_item' || node.type === 'numbered_list_item') {
const type = node.type;
const tag = type === 'bulleted_list_item' ? 'ul' : 'ol';
const items: string[] = [];
while (index < nodes.length && nodes[index]?.type === type) {
items.push(ctx.renderBlock(nodes[index]!));
index += 1;
}
index -= 1;
html += `<${tag}${ctx.attr('class', ctx.classFor(tag))}>${items.join('')}</${tag}>`;
} else {
html += ctx.renderBlock(node);
}
}
return html;
}

export function toDocumentNode(input: HTMLInput): DocumentNode {
if (Array.isArray(input)) return { type: 'doc', children: input };
if ('type' in input && input.type === 'doc') return input;
if ('doc' in input) return input.doc;
if ('data' in input && input.data?.state?.doc) return input.data.state.doc;
return { type: 'doc', children: [] };
}

export function serializeToHTML(input: HTMLInput, options: HTMLSerializerOptions = {}): string {
const ctx = createContext(options);
const fragment = ctx.renderBlocks(toDocumentNode(input).children);
if (!options.document) return fragment;
return `<!doctype html><html><body>${fragment}</body></html>`;
}
