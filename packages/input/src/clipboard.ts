import type { BlockDataByType, BlockId, BlockRecord, BlockType, IdFactory, JsonObject, Operation, ParentRef, RichText, WorkspaceId } from '@plim/model';
import type { BlockFragment, ModelOperationPlan } from './types.js';

type FragmentSource = NonNullable<BlockFragment['source']>;
import { ensureUrl, isProbablyUrl, splitParagraphs } from './text-utils.js';

export interface FileDescriptorLike {
  name: string;
  type?: string;
  size?: number;
  lastModified?: number;
}

export interface ClipboardItemLike {
  kind?: string;
  type: string;
  getAsFile?: () => FileDescriptorLike | null;
}

export interface ClipboardDataLike {
  types?: readonly string[];
  files?: ArrayLike<FileDescriptorLike>;
  items?: ArrayLike<ClipboardItemLike>;
  getData(type: string): string;
}

export type PasteSource = 'internal' | 'files' | 'html' | 'markdown' | 'url' | 'plain-text' | 'empty';

export interface PasteParseResult {
  source: PasteSource;
  fragments: readonly BlockFragment[];
  files: readonly FileDescriptorLike[];
  plainText: string;
  html?: string;
  warnings: readonly string[];
}

export interface FragmentOperationOptions {
  workspaceId: WorkspaceId;
  parent: ParentRef;
  insertParentId: BlockId;
  idFactory?: IdFactory;
  clock?: { now(): string };
}

const internalMime = 'application/x-notion-next-fragment+json';

export function parseClipboardData(data: ClipboardDataLike): PasteParseResult {
  const files = filesFromClipboardData(data);
  const internal = readType(data, internalMime);
  if (internal.length > 0) {
    const parsed = parseInternalFragment(internal);
    if (parsed) return { source: 'internal', fragments: parsed, files, plainText: readType(data, 'text/plain'), warnings: [] };
  }
  if (files.length > 0) {
    return { source: 'files', fragments: files.map(fileToFragment), files, plainText: readType(data, 'text/plain'), warnings: [] };
  }
  const html = readType(data, 'text/html');
  if (html.trim().length > 0) {
    return { source: 'html', fragments: parseHtmlToFragments(html), files, plainText: readType(data, 'text/plain'), html: sanitizeHtml(html), warnings: [] };
  }
  const markdown = readType(data, 'text/markdown') || readType(data, 'text/x-markdown');
  if (markdown.trim().length > 0) {
    return { source: 'markdown', fragments: parseMarkdownToFragments(markdown), files, plainText: markdown, warnings: [] };
  }
  const uri = readType(data, 'text/uri-list').split(/\r?\n/u).find(line => line.trim().length > 0 && !line.startsWith('#')) ?? '';
  if (uri.trim().length > 0) {
    return { source: 'url', fragments: urlFragments(uri), files, plainText: uri, warnings: [] };
  }
  const plainText = readType(data, 'text/plain');
  if (plainText.trim().length === 0) return { source: 'empty', fragments: [], files, plainText, warnings: [] };
  if (isProbablyUrl(plainText)) return { source: 'url', fragments: urlFragments(plainText), files, plainText, warnings: [] };
  return { source: 'plain-text', fragments: parsePlainTextToFragments(plainText), files, plainText, warnings: [] };
}

export const parseDropData = parseClipboardData;

export function parsePlainTextToFragments(text: string): readonly BlockFragment[] {
  const normalized = text.replace(/\r\n?/gu, '\n');
  const paragraphs = splitParagraphs(normalized);
  if (paragraphs.length > 1) {
    return paragraphs.map(paragraph => paragraphFragment(paragraph, 'plain-text'));
  }
  return normalized.split('\n').map(line => paragraphFragment(line, 'plain-text'));
}

