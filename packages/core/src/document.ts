// Core document model: Block tree with rich-text leaves.
// Each block has an id, type, attrs, and either a `text` array (for text blocks)
// or `children` array (for container/atomic blocks). Text blocks can also have
// children when the block is `nestable`.

export type MarkInstance = {
	type: string;
	attrs?: Record<string, unknown>;
};

/** A run of text with an optional set of marks. */
export type TextSpan = {
	text: string;
	marks?: MarkInstance[];
};

export type BlockNode = {
	id: string;
	type: string;
	attrs?: Record<string, unknown>;
	/** Inline content for text-bearing blocks. */
	text?: TextSpan[];
	/** Nested blocks (e.g. list items in a list). */
	children?: BlockNode[];
};

export type DocumentNode = {
	type: 'doc';
	children: BlockNode[];
};

let __id = 0;
export function newId(prefix = 'b'): string {
	__id += 1;
	return `${prefix}_${Math.random().toString(36).slice(2, 8)}${__id.toString(36)}`;
}

export function emptyText(): TextSpan[] {
	return [];
}

export function blockTextLength(block: BlockNode): number {
	if (!block.text) return 0;
	let n = 0;
	for (const span of block.text) n += span.text.length;
	return n;
}

export function blockPlainText(block: BlockNode): string {
	if (!block.text) return '';
	let out = '';
	for (const span of block.text) out += span.text;
	return out;
}

/** Normalize: merge adjacent spans with identical mark sets, drop empty spans. */
export function normalizeText(spans: TextSpan[] | undefined): TextSpan[] {
	if (!spans || spans.length === 0) return [];
	const out: TextSpan[] = [];
	for (const s of spans) {
		if (s.text.length === 0) continue;
		const last = out[out.length - 1];
		if (last && marksEqual(last.marks, s.marks)) {
			last.text += s.text;
		} else {
			out.push({ text: s.text, ...(s.marks && s.marks.length ? { marks: s.marks.map(cloneMark) } : {}) });
		}
	}
	return out;
}

function cloneMark(m: MarkInstance): MarkInstance {
	return m.attrs ? { type: m.type, attrs: { ...m.attrs } } : { type: m.type };
}

export function marksEqual(a: MarkInstance[] | undefined, b: MarkInstance[] | undefined): boolean {
	const ax = a ?? [];
	const bx = b ?? [];
	if (ax.length !== bx.length) return false;
	const sort = (arr: MarkInstance[]) => [...arr].sort((x, y) => x.type.localeCompare(y.type));
	const sa = sort(ax);
	const sb = sort(bx);
	for (let i = 0; i < sa.length; i++) {
		const ma = sa[i]!;
		const mb = sb[i]!;
		if (ma.type !== mb.type) return false;
		if (JSON.stringify(ma.attrs ?? {}) !== JSON.stringify(mb.attrs ?? {})) return false;
	}
	return true;
}

export function hasMark(spans: TextSpan[] | undefined, from: number, to: number, type: string): boolean {
	if (!spans || from === to) return false;
	let pos = 0;
	for (const span of spans) {
		const start = pos;
		const end = pos + span.text.length;
		const overlap = !(end <= from || start >= to);
		if (overlap) {
			if (!span.marks?.some((m) => m.type === type)) return false;
		}
		pos = end;
	}
	return true;
}

/** Slice spans between from..to. */
export function sliceText(spans: TextSpan[] | undefined, from: number, to: number): TextSpan[] {
	if (!spans) return [];
	const out: TextSpan[] = [];
	let pos = 0;
	for (const span of spans) {
		const start = pos;
		const end = pos + span.text.length;
		if (end <= from) {
			pos = end;
			continue;
		}
		if (start >= to) break;
		const a = Math.max(0, from - start);
		const b = Math.min(span.text.length, to - start);
		const piece = span.text.slice(a, b);
		if (piece.length > 0) {
			out.push({ text: piece, ...(span.marks ? { marks: span.marks.map(cloneMark) } : {}) });
		}
		pos = end;
	}
	return normalizeText(out);
}

export function replaceTextRange(
	spans: TextSpan[] | undefined,
	from: number,
	to: number,
	insert: TextSpan[] = []
): TextSpan[] {
	const left = sliceText(spans, 0, from);
	const right = sliceText(spans, to, Number.MAX_SAFE_INTEGER);
	return normalizeText([...left, ...insert, ...right]);
}

export function applyMarkToRange(
	spans: TextSpan[] | undefined,
	from: number,
	to: number,
	mark: MarkInstance,
	mode: 'add' | 'remove'
): TextSpan[] {
	if (!spans || from === to) return spans ?? [];
	const out: TextSpan[] = [];
	let pos = 0;
	for (const span of spans) {
		const start = pos;
		const end = pos + span.text.length;
		if (end <= from || start >= to) {
			out.push(span);
		} else {
			const before = span.text.slice(0, Math.max(0, from - start));
			const middle = span.text.slice(Math.max(0, from - start), Math.min(span.text.length, to - start));
			const after = span.text.slice(Math.min(span.text.length, to - start));
			const baseMarks = span.marks?.map(cloneMark) ?? [];
			if (before) out.push({ text: before, ...(baseMarks.length ? { marks: baseMarks.map(cloneMark) } : {}) });
			if (middle) {
				let nextMarks = baseMarks.filter((m) => m.type !== mark.type);
				if (mode === 'add') nextMarks.push(cloneMark(mark));
				out.push({ text: middle, ...(nextMarks.length ? { marks: nextMarks } : {}) });
			}
			if (after) out.push({ text: after, ...(baseMarks.length ? { marks: baseMarks.map(cloneMark) } : {}) });
		}
		pos = end;
	}
	return normalizeText(out);
}
