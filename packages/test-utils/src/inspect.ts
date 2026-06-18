import {
	blockPlainText,
	getBlockAt,
	marksAtOffset,
	normalizeText,
} from '@plim/core';
import type { BlockNode, DocumentNode, EditorState, MarkInstance } from '@plim/core';

export type StateOrDoc = EditorState | DocumentNode;

export type NormalizedTextSpan = {
	text: string;
	marks: MarkInstance[];
};

export type NormalizedBlock = {
	type: string;
	attrs: Record<string, unknown> | null;
	text: NormalizedTextSpan[];
	children: NormalizedBlock[];
};

export type NormalizedDoc = {
	type: 'doc';
	children: NormalizedBlock[];
};

export function getBlock(stateOrDoc: StateOrDoc, path: number[]): BlockNode {
	const found = getBlockAt(toDoc(stateOrDoc), path);
	if (!found) throw new Error(`No block found at path ${formatPath(path)}`);
	return found;
}

export function plainText(stateOrDoc: StateOrDoc): string {
	const parts: string[] = [];
	walkBlocks(toDoc(stateOrDoc).children, (block) => {
		if (block.text) parts.push(blockPlainText(block));
	});
	return parts.join('\n');
}

export function blockText(block: BlockNode): string {
	return blockPlainText(block);
}

export function marksAt(stateOrDoc: StateOrDoc, path: number[], offset: number): MarkInstance[] {
	return marksAtOffset(getBlock(stateOrDoc, path).text, offset);
}

export function normalizeDoc(documentNode: DocumentNode): NormalizedDoc {
	return { type: 'doc', children: documentNode.children.map(normalizeBlock) };
}

export function debugTree(documentNode: DocumentNode): string {
	const lines = ['doc'];
	function walk(nodes: readonly BlockNode[], depth: number): void {
		for (const node of nodes) {
			const attrs = node.attrs ? ` ${JSON.stringify(node.attrs)}` : '';
			const text = node.text ? ` ${JSON.stringify(blockPlainText(node))}` : '';
			lines.push(`${'\t'.repeat(depth)}- ${node.type}#${node.id}${attrs}${text}`);
			if (node.children?.length) walk(node.children, depth + 1);
		}
	}
	walk(documentNode.children, 1);
	return lines.join('\n');
}

export function assertPlainText(stateOrDoc: StateOrDoc, expected: string): void {
	const actual = plainText(stateOrDoc);
	if (actual !== expected) throw new Error(`Expected plain text ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`);
}

export function assertBlockText(block: BlockNode, expected: string): void {
	const actual = blockText(block);
	if (actual !== expected) throw new Error(`Expected block text ${JSON.stringify(expected)}, received ${JSON.stringify(actual)} for ${block.type}#${block.id}.`);
}

export function assertBlockType(stateOrDoc: StateOrDoc, path: number[], expected: string): void {
	const block = getBlock(stateOrDoc, path);
	if (block.type !== expected) throw new Error(`Expected block at ${formatPath(path)} to be ${expected}, received ${block.type}.`);
}

export function assertHasMark(stateOrDoc: StateOrDoc, path: number[], offset: number, type: string, attrs?: Record<string, unknown>): void {
	const marks = marksAt(stateOrDoc, path, offset);
	if (!marks.some((candidate) => markMatches(candidate, type, attrs))) {
		throw new Error(`Expected mark ${type} at ${formatPath(path)}:${offset}, received [${marks.map((m) => m.type).join(', ')}].`);
	}
}

export function assertNoMark(stateOrDoc: StateOrDoc, path: number[], offset: number, type: string): void {
	const marks = marksAt(stateOrDoc, path, offset);
	if (marks.some((candidate) => candidate.type === type)) {
		throw new Error(`Expected no mark ${type} at ${formatPath(path)}:${offset}, but it was present.`);
	}
}

export function assertDocEquals(actual: DocumentNode, expected: DocumentNode): void {
	const normalizedActual = normalizeDoc(actual);
	const normalizedExpected = normalizeDoc(expected);
	if (JSON.stringify(normalizedActual) !== JSON.stringify(normalizedExpected)) {
		throw new Error(`Documents differ.\nActual:\n${debugTree(actual)}\nExpected:\n${debugTree(expected)}`);
	}
}

function toDoc(stateOrDoc: StateOrDoc): DocumentNode {
	return 'doc' in stateOrDoc ? stateOrDoc.doc : stateOrDoc;
}

function normalizeBlock(block: BlockNode): NormalizedBlock {
	return {
		type: block.type,
		attrs: block.attrs ? sortRecord(block.attrs) : null,
		text: normalizeText(block.text).map((span) => ({
			text: span.text,
			marks: (span.marks ?? []).map(cloneMark).sort(compareMarks),
		})),
		children: (block.children ?? []).map(normalizeBlock),
	};
}

function walkBlocks(nodes: readonly BlockNode[], visit: (block: BlockNode) => void): void {
	for (const node of nodes) {
		visit(node);
		if (node.children) walkBlocks(node.children, visit);
	}
}

function cloneMark(mark: MarkInstance): MarkInstance {
	return mark.attrs ? { type: mark.type, attrs: sortRecord(mark.attrs) } : { type: mark.type };
}

function compareMarks(a: MarkInstance, b: MarkInstance): number {
	const byType = a.type.localeCompare(b.type);
	if (byType !== 0) return byType;
	return JSON.stringify(a.attrs ?? {}).localeCompare(JSON.stringify(b.attrs ?? {}));
}

function markMatches(candidate: MarkInstance, type: string, attrs: Record<string, unknown> | undefined): boolean {
	if (candidate.type !== type) return false;
	if (!attrs) return true;
	return JSON.stringify(sortRecord(candidate.attrs ?? {})) === JSON.stringify(sortRecord(attrs));
}

function sortRecord(record: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function formatPath(path: readonly number[]): string {
	return `[${path.join(', ')}]`;
}
