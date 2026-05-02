import type {
  EquationSpan,
  MentionRef,
  MentionSpan,
  RichText,
  RichTextSpan,
  TextAnnotations,
  TextRangeAnchor,
  TextSpan,
  URLString
} from './types.js';

function normalizeString(value: string): string {
  return typeof value.normalize === 'function' ? value.normalize('NFC') : value;
}

function annotationsEqual(a?: TextAnnotations, b?: TextAnnotations): boolean {
  return Boolean(a?.bold) === Boolean(b?.bold)
    && Boolean(a?.italic) === Boolean(b?.italic)
    && Boolean(a?.strikethrough) === Boolean(b?.strikethrough)
    && Boolean(a?.underline) === Boolean(b?.underline)
    && Boolean(a?.code) === Boolean(b?.code)
    && (a?.color ?? 'default') === (b?.color ?? 'default');
}

function arraysEqual<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): boolean {
  if ((a?.length ?? 0) !== (b?.length ?? 0)) return false;
  if (!a || !b) return true;
  return a.every((value, index) => value === b[index]);
}

function mergeableTextSpans(a: TextSpan, b: TextSpan): boolean {
  return annotationsEqual(a.annotations, b.annotations)
    && (a.direction ?? 'auto') === (b.direction ?? 'auto')
    && (a.text.link?.url ?? null) === (b.text.link?.url ?? null)
    && arraysEqual(a.commentIds, b.commentIds)
    && JSON.stringify(a.extensions ?? {}) === JSON.stringify(b.extensions ?? {});
}

export function createTextSpan(content: string, options: {
  annotations?: TextAnnotations;
  link?: URLString | null;
  direction?: 'auto' | 'ltr' | 'rtl';
} = {}): TextSpan {
  const normalized = normalizeString(content);
  return {
    type: 'text',
    text: options.link ? { content: normalized, link: { url: options.link } } : { content: normalized },
    ...(options.annotations ? { annotations: options.annotations } : {}),
    ...(options.direction && options.direction !== 'auto' ? { direction: options.direction } : {}),
    plainText: normalized,
    href: options.link ?? null
  };
}

export function createMentionSpan(mention: MentionRef, plainText: string, annotations?: TextAnnotations): MentionSpan {
  return {
    type: 'mention',
    mention,
    ...(annotations ? { annotations } : {}),
    plainText: normalizeString(plainText),
    href: hrefForMention(mention)
  };
}

export function createEquationSpan(expression: string, annotations?: TextAnnotations): EquationSpan {
  return {
    type: 'equation',
    equation: { expression },
    ...(annotations ? { annotations } : {}),
    plainText: expression
  };
}

export function richTextFromPlainText(content: string, annotations?: TextAnnotations): RichText {
  const normalized = normalizeString(content);
  return normalized.length === 0 ? [] : [createTextSpan(normalized, annotations ? { annotations } : {})];
}

export function hrefForMention(mention: MentionRef): URLString | null {
  switch (mention.kind) {
    case 'external':
    case 'link_preview':
      return mention.url;
    default:
      return null;
  }
}

export function plainTextForSpan(span: RichTextSpan): string {
  switch (span.type) {
    case 'text':
      return span.text.content;
    case 'mention':
      return span.plainText ?? mentionFallback(span.mention);
    case 'equation':
      return span.plainText ?? span.equation.expression;
  }
}

export function plainTextFromRichText(richText: RichText): string {
  return richText.map(plainTextForSpan).join('');
}

function mentionFallback(mention: MentionRef): string {
  switch (mention.kind) {
    case 'date':
      return String(mention.date.start);
    case 'template':
      return `@${mention.template.kind}`;
    case 'external':
      return mention.label ?? mention.url;
    case 'link_preview':
      return mention.url;
    case 'user':
      return '@user';
    case 'page':
      return '@page';
    case 'database':
      return '@database';
    case 'data_source':
      return '@data_source';
    case 'view':
      return '@view';
    case 'file':
      return '@file';
  }
}

export function normalizeRichText(richText: RichText): RichText {
  const normalized: RichText = [];

  for (const span of richText) {
    const next = normalizeSpan(span);
    if (next.type === 'text' && next.text.content.length === 0) continue;

    const previous = normalized[normalized.length - 1];
    if (previous?.type === 'text' && next.type === 'text' && mergeableTextSpans(previous, next)) {
      previous.text.content += next.text.content;
      previous.plainText = previous.text.content;
      continue;
    }
    normalized.push(next);
  }

  return normalized;
}

function normalizeSpan(span: RichTextSpan): RichTextSpan {
  if (span.type === 'text') {
    const content = normalizeString(span.text.content);
    const href = span.text.link?.url ?? null;
    return {
      ...span,
      text: href ? { content, link: { url: href } } : { content },
      plainText: content,
      href
    };
  }
  if (span.type === 'mention') {
    return {
      ...span,
      plainText: normalizeString(span.plainText ?? mentionFallback(span.mention)),
      href: hrefForMention(span.mention)
    };
  }
  return {
    ...span,
    plainText: span.equation.expression
  };
}

export function replaceRichTextRange(richText: RichText, range: TextRangeAnchor, replacement: RichText): RichText {
  const start = Math.max(0, Math.min(range.startUtf16, range.endUtf16));
  const end = Math.max(start, Math.max(range.startUtf16, range.endUtf16));
  const normalizedReplacement = normalizeRichText(replacement);
  const before: RichText = [];
  const after: RichText = [];
  let offset = 0;

  for (const span of normalizeRichText(richText)) {
    const text = plainTextForSpan(span);
    const spanStart = offset;
    const spanEnd = offset + text.length;
    offset = spanEnd;

    if (spanEnd <= start) {
      before.push(span);
      continue;
    }
    if (spanStart >= end) {
      after.push(span);
      continue;
    }

    if (span.type === 'text') {
      const keepBefore = text.slice(0, Math.max(0, start - spanStart));
      const keepAfter = text.slice(Math.max(0, end - spanStart));
      if (keepBefore.length > 0) before.push({ ...span, text: { ...span.text, content: keepBefore }, plainText: keepBefore });
      if (keepAfter.length > 0) after.push({ ...span, text: { ...span.text, content: keepAfter }, plainText: keepAfter });
    }
  }

  return normalizeRichText([...before, ...normalizedReplacement, ...after]);
}

export function isValidRichTextRange(richText: RichText, range: TextRangeAnchor): boolean {
  const length = plainTextFromRichText(richText).length;
  return Number.isInteger(range.startUtf16)
    && Number.isInteger(range.endUtf16)
    && range.startUtf16 >= 0
    && range.endUtf16 >= range.startUtf16
    && range.endUtf16 <= length;
}
