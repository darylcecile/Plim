import { ModelError } from './errors.js';
import type { BlockId, BlockRecord, DocumentState, InsertPosition, PageId, ParentRef } from './types.js';

export interface BlockLocation {
  parentId: BlockId | PageId;
  index: number;
}

export function getBlock(state: DocumentState, blockId: BlockId): BlockRecord | undefined {
  return state.blocks[blockId];
}

export function requireBlock(state: DocumentState, blockId: BlockId): BlockRecord {
  const block = getBlock(state, blockId);
  if (!block) throw new ModelError('missing_record', `Block ${String(blockId)} does not exist`);
  return block;
}

export function getChildren(state: DocumentState, parentId: BlockId | PageId): BlockId[] {
  return [...(state.blocks[parentId as BlockId]?.children ?? [])];
}

export function resolveInsertIndex(children: readonly BlockId[], position: InsertPosition): number {
  switch (position.kind) {
    case 'append':
      return children.length;
    case 'index':
      return Math.max(0, Math.min(position.index, children.length));
    case 'before': {
      const index = children.indexOf(position.siblingId);
      if (index < 0) throw new ModelError('missing_record', `Sibling ${String(position.siblingId)} does not exist in parent`);
      return index;
    }
    case 'after': {
      const index = children.indexOf(position.siblingId);
      if (index < 0) throw new ModelError('missing_record', `Sibling ${String(position.siblingId)} does not exist in parent`);
      return index + 1;
    }
  }
}

export function findBlockLocation(state: DocumentState, childId: BlockId): BlockLocation | undefined {
  for (const block of Object.values(state.blocks)) {
    const index = block.children.indexOf(childId);
    if (index >= 0) return { parentId: block.id, index };
  }
  return undefined;
}

export function parentRefForContainer(state: DocumentState, parentId: BlockId | PageId): ParentRef {
  if (state.pages[parentId as PageId]) return { kind: 'page', pageId: parentId as PageId };
  if (state.blocks[parentId as BlockId]) return { kind: 'block', blockId: parentId as BlockId };
  throw new ModelError('invalid_parent', `Parent ${String(parentId)} does not exist`);
}

export function withBlock(state: DocumentState, block: BlockRecord): DocumentState {
  return {
    ...state,
    blocks: {
      ...state.blocks,
      [block.id]: block
    }
  };
}

export function updateBlock(state: DocumentState, blockId: BlockId, updater: (block: BlockRecord) => BlockRecord): DocumentState {
  const current = requireBlock(state, blockId);
  return withBlock(state, updater(current));
}

export function setChildren(state: DocumentState, parentId: BlockId | PageId, children: BlockId[]): DocumentState {
  return updateBlock(state, parentId as BlockId, block => ({
    ...block,
    children: [...children],
    version: block.version + 1
  }));
}

export function insertChildInState(state: DocumentState, parentId: BlockId | PageId, childId: BlockId, position: InsertPosition): DocumentState {
  const parent = requireBlock(state, parentId as BlockId);
  const child = requireBlock(state, childId);
  const existingWithoutChild = parent.children.filter(id => id !== childId);
  const index = resolveInsertIndex(existingWithoutChild, position);
  const nextChildren = [...existingWithoutChild.slice(0, index), childId, ...existingWithoutChild.slice(index)];
  const parentRef = parentRefForContainer(state, parentId);
  const blocks = {
    ...state.blocks,
    [parent.id]: { ...parent, children: nextChildren, version: parent.version + 1 },
    [child.id]: { ...child, parent: parentRef, version: child.version + 1 }
  };
  return { ...state, blocks };
}

export function removeChildFromState(state: DocumentState, parentId: BlockId | PageId, childId: BlockId): DocumentState {
  const parent = requireBlock(state, parentId as BlockId);
  if (!parent.children.includes(childId)) return state;
  return setChildren(state, parentId, parent.children.filter(id => id !== childId));
}

export function moveBlockInState(state: DocumentState, blockId: BlockId, newParentId: BlockId | PageId, position: InsertPosition): DocumentState {
  const currentLocation = findBlockLocation(state, blockId);
  const withoutCurrent = currentLocation
    ? removeChildFromState(state, currentLocation.parentId, blockId)
    : state;
  return insertChildInState(withoutCurrent, newParentId, blockId, position);
}

export function getDescendantBlockIds(state: DocumentState, blockId: BlockId): BlockId[] {
  const descendants: BlockId[] = [];
  const visit = (id: BlockId): void => {
    const block = state.blocks[id];
    if (!block) return;
    for (const childId of block.children) {
      descendants.push(childId);
      visit(childId);
    }
  };
  visit(blockId);
  return descendants;
}

export function isAncestorOf(state: DocumentState, ancestorId: BlockId, blockId: BlockId): boolean {
  let current = state.blocks[blockId];
  const seen = new Set<BlockId>();
  while (current) {
    if (seen.has(current.id)) return false;
    seen.add(current.id);
    if (current.parent.kind === 'block' && current.parent.blockId === ancestorId) return true;
    if (current.parent.kind === 'page' && current.parent.pageId === ancestorId) return true;
    const parentId = current.parent.kind === 'block'
      ? current.parent.blockId
      : current.parent.kind === 'page'
        ? current.parent.pageId
        : undefined;
    current = parentId ? state.blocks[parentId as BlockId] : undefined;
  }
  return false;
}

export function getBlockPath(state: DocumentState, blockId: BlockId): BlockId[] {
  const path: BlockId[] = [];
  let current = state.blocks[blockId];
  const seen = new Set<BlockId>();
  while (current && !seen.has(current.id)) {
    path.unshift(current.id);
    seen.add(current.id);
    const parentId = current.parent.kind === 'block'
      ? current.parent.blockId
      : current.parent.kind === 'page'
        ? current.parent.pageId
        : undefined;
    current = parentId ? state.blocks[parentId as BlockId] : undefined;
  }
  return path;
}

export function getBlockIndex(state: DocumentState, blockId: BlockId): number {
  return findBlockLocation(state, blockId)?.index ?? -1;
}
