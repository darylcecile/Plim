import type { BlockNode, DocumentNode } from './document.js';

/** A path identifies a block by ancestors' indices in `children` arrays. */
export type BlockPath = number[];

export type CursorPosition = {
	/** Path to the block. */
	path: BlockPath;
	/** Character offset inside the block's text. */
	offset: number;
};

export type Selection = {
	anchor: CursorPosition;
	head: CursorPosition;
};

export function samePath(a: BlockPath, b: BlockPath): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

export function comparePaths(a: BlockPath, b: BlockPath): number {
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		const av = a[i]!;
		const bv = b[i]!;
		if (av !== bv) return av < bv ? -1 : 1;
	}
	if (a.length === b.length) return 0;
	return a.length < b.length ? -1 : 1;
}

export function selectionIsEmpty(sel: Selection): boolean {
	return samePath(sel.anchor.path, sel.head.path) && sel.anchor.offset === sel.head.offset;
}

export function getBlockAt(doc: DocumentNode, path: BlockPath): BlockNode | null {
	let parent: { children?: BlockNode[] } = doc;
	let block: BlockNode | null = null;
	for (const idx of path) {
		const arr = parent.children;
		if (!arr || idx < 0 || idx >= arr.length) return null;
		block = arr[idx]!;
		parent = block;
	}
	return block;
}

export function getBlockParent(doc: DocumentNode, path: BlockPath): { parent: BlockNode | DocumentNode; index: number } | null {
	if (path.length === 0) return null;
	const parentPath = path.slice(0, -1);
	let parent: BlockNode | DocumentNode = doc;
	for (const idx of parentPath) {
		const arr: BlockNode[] | undefined = (parent as { children?: BlockNode[] }).children;
		if (!arr) return null;
		const next: BlockNode | undefined = arr[idx];
		if (!next) return null;
		parent = next;
	}
	return { parent, index: path[path.length - 1]! };
}

/** Return all leaf-level (no children) blocks in document order, with paths. */
export function flattenBlocks(doc: DocumentNode): { block: BlockNode; path: BlockPath }[] {
	const out: { block: BlockNode; path: BlockPath }[] = [];
	function walk(nodes: BlockNode[], parentPath: BlockPath) {
		for (let i = 0; i < nodes.length; i++) {
			const block = nodes[i]!;
			const path: BlockPath = [...parentPath, i];
			out.push({ block, path });
			if (block.children && block.children.length) walk(block.children, path);
		}
	}
	walk(doc.children, []);
	return out;
}

/** Move to the next block in document order (depth-first). */
export function nextBlockPath(doc: DocumentNode, path: BlockPath): BlockPath | null {
	const flat = flattenBlocks(doc);
	const idx = flat.findIndex((e) => samePath(e.path, path));
	if (idx < 0 || idx + 1 >= flat.length) return null;
	return flat[idx + 1]!.path;
}

export function prevBlockPath(doc: DocumentNode, path: BlockPath): BlockPath | null {
	const flat = flattenBlocks(doc);
	const idx = flat.findIndex((e) => samePath(e.path, path));
	if (idx <= 0) return null;
	return flat[idx - 1]!.path;
}

export function clonePath(path: BlockPath): BlockPath {
	return path.slice();
}

export function clonePosition(pos: CursorPosition): CursorPosition {
	return { path: clonePath(pos.path), offset: pos.offset };
}

export function cloneSelection(sel: Selection): Selection {
	return { anchor: clonePosition(sel.anchor), head: clonePosition(sel.head) };
}
