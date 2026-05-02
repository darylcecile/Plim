import { describe, expect, it } from 'vitest';
import {
  asBlockId,
  asPageId,
  asWorkspaceId,
  createEmptyDocument,
  createParagraphBlock,
  richTextFromPlainText
} from '@plim/model';
import type { BlockId, BlockRecord, DocumentState, PageId, WorkspaceId } from '@plim/model';
import {
  buildMoveBlockOperations,
  adjacentEditableBlock,
  buildKeyboardReorderOperations,
  createCaretSelection,
  createInternalBlockDragPayload,
  createTextPoint,
  describeExternalDrop,
  makeRect,
  mapSelectionThroughOperation,
  requestedEffectFromModifiers,
  resolveDropTarget,
  selectBlockRange,
  validateSelection
} from '../src/index';
import type { BlockPositionDropTarget, LayoutRect, Operation } from '../src/index';

const clock = { now: (): string => '2025-01-01T00:00:00.000Z' };

interface Fixture {
  readonly state: DocumentState;
  readonly workspaceId: WorkspaceId;
  readonly pageId: PageId;
  readonly pageBlockId: BlockId;
  readonly a: BlockId;
  readonly b: BlockId;
  readonly c: BlockId;
}

function baseFixture(): Fixture {
  const workspaceId = asWorkspaceId('workspace');
  const pageId = asPageId('page');
  const pageBlockId = pageId as BlockId;
  const a = asBlockId('a');
  const b = asBlockId('b');
  const c = asBlockId('c');
  let state = createEmptyDocument({ workspaceId, pageId, title: 'Page', clock });
  const aBlock = createParagraphBlock({ id: a, workspaceId, parent: { kind: 'page', pageId }, text: 'Alpha', clock });
  const bBlock = createParagraphBlock({ id: b, workspaceId, parent: { kind: 'page', pageId }, text: 'Bravo', clock });
  const cBlock = createParagraphBlock({ id: c, workspaceId, parent: { kind: 'page', pageId }, text: 'Charlie', clock });
  const pageBlock = requireBlock(state, pageBlockId);
  state = {
    ...state,
    blocks: {
      ...state.blocks,
      [pageBlock.id]: { ...pageBlock, children: [a, b, c] },
      [a]: aBlock,
      [b]: bBlock,
      [c]: cBlock
    }
  };
  return { state, workspaceId, pageId, pageBlockId, a, b, c };
}

function nestedFixture(): Fixture {
  const fixture = baseFixture();
  const aBlock = requireBlock(fixture.state, fixture.a);
  const bBlock = requireBlock(fixture.state, fixture.b);
  const pageBlock = requireBlock(fixture.state, fixture.pageBlockId);
  const state: DocumentState = {
    ...fixture.state,
    blocks: {
      ...fixture.state.blocks,
      [pageBlock.id]: { ...pageBlock, children: [fixture.a, fixture.c] },
      [aBlock.id]: { ...aBlock, children: [fixture.b] },
      [bBlock.id]: { ...bBlock, parent: { kind: 'block', blockId: fixture.a } }
    }
  };
  return { ...fixture, state };
}

function requireBlock(state: DocumentState, blockId: BlockId): BlockRecord {
  const block = state.blocks[blockId];
  if (!block) throw new Error(`Missing block ${String(blockId)}`);
  return block;
}

function blockRect(blockId: BlockId, parentBlockId: BlockId | PageId, top: number, depth = 0, acceptsChildren = true): LayoutRect {
  const rect = makeRect(0, top, 400, 40);
  return {
    id: String(blockId),
    blockId,
    parentBlockId,
    blockType: 'paragraph',
    depth,
    rect,
    rowRect: rect,
    contentRect: makeRect(40 + depth * 24, top, 320, 40),
    visible: true,
    acceptsChildren
  };
}

describe('@plim/selection selection mapping', () => {
  it('maps caret offsets through rich text insertion and deletion', () => {
    const { state, a } = baseFixture();
    const caret = createCaretSelection(createTextPoint(a, 3, { affinity: 'after' }));
    const insert: Operation = {
      op: 'replace_rich_text',
      target: { blockId: a, field: { kind: 'block_data', key: 'richText' } },
      range: { startUtf16: 1, endUtf16: 1, textQuote: { exact: '' } },
      replacement: richTextFromPlainText('XX')
    };

    const inserted = mapSelectionThroughOperation(caret, state, insert, { revisionAfter: 2 });
    expect(inserted.status).toBe('mapped');
    expect(inserted.status === 'mapped' && inserted.selection.kind === 'caret' ? inserted.selection.point.offset : undefined).toBe(5);

    const deleteSelection = createCaretSelection(createTextPoint(a, 3, { affinity: 'nearest' }));
    const remove: Operation = {
      op: 'replace_rich_text',
      target: { blockId: a, field: { kind: 'block_data', key: 'richText' } },
      range: { startUtf16: 1, endUtf16: 4, textQuote: { exact: 'lph' } },
      replacement: []
    };
    const deleted = mapSelectionThroughOperation(deleteSelection, state, remove, { revisionAfter: 3 });
    expect(deleted.status).toBe('mapped');
    expect(deleted.status === 'mapped' && deleted.selection.kind === 'caret' ? deleted.selection.point.offset : undefined).toBe(1);
  });

  it('repairs a caret when its block is removed', () => {
    const { state, pageId, pageBlockId, a, b, c } = baseFixture();
    const pageBlock = requireBlock(state, pageBlockId);
    const blocks = { ...state.blocks };
    delete blocks[b];
    blocks[pageBlockId] = { ...pageBlock, children: [a, c] };
    const afterState: DocumentState = { ...state, blocks };
    const selection = createCaretSelection(createTextPoint(b, 2));
    const operation: Operation = { op: 'remove_child', parentId: pageId, childId: b, mode: 'delete' };

    const mapped = mapSelectionThroughOperation(selection, state, operation, { stateAfter: afterState });
    expect(mapped.status).toBe('repaired');
    expect(mapped.status === 'repaired' && mapped.selection.kind === 'caret' ? mapped.selection.point.blockId : undefined).toBe(a);
  });
});

