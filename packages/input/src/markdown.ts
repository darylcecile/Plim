import { richTextFromPlainText, type BlockId, type BlockType, type JsonObject, type JsonValue, type Operation, type RichText, type TextAnnotations } from '@plim/model';
import type { CommandInvocation, MarkdownInputRule, EditorCommandContext, NotionColor } from './types.js';

export type MarkdownTransformKind = 'block-transform' | 'inline-transform' | 'command-invocation';

export interface MarkdownInputContext {
  text: string;
  caretOffset: number;
  blockId?: BlockId;
  blockType?: BlockType;
  composing?: boolean;
  trigger?: 'space' | 'enter' | 'character';
}

export interface MarkdownInsertionContext extends MarkdownInputContext {
  insertedText: string;
  selectionStart?: number;
  selectionEnd?: number;
}

export interface TextRange {
  start: number;
  end: number;
}

export interface MarkdownTransformResult {
  ruleId: string;
  kind: MarkdownTransformKind;
  range: TextRange;
  operations: readonly Operation[];
  command?: CommandInvocation;
  replacement?: RichText;
}

const excludedBlockTypes = new Set<BlockType>(['code', 'equation']);
const colorNames = ['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'] as const;

export function evaluateMarkdownInput(context: MarkdownInputContext): MarkdownTransformResult | null {
  if (context.composing) return null;
  if (context.blockType && excludedBlockTypes.has(context.blockType)) return null;
  const caret = clamp(context.caretOffset, 0, context.text.length);
  const before = context.text.slice(0, caret);
  const blockResult = evaluateLineStartRule(before, caret, context);
  if (blockResult) return blockResult;
  return evaluateInlineRule(before, caret, context);
}

export function evaluateMarkdownInputAfterInsertion(context: MarkdownInsertionContext): MarkdownTransformResult | null {
  const start = clamp(context.selectionStart ?? context.caretOffset, 0, context.text.length);
  const end = clamp(context.selectionEnd ?? context.caretOffset, start, context.text.length);
  const nextText = `${context.text.slice(0, start)}${context.insertedText}${context.text.slice(end)}`;
  const caretOffset = start + context.insertedText.length;
  const trigger = context.insertedText === ' '
    ? 'space'
    : context.insertedText === '\n'
      ? 'enter'
      : 'character';
  return evaluateMarkdownInput({
    ...context,
    text: nextText,
    caretOffset,
    trigger
  });
}