export function parseMarkdownToFragments(markdown: string): readonly BlockFragment[] {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n');
  const fragments: BlockFragment[] = [];
  let paragraph: string[] = [];
  let codeLines: string[] | null = null;
  let codeLanguage = 'plain text';

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      fragments.push(paragraphFragment(paragraph.join('\n'), 'markdown'));
      paragraph = [];
    }
  };

  for (const line of lines) {
    if (codeLines) {
      if (/^```\s*$/u.test(line)) {
        fragments.push({ type: 'code', text: codeLines.join('\n'), data: { language: codeLanguage }, source: 'markdown' });
        codeLines = null;
        codeLanguage = 'plain text';
      } else {
        codeLines.push(line);
      }
      continue;
    }

    const fence = line.match(/^```([\p{L}\p{N}_+-]*)\s*$/u);
    if (fence) {
      flushParagraph();
      codeLines = [];
      codeLanguage = fence[1] && fence[1].length > 0 ? fence[1] : 'plain text';
      continue;
    }

    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }

    const fragment = markdownLineToFragment(line);
    if (fragment) {
      flushParagraph();
      fragments.push(fragment);
    } else {
      paragraph.push(line);
    }
  }
  if (codeLines) fragments.push({ type: 'code', text: codeLines.join('\n'), data: { language: codeLanguage }, source: 'markdown' });
  flushParagraph();
  return fragments;
}