describe('@plim/selection range derivation and validation', () => {
  it('derives normalized root and covered block ranges', () => {
    const { state, a, b, c } = baseFixture();
    const selection = selectBlockRange(state, a, c);
    expect(selection.rootBlockIds).toEqual([a, b, c]);
    expect(selection.coveredBlockIds).toEqual([a, b, c]);
  });

  it('removes descendant roots from block selections', () => {
    const { state, a, b } = nestedFixture();
    const selection = selectBlockRange(state, a, b);
    expect(selection.rootBlockIds).toEqual([a]);
    expect(selection.coveredBlockIds).toEqual([a, b]);
  });

  it('validates and repairs out-of-bounds caret offsets', () => {
    const { state, a } = baseFixture();
    const invalid = createCaretSelection(createTextPoint(a, 100));
    const result = validateSelection(state, invalid, { repair: true });
    expect(result.ok).toBe(false);
    expect(result.repaired?.kind).toBe('caret');
    expect(result.repaired?.kind === 'caret' ? result.repaired.point.offset : undefined).toBe(5);
  });
});

describe('@plim/selection keyboard navigation', () => {
  it('finds adjacent editable blocks in visible document order', () => {
    const { state, a, b } = baseFixture();
    const next = adjacentEditableBlock(state, a, 'next');
    expect(next?.blockId).toBe(b);
    expect(next?.boundary).toBe('start');
    expect(next?.point.offset).toBe(0);

    const previous = adjacentEditableBlock(state, b, 'previous');
    expect(previous?.blockId).toBe(a);
    expect(previous?.boundary).toBe('end');
    expect(previous?.point.offset).toBe(5);
  });

  it('builds keyboard reorder operations for sibling blocks', () => {
    const { state, a, b, c, pageId } = baseFixture();
    expect(buildKeyboardReorderOperations(state, b, 'previous')).toEqual([{
      op: 'move_block',
      blockId: b,
      newParentId: pageId,
      at: { kind: 'before', siblingId: a }
    }]);
    expect(buildKeyboardReorderOperations(state, b, 'next')).toEqual([{
      op: 'move_block',
      blockId: b,
      newParentId: pageId,
      at: { kind: 'after', siblingId: c }
    }]);
  });
});

describe('@plim/selection drag and drop', () => {
  it('resolves semantic block drop targets from pointer coordinates', () => {
    const { state, pageId, a, b } = baseFixture();
    const selection = selectBlockRange(state, a, a);
    const payload = createInternalBlockDragPayload('drag-a', selection, [a], { createdAt: 1 });
    const target = resolveDropTarget({
      state,
      pointer: { x: 80, y: 137 },
      rects: [blockRect(a, pageId, 0), blockRect(b, pageId, 100)],
      payload,
      rootParentId: pageId,
      canvasRect: makeRect(0, 0, 500, 500)
    });

    expect(target.kind).toBe('block-position');
    expect(target.kind === 'block-position' ? target.position : undefined).toBe('after');
    expect(target.kind === 'block-position' ? target.referenceBlockId : undefined).toBe(b);
  });

  it('rejects moving a parent into a descendant', () => {
    const { state, pageId, a, b } = nestedFixture();
    const selection = selectBlockRange(state, a, a);
    const payload = createInternalBlockDragPayload('drag-a', selection, [a], { createdAt: 1 });
    const target = resolveDropTarget({
      state,
      pointer: { x: 90, y: 120 },
      rects: [blockRect(a, pageId, 0), blockRect(b, a, 100, 1)],
      payload,
      rootParentId: pageId,
      canvasRect: makeRect(0, 0, 500, 500)
    });

    expect(target.kind).toBe('invalid');
    expect(target.kind === 'invalid' ? target.reason : undefined).toBe('cycle');
  });

  it('builds move operations that preserve order for drops after a sibling', () => {
    const { state, pageId, a, b, c } = baseFixture();
    const selection = selectBlockRange(state, a, b);
    const payload = createInternalBlockDragPayload('drag-ab', selection, [a, b], { createdAt: 1 });
    const target: BlockPositionDropTarget = {
      kind: 'block-position',
      parentId: pageId,
      referenceBlockId: c,
      position: 'after',
      depth: 0,
      indicatorRect: makeRect(0, 140, 400, 2),
      allowedEffects: ['move', 'copy']
    };

    const operations = buildMoveBlockOperations(payload, target, state);
    expect(operations.map(operation => operation.blockId)).toEqual([b, a]);
    expect(operations.every(operation => operation.op === 'move_block')).toBe(true);
    expect(operations[0]?.at).toEqual({ kind: 'after', siblingId: c });
  });

  it('classifies external drops and copy modifiers', () => {
    const descriptors = describeExternalDrop({
      uriList: 'https://example.com',
      html: '<a href="https://github.com">GitHub</a>',
      text: 'https://example.com'
    });
    expect(descriptors.some(descriptor => descriptor.kind === 'urls')).toBe(true);

    const { state, a } = baseFixture();
    const selection = selectBlockRange(state, a, a);
    const payload = createInternalBlockDragPayload('drag-a', selection, [a], { createdAt: 1 });
    expect(requestedEffectFromModifiers(payload, { altKey: true }, { platform: 'mac' })).toBe('copy');
  });
});
