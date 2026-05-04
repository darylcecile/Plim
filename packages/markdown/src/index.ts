import type { BlockDescriptor, BlockMarkdownContext, BlockNode, BlockPayload, DocumentNode, MarkInstance, TextSpan } from '@plim/core';
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

// ---------------------------------------------------------------------------
// Serialization: doc → markdown
// ---------------------------------------------------------------------------
//
// The inverse of `contentFromMarkdown`. Walks a `DocumentNode`, emitting
// commonmark-flavoured markdown line-by-line. Built-in block types have
// hardcoded serialization that mirrors the parser; custom blocks delegate
// to `descriptor.toMarkdown(payload, ctx)` if the descriptor was registered
// via the optional `blocks` argument. Blocks without a `toMarkdown` and
// without a built-in mapping fall through to plain-text inline-only output
// (one paragraph line per block) — sufficient for round-tripping content
// but not lossless for structural blocks.

const MARK_PRECEDENCE: Record<string, number> = {
	link: 0,
	code: 1,
	bold: 2,
	italic: 3,
	underline: 4,
	strikethrough: 5,
};

function escapeInlineText(text: string): string {
	// Escape characters that would otherwise be interpreted as markdown
	// syntax. We deliberately don't escape `>`, `#`, `-`, `*` etc. when they
	// appear mid-line — the parser only treats those as block markers when
	// line-anchored. Escaping every special char produces noisy output;
	// matching what `parseInline` actually consumes keeps round-trips clean.
	return text.replace(/([\\`*~\[\]])/g, '\\$1');
}

function serializeSpan(span: TextSpan): string {
	let text = escapeInlineText(span.text);
	const marks = (span.marks ?? []).slice().sort(
		(a, b) => (MARK_PRECEDENCE[b.type] ?? 99) - (MARK_PRECEDENCE[a.type] ?? 99),
	);
	for (const mark of marks) {
		switch (mark.type) {
			case 'bold':
				text = `**${text}**`;
				break;
			case 'italic':
				text = `*${text}*`;
				break;
			case 'code':
				// Code mark wins over text escaping: we re-emit the raw text
				// without backslash-escaping since markdown's code spans
				// preserve content verbatim. The inner text was escaped
				// above for non-code paths; redo it from the source.
				text = `\`${span.text}\``;
				break;
			case 'strikethrough':
				text = `~${text}~`;
				break;
			case 'underline':
				// Commonmark has no underline syntax; emit as HTML to round
				// trip rather than silently dropping the mark.
				text = `<u>${text}</u>`;
				break;
			case 'link': {
				const href = String(mark.attrs?.href ?? '');
				text = `[${text}](${href})`;
				break;
			}
			default:
				// Unknown mark — keep the text but drop the mark. Custom
				// marks needing markdown serialization should be handled by
				// the descriptor at the block level via `toMarkdown` (which
				// calls `serializeInline` and can intercept beforehand).
				break;
		}
	}
	return text;
}

function serializeInline(spans: TextSpan[]): string {
	return spans.map(serializeSpan).join('');
}

function blockToPayload(block: BlockNode): BlockPayload {
	const textContent = (block.text ?? []).map((s) => s.text).join('');
	return {
		id: block.id,
		type: block.type,
		attrs: block.attrs ?? {},
		content: [],
		textContent,
		isEmpty: !block.text || block.text.length === 0,
	};
}

function builtinToMarkdown(block: BlockNode, depth: number): string[] | null {
	const inline = serializeInline(block.text ?? []);
	switch (block.type) {
		case 'paragraph':
			return [inline];
		case 'heading': {
			const level = Math.min(3, Math.max(1, Number(block.attrs?.level ?? 1)));
			return [`${'#'.repeat(level)} ${inline}`];
		}
		case 'quote':
			return [`> ${inline}`];
		case 'bulleted_list_item':
			return [`- ${inline}`];
		case 'numbered_list_item':
			// We don't know our position among siblings here; the walker
			// passes the right index via `numberedRun` below by overriding
			// this. Default to `1.` for orphans.
			return [`1. ${inline}`];
		case 'to_do': {
			const checked = block.attrs?.checked ? 'x' : ' ';
			return [`- [${checked}] ${inline}`];
		}
		case 'divider':
			return ['---'];
		case 'code': {
			const lang = block.attrs?.language ? String(block.attrs.language) : '';
			const lines = (block.text?.[0]?.text ?? '').split('\n');
			return ['```' + lang, ...lines, '```'];
		}
		case 'toggle':
			// Toggle blocks have no commonmark equivalent; emit as bullet
			// + nested children handled by the walker.
			return [`- ${inline}`];
		case 'image': {
			const src = String(block.attrs?.src ?? '');
			const alt = String(block.attrs?.alt ?? '');
			return [`![${alt}](${src})`];
		}
		case 'embed':
		case 'raw_html':
		case 'table':
			// Structural blocks without a clean markdown equivalent. The
			// caller can override via `descriptor.toMarkdown` if a custom
			// representation is wanted; otherwise fall back to text.
			return inline ? [inline] : null;
		default:
			return null;
	}
}

const INDENT_PER_DEPTH = '  ';

function indentLine(line: string, depth: number): string {
	if (depth <= 0) return line;
	return INDENT_PER_DEPTH.repeat(depth) + line;
}

function walkBlock(
	block: BlockNode,
	depth: number,
	numberedIndex: number | null,
	descriptors: BlockDescriptor[] | undefined,
): string[] {
	const out: string[] = [];
	let lines: string[] | null = null;
	const desc = descriptors?.find((d) => d.name === block.type);
	if (desc?.toMarkdown) {
		const ctx: BlockMarkdownContext = { serializeInline, spans: block.text ?? [], depth };
		const result = desc.toMarkdown(blockToPayload(block), ctx);
		lines = Array.isArray(result) ? result : [result];
	} else {
		lines = builtinToMarkdown(block, depth);
		// Override numbered list index when known.
		if (lines && block.type === 'numbered_list_item' && numberedIndex != null && lines[0]) {
			lines[0] = lines[0].replace(/^1\./, `${numberedIndex}.`);
		}
	}
	if (lines == null) {
		// Last-resort fallback: plain inline text.
		lines = [serializeInline(block.text ?? [])];
	}
	for (const line of lines) out.push(indentLine(line, depth));
	if (block.children && block.children.length) {
		out.push(...walkBlocks(block.children, depth + 1, descriptors));
	}
	return out;
}

function walkBlocks(blocks: BlockNode[], depth: number, descriptors: BlockDescriptor[] | undefined): string[] {
	const out: string[] = [];
	let numberedRun = 0;
	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i]!;
		if (block.type === 'numbered_list_item') {
			numberedRun += 1;
			out.push(...walkBlock(block, depth, numberedRun, descriptors));
		} else {
			numberedRun = 0;
			out.push(...walkBlock(block, depth, null, descriptors));
		}
	}
	return out;
}

/**
 * Serialize a `DocumentNode` (or block array) to markdown. Custom block
 * descriptors with `toMarkdown` are honored; built-in types use commonmark-
 * flavoured output that round-trips through `contentFromMarkdown`. Blocks
 * are joined with single newlines (block-level boundaries); insert a blank
 * line between paragraphs explicitly via empty `paragraph` blocks if you
 * want commonmark-style paragraph spacing.
 */
export function contentToMarkdown(
	doc: DocumentNode | BlockNode[],
	options?: { blocks?: BlockDescriptor[] },
): string {
	const blocks = Array.isArray(doc) ? doc : doc.children;
	return walkBlocks(blocks, 0, options?.blocks).join('\n');
}