function evaluateLineStartRule(before: string, caret: number, context: MarkdownInputContext): MarkdownTransformResult | null {
  const lineStart = Math.max(before.lastIndexOf('\n') + 1, 0);
  const line = before.slice(lineStart);
  const leadingLength = line.match(/^\s*/u)?.[0].length ?? 0;
  const content = line.slice(leadingLength);
  const markerStart = lineStart + leadingLength;
  const markerEnd = caret;

  const heading = content.match(/^(#{1,3})\s$/u);
  if (heading) {
    const level = heading[1]?.length ?? 1;
    return blockTypeResult(`markdown.heading_${level}`, markerStart, markerEnd, context, `heading_${level}` as BlockType, {});
  }

  if (/^[-*+]\s$/u.test(content)) {
    return blockTypeResult('markdown.bulleted_list_item', markerStart, markerEnd, context, 'bulleted_list_item', {});
  }

  const todo = content.match(/^\[( |x|X)?\]\s$/u);
  if (todo) {
    return blockTypeResult('markdown.to_do', markerStart, markerEnd, context, 'to_do', { checked: (todo[1] ?? '').toLowerCase() === 'x' });
  }

  const numbered = content.match(/^(\d+|[a-zA-Z]|[ivxlcdmIVXLCDM]+)\.\s$/u);
  if (numbered) {
    const marker = numbered[1] ?? '1';
    const numbering = /^[a-z]$/u.test(marker) ? 'lower_alpha' : /^[ivxlcdm]+$/iu.test(marker) && !/^\d+$/u.test(marker) ? 'lower_roman' : 'decimal';
    return blockTypeResult('markdown.numbered_list_item', markerStart, markerEnd, context, 'numbered_list_item', { numbering });
  }

  if (/^>\s$/u.test(content)) {
    return blockTypeResult('markdown.toggle', markerStart, markerEnd, context, 'toggle', {});
  }

  if (/^"\s$/u.test(content)) {
    return blockTypeResult('markdown.quote', markerStart, markerEnd, context, 'quote', {});
  }

  if (/^---$/u.test(content)) {
    return blockTypeResult('markdown.divider', markerStart, markerEnd, context, 'divider', {});
  }

  const codeFence = content.match(/^```([\p{L}\p{N}_+-]*)$/u);
  if (codeFence) {
    const language = codeFence[1] && codeFence[1].length > 0 ? codeFence[1] : 'plain text';
    return blockTypeResult('markdown.code_fence', markerStart, markerEnd, context, 'code', { language });
  }

  const equation = content.match(/^(\$\$|\\\[)$/u);
  if (equation) {
    return blockTypeResult('markdown.equation_block', markerStart, markerEnd, context, 'equation', { expression: '' });
  }

  const color = content.match(/^\/(default|gray|brown|orange|yellow|green|blue|purple|pink|red)(?:\s+(background|highlight))?\s$/u);
  if (color) {
    const name = color[1] as (typeof colorNames)[number];
    const background = Boolean(color[2]) && name !== 'default';
    const suffix = background ? '_background' : '';
    return {
      ruleId: `markdown.color.${name}${suffix}`,
      kind: 'command-invocation',
      range: { start: markerStart, end: markerEnd },
      operations: [],
      command: { commandId: `color.${name}${suffix}`, source: 'markdown', args: { color: `${name}${suffix}` as NotionColor } }
    };
  }

  return null;
}

function evaluateInlineRule(before: string, caret: number, context: MarkdownInputContext): MarkdownTransformResult | null {
  return delimiterRule(before, caret, context, '**', { bold: true }, 'markdown.bold')
    ?? delimiterRule(before, caret, context, '`', { code: true }, 'markdown.inline_code')
    ?? delimiterRule(before, caret, context, '~', { strikethrough: true }, 'markdown.strikethrough')
    ?? delimiterRule(before, caret, context, '==', { color: 'yellow_background' }, 'markdown.highlight')
    ?? singleStarItalic(before, caret, context)
    ?? colorSpanRule(before, caret, context);
}

function delimiterRule(
  before: string,
  caret: number,
  context: MarkdownInputContext,
  delimiter: string,
  annotations: TextAnnotations,
  ruleId: string
): MarkdownTransformResult | null {
  if (!before.endsWith(delimiter)) return null;
  const endContent = caret - delimiter.length;
  const startDelimiter = before.lastIndexOf(delimiter, endContent - 1);
  if (startDelimiter < 0) return null;
  const contentStart = startDelimiter + delimiter.length;
  const content = before.slice(contentStart, endContent);
  if (content.length === 0 || /\n/u.test(content)) return null;
  return inlineResult(ruleId, startDelimiter, caret, content, annotations, context);
}

function singleStarItalic(before: string, caret: number, context: MarkdownInputContext): MarkdownTransformResult | null {
  if (!before.endsWith('*') || before.endsWith('**')) return null;
  const start = before.lastIndexOf('*', caret - 2);
  if (start < 0) return null;
  if (before.charAt(start - 1) === '*') return null;
  const content = before.slice(start + 1, caret - 1);
  if (content.length === 0 || /\n/u.test(content) || content.includes('*')) return null;
  return inlineResult('markdown.italic', start, caret, content, { italic: true }, context);
}

function colorSpanRule(before: string, caret: number, context: MarkdownInputContext): MarkdownTransformResult | null {
  const match = before.match(/::(default|gray|brown|orange|yellow|green|blue|purple|pink|red)(?:\s+(background))?\s+([^:]+)::$/u);
  if (!match || match.index === undefined) return null;
  const color = `${match[1]}${match[2] ? '_background' : ''}` as NotionColor;
  const content = match[3] ?? '';
  if (content.length === 0) return null;
  return inlineResult(`markdown.color_span.${color}`, match.index, caret, content, { color }, context);
}

function richTextFromAnnotatedText(content: string, annotations: TextAnnotations): RichText {
  return [{
    type: 'text',
    text: { content },
    annotations,
    plainText: content,
    href: null
  }];
}

function inlineResult(
  ruleId: string,
  start: number,
  end: number,
  content: string,
  annotations: TextAnnotations,
  context: MarkdownInputContext
): MarkdownTransformResult {
  const replacement = richTextFromAnnotatedText(content, annotations);
  const operations = context.blockId ? [replaceRichTextOperation(context.blockId, start, end, context.text.slice(start, end), replacement)] : [];
  return { ruleId, kind: 'inline-transform', range: { start, end }, operations, replacement };
}

function blockTypeResult(
  ruleId: string,
  start: number,
  end: number,
  context: MarkdownInputContext,
  type: BlockType,
  dataPatch: JsonObject
): MarkdownTransformResult {
  const patch = richTextBlockTypes.has(type)
    ? { ...dataPatch, richText: toJsonValue(richTextFromPlainText(context.text.slice(0, start) + context.text.slice(end))) }
    : dataPatch;
  const operations = context.blockId ? [{ op: 'set_block_type', blockId: context.blockId, type, dataPatch: patch, preservePreviousData: true } satisfies Operation] : [];
  return { ruleId, kind: 'block-transform', range: { start, end }, operations };
}

const richTextBlockTypes = new Set<BlockType>([
  'paragraph',
  'heading_1',
  'heading_2',
  'heading_3',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'toggle',
  'quote',
  'callout'
]);

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(item => toJsonValue(item));
  if (typeof value === 'object') {
    const object: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) object[key] = toJsonValue(item);
    }
    return object;
  }
  throw new TypeError('Markdown transform produced non-JSON rich text data.');
}