function markdownLineToFragment(line: string): BlockFragment | null {
  const heading = line.match(/^(#{1,3})\s+(.+)$/u);
  if (heading) return { type: `heading_${heading[1]?.length ?? 1}` as BlockType, text: heading[2] ?? '', source: 'markdown' };
  const task = line.match(/^\s*[-*+]\s+\[( |x|X)\]\s+(.+)$/u);
  if (task) return { type: 'to_do', text: task[2] ?? '', data: { checked: (task[1] ?? '').toLowerCase() === 'x' }, source: 'markdown' };
  const bullet = line.match(/^\s*[-*+]\s+(.+)$/u);
  if (bullet) return { type: 'bulleted_list_item', text: bullet[1] ?? '', source: 'markdown' };
  const numbered = line.match(/^\s*(\d+|[a-zA-Z]|[ivxlcdmIVXLCDM]+)\.\s+(.+)$/u);
  if (numbered) return { type: 'numbered_list_item', text: numbered[2] ?? '', source: 'markdown' };
  const quote = line.match(/^>\s+(.+)$/u);
  if (quote) return { type: 'quote', text: quote[1] ?? '', source: 'markdown' };
  if (/^\s*(?:---|\*\*\*|___)\s*$/u.test(line)) return { type: 'divider', source: 'markdown' };
  const image = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/u);
  if (image) return { type: 'image', text: image[1] ?? '', data: { url: ensureUrl(image[2] ?? ''), name: image[1] ?? '' }, source: 'markdown' };
  const equation = line.match(/^\$\$([^$]+)\$\$$/u);
  if (equation) return { type: 'equation', text: equation[1] ?? '', source: 'markdown' };
  return null;
}

export function parseHtmlToFragments(html: string): readonly BlockFragment[] {
  const sanitized = sanitizeHtml(html);
  const fragments: BlockFragment[] = [];
  const blockPattern = /<(h[123]|p|div|li|blockquote|pre|hr|img)\b([^>]*)>([\s\S]*?)<\/\1>|<(hr|img)\b([^>]*)\/?\s*>/giu;
  for (const match of sanitized.matchAll(blockPattern)) {
    const tag = (match[1] ?? match[4] ?? '').toLowerCase();
    const attrs = match[2] ?? match[5] ?? '';
    const body = match[3] ?? '';
    if (tag === 'hr') fragments.push({ type: 'divider', source: 'html' });
    else if (tag === 'img') fragments.push(imageFragmentFromAttrs(attrs, 'html'));
    else if (tag === 'h1' || tag === 'h2' || tag === 'h3') fragments.push({ type: `heading_${tag.slice(1)}` as BlockType, text: htmlToPlainText(body), source: 'html' });
    else if (tag === 'li') fragments.push(listFragmentFromHtml(body, 'html'));
    else if (tag === 'blockquote') fragments.push({ type: 'quote', text: htmlToPlainText(body), source: 'html' });
    else if (tag === 'pre') fragments.push({ type: 'code', text: htmlToPlainText(body), source: 'html' });
    else fragments.push(paragraphFragment(htmlToPlainText(body), 'html'));
  }
  if (fragments.length > 0) return fragments.filter(fragment => (fragment.text ?? '').length > 0 || fragment.type === 'divider' || isMediaType(fragment.type));
  const text = htmlToPlainText(sanitized);
  return text.trim().length > 0 ? parsePlainTextToFragments(text) : [];
}

export function sanitizeHtml(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/giu, '')
    .replace(/<style\b[\s\S]*?<\/style>/giu, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/giu, '')
    .replace(/\sstyle\s*=\s*("[^"]*"|'[^']*')/giu, '')
    .replace(/(href|src)\s*=\s*(['"])\s*javascript:[\s\S]*?\2/giu, '$1=$2#$2');
}

export function blockFragmentsToOperations(fragments: readonly BlockFragment[], options: FragmentOperationOptions): ModelOperationPlan {
  const operations: Operation[] = [];
  const rootBlockIds: BlockId[] = [];

  const create = (fragment: BlockFragment, parent: ParentRef, insertParentId: BlockId): BlockId => {
    const block = createBlockRecord({
      workspaceId: options.workspaceId,
      parent,
      type: fragment.type,
      data: fragmentToData(fragment),
      ...(options.idFactory ? { idFactory: options.idFactory } : {}),
      ...(options.clock ? { clock: options.clock } : {})
    });
    operations.push({ op: 'create_block', block });
    operations.push({ op: 'insert_child', parentId: insertParentId, childId: block.id, at: { kind: 'append' } });
    for (const child of fragment.children ?? []) create(child, { kind: 'block', blockId: block.id }, block.id);
    return block.id;
  };

  for (const fragment of fragments) rootBlockIds.push(create(fragment, options.parent, options.insertParentId));
  return { operations, rootBlockIds };
}


function createBlockRecord(options: {
  workspaceId: WorkspaceId;
  parent: ParentRef;
  type: BlockType;
  data: BlockDataByType[BlockType];
  idFactory?: IdFactory;
  clock?: { now(): string };
}): BlockRecord {
  const now = options.clock?.now() ?? new Date().toISOString();
  return {
    id: createLocalBlockId(options.idFactory),
    workspaceId: options.workspaceId,
    type: options.type,
    parent: options.parent,
    children: [],
    lifecycle: 'active',
    version: 1,
    data: options.data,
    createdAt: now,
    lastEditedAt: now
  };
}

function createLocalBlockId(idFactory?: IdFactory): BlockId {
  if (idFactory) return idFactory.createId('block') as BlockId;
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID() as BlockId;
  return `plim_block_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}` as BlockId;
}

function richTextFromPlainTextLocal(content: string): RichText {
  return content.length === 0 ? [] : [{ type: 'text', text: { content }, plainText: content, href: null }];
}

function fragmentToData(fragment: BlockFragment): BlockDataByType[BlockType] {
  const richText = fragment.richText ?? richTextFromPlainTextLocal(fragment.text ?? '');
  switch (fragment.type) {
    case 'paragraph':
    case 'heading_1':
    case 'heading_2':
    case 'heading_3':
    case 'bulleted_list_item':
    case 'toggle':
    case 'quote':
    case 'callout':
      return { richText } as BlockDataByType[BlockType];
    case 'numbered_list_item':
      return { richText, numbering: stringValue(fragment.data, 'numbering') ?? 'decimal' } as BlockDataByType[BlockType];
    case 'to_do':
      return { richText, checked: booleanValue(fragment.data, 'checked') ?? false } as BlockDataByType[BlockType];
    case 'code':
      return { richText, language: stringValue(fragment.data, 'language') ?? 'plain text', caption: [] } as BlockDataByType[BlockType];
    case 'equation':
      return { expression: fragment.text ?? stringValue(fragment.data, 'expression') ?? '' } as BlockDataByType[BlockType];
    case 'divider':
    case 'breadcrumb':
    case 'column_list':
      return {} as BlockDataByType[BlockType];
    case 'table_of_contents':
      return { color: 'default' } as BlockDataByType[BlockType];
    case 'image':
    case 'video':
    case 'audio':
    case 'file':
    case 'pdf':
      return { file: { type: 'external', url: stringValue(fragment.data, 'url') ?? localFileUrl(fragment) }, caption: richText } as BlockDataByType[BlockType];
    case 'bookmark':
    case 'embed':
      return { url: stringValue(fragment.data, 'url') ?? ensureUrl(fragment.text ?? 'example.invalid'), caption: richText } as BlockDataByType[BlockType];
    case 'link_preview':
      return { url: stringValue(fragment.data, 'url') ?? ensureUrl(fragment.text ?? 'example.invalid') } as BlockDataByType[BlockType];
    default:
      return defaultFragmentData(fragment, richText);
  }
}

function defaultFragmentData(fragment: BlockFragment, richText: RichText): BlockDataByType[BlockType] {
  if (fragment.type === 'template') return { richText, templateChildren: [] } as BlockDataByType[BlockType];
  if (fragment.type === 'synced_block') return { syncedFrom: null } as BlockDataByType[BlockType];
  if (fragment.type === 'table') return { hasColumnHeader: false, hasRowHeader: false, columnCount: 1 } as BlockDataByType[BlockType];
  if (fragment.type === 'table_row') return { cells: [richText] } as BlockDataByType[BlockType];
  if (fragment.type === 'column') return {} as BlockDataByType[BlockType];
  return { raw: fragment.data ?? {} } as BlockDataByType[BlockType];
}

function paragraphFragment(text: string, source: FragmentSource): BlockFragment {
  return { type: 'paragraph', text, source };
}

function urlFragments(urlText: string): readonly BlockFragment[] {
  const url = ensureUrl(urlText);
  return [{ type: 'bookmark', text: url, data: { url }, source: 'url' }];
}

function fileToFragment(file: FileDescriptorLike): BlockFragment {
  const type = fileBlockType(file);
  const data: JsonObject = {
    name: file.name,
    mimeType: file.type ?? '',
    sizeBytes: file.size ?? 0,
    url: `https://example.invalid/plim-local-file/${encodeURIComponent(file.name)}`
  };
  return { type, text: file.name, data, source: 'file' };
}

function fileBlockType(file: FileDescriptorLike): BlockType {
  const mime = file.type ?? '';
  const name = file.name.toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  return 'file';
}

function filesFromClipboardData(data: ClipboardDataLike): readonly FileDescriptorLike[] {
  const files: FileDescriptorLike[] = [];
  for (let index = 0; index < (data.files?.length ?? 0); index += 1) {
    const file = data.files?.[index];
    if (file) files.push(file);
  }
  for (let index = 0; index < (data.items?.length ?? 0); index += 1) {
    const item = data.items?.[index];
    if (item?.kind === 'file') {
      const file = item.getAsFile?.();
      if (file && !files.some(existing => existing.name === file.name && existing.size === file.size)) files.push(file);
    }
  }
  return files;
}

function readType(data: ClipboardDataLike, type: string): string {
  if (data.types && !data.types.includes(type)) return '';
  try {
    return data.getData(type) ?? '';
  } catch {
    return '';
  }
}

function parseInternalFragment(json: string): readonly BlockFragment[] | null {
  const parsed = safeParse(json);
  if (!isRecord(parsed)) return null;
  const blocks = parsed.blocks;
  if (Array.isArray(blocks)) return blocks.filter(isBlockFragment);
  return null;
}

function isBlockFragment(value: unknown): value is BlockFragment {
  return isRecord(value) && typeof value.type === 'string';
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function listFragmentFromHtml(body: string, source: FragmentSource): BlockFragment {
  const text = htmlToPlainText(body);
  if (/type=["']?checkbox/iu.test(body) || /\[\s?[xX]?\s?\]/u.test(text)) return { type: 'to_do', text: text.replace(/^\[\s?[xX]?\s?\]\s*/u, ''), source };
  return { type: 'bulleted_list_item', text, source };
}

function imageFragmentFromAttrs(attrs: string, source: FragmentSource): BlockFragment {
  const src = attr(attrs, 'src');
  const alt = attr(attrs, 'alt') ?? '';
  return { type: 'image', text: alt, data: { url: src ? ensureUrl(src) : 'https://example.invalid/image', name: alt }, source };
}

function attr(attrs: string, name: string): string | null {
  const pattern = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'iu');
  const match = attrs.match(pattern);
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? '') : null;
}

function htmlToPlainText(html: string): string {
  return decodeEntities(html
    .replace(/<br\s*\/?\s*>/giu, '\n')
    .replace(/<[^>]+>/gu, '')
    .replace(/\n{3,}/gu, '\n\n'))
    .trim();
}

function decodeEntities(value: string): string {
  const named: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (_full, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return named[lower] ?? `&${entity};`;
  });
}

function isMediaType(type: BlockType): boolean {
  return type === 'image' || type === 'video' || type === 'audio' || type === 'file' || type === 'pdf';
}

function stringValue(data: JsonObject | undefined, key: string): string | undefined {
  const value = data?.[key];
  return typeof value === 'string' ? value : undefined;
}

function booleanValue(data: JsonObject | undefined, key: string): boolean | undefined {
  const value = data?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function localFileUrl(fragment: BlockFragment): string {
  const name = stringValue(fragment.data, 'name') ?? fragment.text ?? 'file';
  return `https://example.invalid/plim-local-file/${encodeURIComponent(name)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
