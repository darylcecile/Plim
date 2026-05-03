import { type PlimBlock, type PlimContent, type PlimMarkRange, createBlock, createContent } from '@plim/core';

export function contentFromMarkdown(...parts: string[]): PlimContent {
  const source = parts.join('\n');
  const lines = source.split(/\r?\n/);
  const blocks: PlimBlock[] = [];
  let title = 'Untitled';

  for (const line of lines) {
    if (line.trim() === '') {
      continue;
    }

    const parsed = parseLine(line);
    if (blocks.length === 0 && parsed.type === 'heading1') {
      title = parsed.text;
      continue;
    }

    const inline = parseInlineMarks(parsed.text);
    blocks.push(createBlock(parsed.type, inline.text, { marks: inline.marks }));
  }

  return createContent(blocks.length > 0 ? blocks : [createBlock('paragraph', '')], title);
}

function parseLine(line: string): { type: string; text: string } {
  const trimmed = line.trim();
  if (trimmed === '---' || trimmed === '***') {
    return { type: 'divider', text: '' };
  }
  if (trimmed.startsWith('### ')) {
    return { type: 'heading3', text: trimmed.slice(4) };
  }
  if (trimmed.startsWith('## ')) {
    return { type: 'heading2', text: trimmed.slice(3) };
  }
  if (trimmed.startsWith('# ')) {
    return { type: 'heading1', text: trimmed.slice(2) };
  }
  if (/^[-*+]\s+/.test(trimmed)) {
    return { type: 'bulletedList', text: trimmed.replace(/^[-*+]\s+/, '') };
  }
  if (/^\d+\.\s+/.test(trimmed)) {
    return { type: 'numberedList', text: trimmed.replace(/^\d+\.\s+/, '') };
  }
  if (trimmed.startsWith('> ')) {
    return { type: 'quote', text: trimmed.slice(2) };
  }
  if (/^\[[ xX]\]\s+/.test(trimmed)) {
    return { type: 'todo', text: trimmed.replace(/^\[[ xX]\]\s+/, '') };
  }
  return { type: 'paragraph', text: line };
}

function parseInlineMarks(input: string): { text: string; marks: PlimMarkRange[] } {
  const marks: PlimMarkRange[] = [];
  let output = '';
  let cursor = 0;
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`|~([^~]+)~|\*([^*]+)\*)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(input))) {
    output += input.slice(cursor, match.index);
    const start = output.length;
    const text = match[2] ?? match[3] ?? match[4] ?? match[5] ?? '';
    output += text;
    const end = output.length;
    const mark = match[2] ? 'bold' : match[3] ? 'code' : match[4] ? 'strikethrough' : 'italic';
    marks.push({ mark, from: start, to: end });
    cursor = match.index + match[0].length;
  }

  output += input.slice(cursor);
  return { text: output, marks };
}