function replaceRichTextOperation(blockId: BlockId, start: number, end: number, exact: string, replacement: RichText): Operation {
  return {
    op: 'replace_rich_text',
    target: { blockId, field: { kind: 'block_data', key: 'richText' } },
    range: { startUtf16: start, endUtf16: end, textQuote: { exact } },
    replacement
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function createDefaultMarkdownInputRules<Context extends EditorCommandContext = EditorCommandContext>(): readonly MarkdownInputRule<Context>[] {
  return [
    markdownRule('markdown.heading_1', 'space', 'line-start', /^#$/u, 'block.turn.heading_1'),
    markdownRule('markdown.heading_2', 'space', 'line-start', /^##$/u, 'block.turn.heading_2'),
    markdownRule('markdown.heading_3', 'space', 'line-start', /^###$/u, 'block.turn.heading_3'),
    markdownRule('markdown.bullet', 'space', 'line-start', /^[-*+]$/u, 'block.turn.bulleted_list_item'),
    markdownRule('markdown.todo', 'space', 'line-start', /^\[(?: |x|X)?\]$/u, 'block.turn.to_do'),
    markdownRule('markdown.numbered', 'space', 'line-start', /^(?:\d+|[a-zA-Z]|[ivxlcdmIVXLCDM]+)\.$/u, 'block.turn.numbered_list_item'),
    markdownRule('markdown.toggle', 'space', 'line-start', /^>$/u, 'block.turn.toggle'),
    markdownRule('markdown.quote', 'space', 'line-start', /^"$/u, 'block.turn.quote'),
    markdownRule('markdown.divider', 'character', 'line-start', /^---$/u, 'block.insert.divider'),
    markdownRule('markdown.code_fence', 'enter', 'line-start', /^```[\p{L}\p{N}_+-]*$/u, 'media.insert.code'),
    markdownRule('markdown.equation', 'enter', 'line-start', /^(?:\$\$|\\\[)$/u, 'block.insert.equation')
  ];
}

function markdownRule<Context extends EditorCommandContext>(
  id: string,
  trigger: MarkdownInputRule<Context>['trigger'],
  scope: MarkdownInputRule<Context>['scope'],
  pattern: RegExp,
  commandId: string
): MarkdownInputRule<Context> {
  return {
    id,
    trigger,
    scope,
    pattern,
    excludeContexts: ['code', 'equation'],
    commandId,
    getArgs: (_match, ctx) => ({ blockIds: ctx.currentBlockIds?.() ?? [] })
  };
}
