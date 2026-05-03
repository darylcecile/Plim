import type { BlockNode, DocumentNode, MarkInstance, TextSpan } from '@plim/core';
import { newId, normalizeText } from '@plim/core';

// Inline parsing: handles **bold**, *italic*, `code`, ~strike~, and [text](url).
function parseInline(line: string): TextSpan[] {
	const out: TextSpan[] = [];
	let i = 0;
	const len = line.length;
	let buf = '';
	const marks: MarkInstance[] = [];

	const push = (text: string, extra?: MarkInstance[]) => {
		if (!text) return;
		const m = [...marks, ...(extra ?? [])];
		out.push(m.length ? { text, marks: m } : { text });
	};

	while (i < len) {
		const ch = line[i]!;
		// strong **
		if (ch === '*' && line[i + 1] === '*') {
			const end = line.indexOf('**', i + 2);
			if (end > i + 2) {
				push(buf);
				buf = '';
				marks.push({ type: 'bold' });
				const inner = parseInline(line.slice(i + 2, end));
				for (const s of inner) {
					out.push({ text: s.text, marks: [...(s.marks ?? []), { type: 'bold' }] });
				}
				marks.pop();
				i = end + 2;
				continue;
			}
		}
		// italic *…*
		if (ch === '*') {
			const end = line.indexOf('*', i + 1);
			if (end > i + 1) {
				push(buf);
				buf = '';
				const inner = parseInline(line.slice(i + 1, end));
				for (const s of inner) {
					out.push({ text: s.text, marks: [...(s.marks ?? []), { type: 'italic' }] });
				}
				i = end + 1;
				continue;
			}
		}
		// code `…`
		if (ch === '`') {
			const end = line.indexOf('`', i + 1);
			if (end > i + 1) {
				push(buf);
				buf = '';
				out.push({ text: line.slice(i + 1, end), marks: [{ type: 'code' }] });
				i = end + 1;
				continue;
			}
		}
		// strike ~…~
		if (ch === '~') {
			const end = line.indexOf('~', i + 1);
			if (end > i + 1) {
				push(buf);
				buf = '';
				out.push({ text: line.slice(i + 1, end), marks: [{ type: 'strikethrough' }] });
				i = end + 1;
				continue;
			}
		}
		// link [text](url)
		if (ch === '[') {
			const close = line.indexOf(']', i + 1);
			if (close > i + 1 && line[close + 1] === '(') {
				const urlEnd = line.indexOf(')', close + 2);
				if (urlEnd > close + 2) {
					push(buf);
					buf = '';
					const text = line.slice(i + 1, close);
					const href = line.slice(close + 2, urlEnd);
					out.push({ text, marks: [{ type: 'link', attrs: { href } }] });
					i = urlEnd + 1;
					continue;
				}
			}
		}
		buf += ch;
		i += 1;
	}
	if (buf) push(buf);
	return normalizeText(out);
}

function parseBlock(line: string): BlockNode {
	// headings
	const h = /^(#{1,3})\s+(.*)$/.exec(line);
	if (h) {
		const level = h[1]!.length;
		return { id: newId(), type: 'heading', attrs: { level }, text: parseInline(h[2]!) };
	}
	if (/^>\s+/.test(line)) {
		return { id: newId(), type: 'quote', text: parseInline(line.replace(/^>\s+/, '')) };
	}
	if (/^[-*+]\s+\[\s?\]\s+/.test(line)) {
		return { id: newId(), type: 'to_do', attrs: { checked: false }, text: parseInline(line.replace(/^[-*+]\s+\[\s?\]\s+/, '')) };
	}
	if (/^[-*+]\s+\[x\]\s+/i.test(line)) {
		return { id: newId(), type: 'to_do', attrs: { checked: true }, text: parseInline(line.replace(/^[-*+]\s+\[x\]\s+/i, '')) };
	}
	if (/^[-*+]\s+/.test(line)) {
		return { id: newId(), type: 'bulleted_list_item', text: parseInline(line.replace(/^[-*+]\s+/, '')) };
	}
	if (/^\d+\.\s+/.test(line)) {
		return { id: newId(), type: 'numbered_list_item', text: parseInline(line.replace(/^\d+\.\s+/, '')) };
	}
	if (/^\[\s?\]\s+/.test(line)) {
		return { id: newId(), type: 'to_do', attrs: { checked: false }, text: parseInline(line.replace(/^\[\s?\]\s+/, '')) };
	}
	if (/^\[x\]\s+/i.test(line)) {
		return { id: newId(), type: 'to_do', attrs: { checked: true }, text: parseInline(line.replace(/^\[x\]\s+/i, '')) };
	}
	if (line.trim() === '---') {
		return { id: newId(), type: 'divider' };
	}
	return { id: newId(), type: 'paragraph', text: parseInline(line) };
}

export function contentFromMarkdown(...lines: string[]): DocumentNode {
	const blocks: BlockNode[] = [];
	let i = 0;
	while (i < lines.length) {
		const raw = lines[i] ?? '';
		// fenced code
		if (raw.startsWith('```')) {
			const lang = raw.slice(3).trim();
			const buf: string[] = [];
			i += 1;
			while (i < lines.length && !(lines[i] ?? '').startsWith('```')) {
				buf.push(lines[i] ?? '');
				i += 1;
			}
			i += 1; // skip closing fence
			blocks.push({
				id: newId(),
				type: 'code',
				...(lang ? { attrs: { language: lang } } : {}),
				text: buf.length ? [{ text: buf.join('\n') }] : [],
			});
			continue;
		}
		if (raw.length === 0) {
			blocks.push({ id: newId(), type: 'paragraph', text: [] });
			i += 1;
			continue;
		}
		blocks.push(parseBlock(raw));
		i += 1;
	}
	if (blocks.length === 0) blocks.push({ id: newId(), type: 'paragraph', text: [] });
	return { type: 'doc', children: blocks };
}
