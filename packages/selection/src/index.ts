import { plainTextFromRichText } from '@plim/model';
import type {
  BlockId,
  BlockRecord,
  BlockType,
  DocumentState,
  InsertPosition,
  MoveBlockOperation,
  Operation,
  PageId,
  PropertyId,
  RichText,
  RichTextFieldPath,
  RichTextTarget,
  TextRangeAnchor,
  TransactionRecord,
  ViewId
} from '@plim/model';

export type {
  BlockId,
  BlockRecord,
  BlockType,
  DocumentState,
  Operation,
  PageId,
  PropertyId,
  RichText,
  TransactionRecord,
  ViewId
} from '@plim/model';

export type ClientRevision = number;
export type SelectionDirection = 'forward' | 'backward';
export type TextAffinity = 'before' | 'after' | 'inside' | 'nearest';
export type TraversalScope = 'page' | 'toggle' | 'column' | 'database-view' | 'selection-overlay';
export type DropEffect = 'move' | 'copy' | 'link';
export type BlockNavigationDirection = 'previous' | 'next';
export type BlockBoundary = 'start' | 'end';

export interface RichTextPath {
  readonly parts: readonly (string | number)[];
}

export interface TextPoint {
  readonly blockId: BlockId;
  readonly path: RichTextPath;
  readonly offset: number;
  readonly affinity: TextAffinity;
  readonly revision: ClientRevision;
  readonly visualX?: number;
}

export interface BlockPoint {
  readonly blockId: BlockId;
  readonly parentId?: BlockId | PageId;
  readonly side: 'before' | 'after' | 'inside-start' | 'inside-end';
  readonly depth?: number;
  readonly revision: ClientRevision;
}

export interface CellPoint {
  readonly ownerBlockId: BlockId;
  readonly rowId: BlockId | PageId;
  readonly columnId: PropertyId | string;
  readonly kind: 'simple-table' | 'database-table' | 'database-board' | 'database-gallery' | 'database-list';
}

export type SelectionState =
  | NoneSelection
  | CaretSelection
  | RichTextRangeSelection
  | BlockSelection
  | MixedSelection
  | CellSelection
  | GapSelection;

export interface NoneSelection {
  readonly kind: 'none';
  readonly reason?: 'blur' | 'modal' | 'readonly';
}

export interface CaretSelection {
  readonly kind: 'caret';
  readonly point: TextPoint;
  readonly preferredBlockId?: BlockId;
}

export interface RichTextRangeSelection {
  readonly kind: 'rich_text_range';
  readonly anchor: TextPoint;
  readonly focus: TextPoint;
  readonly direction: SelectionDirection;
}

export interface BlockSelection {
  readonly kind: 'block';
  readonly anchorBlockId: BlockId;
  readonly focusBlockId: BlockId;
  readonly rootBlockIds: readonly BlockId[];
  readonly coveredBlockIds: readonly BlockId[];
  readonly traversalScope: TraversalScope;
}

export interface MixedSelection {
  readonly kind: 'mixed';
  readonly anchor: TextPoint;
  readonly focus: TextPoint;
  readonly coveredBlockIds: readonly BlockId[];
  readonly fullySelectedBlockIds: readonly BlockId[];
  readonly direction: SelectionDirection;
}

export interface CellSelection {
  readonly kind: 'cell';
  readonly ownerBlockId: BlockId;
  readonly viewId?: ViewId;
  readonly anchor: CellPoint;
  readonly focus: CellPoint;
  readonly selectedRowIds: readonly (BlockId | PageId)[];
  readonly selectedColumnIds: readonly (PropertyId | string)[];
}

export interface GapSelection {
  readonly kind: 'gap';
  readonly target: DropTarget;
  readonly initiatedBy: 'keyboard' | 'pointer' | 'program';
}

export interface SelectionFocusState {
  readonly focused: boolean;
  readonly mode: 'editor' | 'nested' | 'menu' | 'modal' | 'blurred';
  readonly selection: SelectionState;
  readonly storedSelection?: SelectionState;
  readonly reason?: string;
}

export interface EditableBlockNavigationTarget {
  readonly blockId: BlockId;
  readonly boundary: BlockBoundary;
  readonly point: TextPoint;
}

export const DEFAULT_RICH_TEXT_PATH: RichTextPath = Object.freeze({ parts: Object.freeze(['data', 'richText'] as const) });

export const packageMetadata = {
  name: '@plim/selection',
  status: 'implemented',
  implementsRuntime: true,
  dependsOn: ['@plim/model']
} as const;

export function createTextPoint(
  blockId: BlockId,
  offset: number,
  options: {
    path?: RichTextPath;
    affinity?: TextAffinity;
    revision?: ClientRevision;
    visualX?: number;
  } = {}
): TextPoint {
  return {
    blockId,
    path: options.path ?? DEFAULT_RICH_TEXT_PATH,
    offset,
    affinity: options.affinity ?? 'nearest',
    revision: options.revision ?? 0,
    ...(options.visualX !== undefined ? { visualX: options.visualX } : {})
  };
}

export function createCaretSelection(point: TextPoint, preferredBlockId?: BlockId): CaretSelection {
  return {
    kind: 'caret',
    point,
    ...(preferredBlockId !== undefined ? { preferredBlockId } : {})
  };
}

export function createRichTextRangeSelection(anchor: TextPoint, focus: TextPoint, state?: DocumentState): RichTextRangeSelection {
  return {
    kind: 'rich_text_range',
    anchor,
    focus,
    direction: compareTextPoints(anchor, focus, state) <= 0 ? 'forward' : 'backward'
  };
}

export function createMixedSelection(
  anchor: TextPoint,
  focus: TextPoint,
  state: DocumentState,
  options: { traversalScopeRootId?: BlockId | PageId } = {}
): MixedSelection {
  const direction = compareTextPoints(anchor, focus, state) <= 0 ? 'forward' : 'backward';
  const ordered = orderedTextBoundaryBlocks(anchor, focus, state, options.traversalScopeRootId);
  const fullySelectedBlockIds = ordered.length <= 2 ? [] : ordered.slice(1, -1);
  return {
    kind: 'mixed',
    anchor,
    focus,
    direction,
    coveredBlockIds: ordered,
    fullySelectedBlockIds
  };
}

export function createNoneSelection(reason?: NoneSelection['reason']): NoneSelection {
  return {
    kind: 'none',
    ...(reason !== undefined ? { reason } : {})
  };
}

export function focusSelection(selection: SelectionState): SelectionFocusState {
  return { focused: true, mode: 'editor', selection };
}

export function storeSelectionForNestedFocus(selection: SelectionState, mode: 'nested' | 'menu' | 'modal', reason?: string): SelectionFocusState {
  return {
    focused: false,
    mode,
    selection: createNoneSelection(mode === 'modal' ? 'modal' : 'blur'),
    storedSelection: selection,
    ...(reason !== undefined ? { reason } : {})
  };
}

export function restoreStoredSelection(focus: SelectionFocusState): SelectionState {
  return focus.storedSelection ?? focus.selection;
}

export function compareRichTextPaths(a: RichTextPath, b: RichTextPath): number {
  const length = Math.min(a.parts.length, b.parts.length);
  for (let index = 0; index < length; index += 1) {
    const left = String(a.parts[index]);
    const right = String(b.parts[index]);
    if (left < right) return -1;
    if (left > right) return 1;
  }
  return a.parts.length - b.parts.length;
}

export function textPointsEqual(a: TextPoint, b: TextPoint): boolean {
  return a.blockId === b.blockId
    && a.offset === b.offset
    && a.affinity === b.affinity
    && compareRichTextPaths(a.path, b.path) === 0;
}

export function compareTextPoints(a: TextPoint, b: TextPoint, state?: DocumentState): number {
  if (a.blockId === b.blockId) {
    const pathCompare = compareRichTextPaths(a.path, b.path);
    return pathCompare === 0 ? a.offset - b.offset : pathCompare;
  }

  if (state) {
    const order = visibleBlockIds(state, commonTraversalRootId(state, a.blockId, b.blockId));
    const positions = new Map<BlockId, number>();
    order.forEach((id, index) => positions.set(id, index));
    const left = positions.get(a.blockId);
    const right = positions.get(b.blockId);
    if (left !== undefined && right !== undefined) return left - right;
  }

  return String(a.blockId).localeCompare(String(b.blockId));
}

export function selectionDirection(anchor: TextPoint, focus: TextPoint, state?: DocumentState): SelectionDirection {
  return compareTextPoints(anchor, focus, state) <= 0 ? 'forward' : 'backward';
}

export function isCollapsedSelection(selection: SelectionState): boolean {
  switch (selection.kind) {
    case 'caret':
    case 'none':
      return true;
    case 'rich_text_range':
    case 'mixed':
      return textPointsEqual(selection.anchor, selection.focus);
    case 'block':
      return selection.rootBlockIds.length <= 1 && selection.anchorBlockId === selection.focusBlockId;
    case 'cell':
      return selection.anchor.rowId === selection.focus.rowId && selection.anchor.columnId === selection.focus.columnId;
    case 'gap':
      return true;
  }
}

export function collapseSelection(
  selection: SelectionState,
  edge: 'anchor' | 'focus' | 'start' | 'end' = 'focus',
  state?: DocumentState
): SelectionState {
  switch (selection.kind) {
    case 'caret':
    case 'none':
    case 'gap':
      return selection;
    case 'rich_text_range':
    case 'mixed': {
      const point = pointForCollapse(selection.anchor, selection.focus, edge, state);
      return createCaretSelection(point, point.blockId);
    }
    case 'block': {
      const blockId = edge === 'anchor' || edge === 'start' ? selection.anchorBlockId : selection.focusBlockId;
      const normalized = createBlockSelection(state, blockId, blockId, { traversalScope: selection.traversalScope });
      return normalized ?? { ...selection, rootBlockIds: [blockId], coveredBlockIds: [blockId], anchorBlockId: blockId, focusBlockId: blockId };
    }
    case 'cell':
      return { ...selection, focus: selection.anchor, selectedRowIds: [selection.anchor.rowId], selectedColumnIds: [selection.anchor.columnId] };
  }
}

function pointForCollapse(anchor: TextPoint, focus: TextPoint, edge: 'anchor' | 'focus' | 'start' | 'end', state?: DocumentState): TextPoint {
  if (edge === 'anchor') return anchor;
  if (edge === 'focus') return focus;
  const compare = compareTextPoints(anchor, focus, state);
  return edge === 'start'
    ? compare <= 0 ? anchor : focus
    : compare <= 0 ? focus : anchor;
}

export function expandSelectionToBlocks(
  state: DocumentState,
  selection: SelectionState,
  options: { traversalScopeRootId?: BlockId | PageId; traversalScope?: TraversalScope } = {}
): BlockSelection | undefined {
  switch (selection.kind) {
    case 'caret':
      return createBlockSelection(state, selection.point.blockId, selection.point.blockId, options);
    case 'rich_text_range':
    case 'mixed':
      return createBlockSelection(state, selection.anchor.blockId, selection.focus.blockId, options);
    case 'block':
      return normalizeBlockSelection(state, selection);
    case 'cell':
    case 'gap':
    case 'none':
      return undefined;
  }
}

export function createBlockSelection(
  state: DocumentState | undefined,
  anchorBlockId: BlockId,
  focusBlockId: BlockId,
  options: { traversalScopeRootId?: BlockId | PageId; traversalScope?: TraversalScope } = {}
): BlockSelection | undefined {
  if (!state) {
    return {
      kind: 'block',
      anchorBlockId,
      focusBlockId,
      rootBlockIds: anchorBlockId === focusBlockId ? [anchorBlockId] : [anchorBlockId, focusBlockId],
      coveredBlockIds: anchorBlockId === focusBlockId ? [anchorBlockId] : [anchorBlockId, focusBlockId],
      traversalScope: options.traversalScope ?? 'page'
    };
  }

  if (!state.blocks[anchorBlockId] || !state.blocks[focusBlockId]) return undefined;
  const rootId = options.traversalScopeRootId ?? commonTraversalRootId(state, anchorBlockId, focusBlockId);
  const order = visibleBlockIds(state, rootId);
  const anchorIndex = order.indexOf(anchorBlockId);
  const focusIndex = order.indexOf(focusBlockId);
  const selected = anchorIndex >= 0 && focusIndex >= 0
    ? order.slice(Math.min(anchorIndex, focusIndex), Math.max(anchorIndex, focusIndex) + 1)
    : uniqueBlockIds([anchorBlockId, focusBlockId]);
  const rootBlockIds = normalizeSelectedRootBlockIds(state, selected, order);
  return {
    kind: 'block',
    anchorBlockId,
    focusBlockId,
    rootBlockIds,
    coveredBlockIds: coveredBlockIdsForRoots(state, rootBlockIds),
    traversalScope: options.traversalScope ?? inferTraversalScope(state, rootId)
  };
}

export function selectBlockRange(
  state: DocumentState,
  anchorBlockId: BlockId,
  focusBlockId: BlockId,
  options: { traversalScopeRootId?: BlockId | PageId; traversalScope?: TraversalScope } = {}
): BlockSelection {
  const selection = createBlockSelection(state, anchorBlockId, focusBlockId, options);
  if (!selection) throw new Error('Cannot select a block range with missing endpoints');
  return selection;
}

export function normalizeBlockSelection(state: DocumentState, selection: BlockSelection): BlockSelection {
  const rootId = commonTraversalRootId(state, selection.anchorBlockId, selection.focusBlockId);
  const order = visibleBlockIds(state, rootId);
  const roots = normalizeSelectedRootBlockIds(state, selection.rootBlockIds, order);
  const anchorBlockId = roots.includes(selection.anchorBlockId) || state.blocks[selection.anchorBlockId]
    ? selection.anchorBlockId
    : roots[0] ?? selection.anchorBlockId;
  const focusBlockId = roots.includes(selection.focusBlockId) || state.blocks[selection.focusBlockId]
    ? selection.focusBlockId
    : roots[roots.length - 1] ?? selection.focusBlockId;
  return {
    ...selection,
    anchorBlockId,
    focusBlockId,
    rootBlockIds: roots,
    coveredBlockIds: coveredBlockIdsForRoots(state, roots)
  };
}

export function normalizeSelectedRootBlockIds(state: DocumentState, blockIds: readonly BlockId[], order: readonly BlockId[] = visibleBlockIds(state)): BlockId[] {
  const orderIndex = new Map<BlockId, number>();
  order.forEach((id, index) => orderIndex.set(id, index));
  const unique = uniqueBlockIds(blockIds).filter(id => isActiveBlock(state.blocks[id]));
  const roots = unique.filter(id => !unique.some(other => other !== id && isAncestorBlock(state, other, id)));
  return roots.sort((a, b) => (orderIndex.get(a) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b) ?? Number.MAX_SAFE_INTEGER));
}

export function deriveSelectedBlockIds(
  selection: SelectionState,
  state?: DocumentState,
  options: { includeDescendants?: boolean; rootOnly?: boolean } = {}
): BlockId[] {
  switch (selection.kind) {
    case 'block':
      if (options.rootOnly) return [...selection.rootBlockIds];
      if (options.includeDescendants === false) return [...selection.rootBlockIds];
      return state ? coveredBlockIdsForRoots(state, selection.rootBlockIds) : [...selection.coveredBlockIds];
    case 'mixed':
      return options.rootOnly ? [...selection.fullySelectedBlockIds] : [...selection.coveredBlockIds];
    case 'caret':
    case 'rich_text_range':
      return uniqueBlockIds(selection.kind === 'caret' ? [selection.point.blockId] : [selection.anchor.blockId, selection.focus.blockId]);
    case 'cell':
      return [selection.ownerBlockId];
    case 'gap':
      return blockIdsFromDropTarget(selection.target);
    case 'none':
      return [];
  }
}

export interface SelectionValidationIssue {
  readonly code: 'missing-block' | 'inactive-block' | 'invalid-offset' | 'invalid-path' | 'invalid-range' | 'ancestor-descendant-root' | 'invalid-drop-target';
  readonly message: string;
  readonly blockId?: BlockId;
}

export interface SelectionValidationResult {
  readonly ok: boolean;
  readonly issues: readonly SelectionValidationIssue[];
  readonly repaired?: SelectionState;
}

export function validateSelection(state: DocumentState, selection: SelectionState, options: { repair?: boolean } = {}): SelectionValidationResult {
  const issues: SelectionValidationIssue[] = [];

  switch (selection.kind) {
    case 'none':
      break;
    case 'caret':
      validateTextPoint(state, selection.point, issues);
      break;
    case 'rich_text_range':
      validateTextPoint(state, selection.anchor, issues);
      validateTextPoint(state, selection.focus, issues);
      if (selection.anchor.blockId === selection.focus.blockId
        && compareRichTextPaths(selection.anchor.path, selection.focus.path) === 0
        && selection.anchor.offset > selection.focus.offset
        && selection.direction === 'forward') {
        issues.push({ code: 'invalid-range', message: 'Forward rich text ranges must not have anchor after focus', blockId: selection.anchor.blockId });
      }
      break;
    case 'mixed':
      validateTextPoint(state, selection.anchor, issues);
      validateTextPoint(state, selection.focus, issues);
      for (const blockId of selection.coveredBlockIds) validateBlockReference(state, blockId, issues);
      break;
    case 'block':
      validateBlockReference(state, selection.anchorBlockId, issues);
      validateBlockReference(state, selection.focusBlockId, issues);
      for (const blockId of selection.rootBlockIds) validateBlockReference(state, blockId, issues);
      for (const blockId of selection.coveredBlockIds) validateBlockReference(state, blockId, issues);
      for (const blockId of selection.rootBlockIds) {
        if (selection.rootBlockIds.some(other => other !== blockId && isAncestorBlock(state, other, blockId))) {
          issues.push({ code: 'ancestor-descendant-root', message: 'Block selection roots cannot include both an ancestor and descendant', blockId });
        }
      }
      break;
    case 'cell':
      validateBlockReference(state, selection.ownerBlockId, issues);
      break;
    case 'gap': {
      const validation = validateDropTarget(selection.target, state);
      if (!validation.ok) issues.push({ code: 'invalid-drop-target', message: validation.message });
      break;
    }
  }

  if (issues.length === 0) return { ok: true, issues };
  const repaired = options.repair ? repairSelection(state, selection) : undefined;
  return {
    ok: false,
    issues,
    ...(repaired !== undefined ? { repaired } : {})
  };
}

export function repairSelection(state: DocumentState, selection: SelectionState): SelectionState {
  switch (selection.kind) {
    case 'caret': {
      const repairedPoint = repairTextPoint(state, selection.point);
      return repairedPoint ? createCaretSelection(repairedPoint, repairedPoint.blockId) : createNoneSelection('blur');
    }
    case 'rich_text_range':
    case 'mixed': {
      const anchor = repairTextPoint(state, selection.anchor);
      const focus = repairTextPoint(state, selection.focus);
      if (anchor && focus) return createRichTextRangeSelection(anchor, focus, state);
      const fallback = anchor ?? focus;
      return fallback ? createCaretSelection(fallback, fallback.blockId) : createNoneSelection('blur');
    }
    case 'block': {
      const roots = normalizeSelectedRootBlockIds(state, selection.rootBlockIds);
      if (roots.length > 0) return createBlockSelection(state, roots[0] as BlockId, roots[roots.length - 1] as BlockId, { traversalScope: selection.traversalScope }) ?? createNoneSelection('blur');
      const fallback = findNearestEditableTextPoint(state, selection.focusBlockId) ?? findNearestEditableTextPoint(state, selection.anchorBlockId);
      return fallback ? createCaretSelection(fallback, fallback.blockId) : createNoneSelection('blur');
    }
    case 'gap': {
      const validation = validateDropTarget(selection.target, state);
      return validation.ok ? selection : createNoneSelection('blur');
    }
    case 'cell':
      return state.blocks[selection.ownerBlockId] ? selection : createNoneSelection('blur');
    case 'none':
      return selection;
  }
}

export type SelectionMapResult =
  | { readonly status: 'mapped'; readonly selection: SelectionState }
  | { readonly status: 'repaired'; readonly selection: SelectionState; readonly reason: string }
  | { readonly status: 'invalid'; readonly fallback: SelectionState; readonly reason: string };

export type SelectionMapStep =
  | { readonly kind: 'insert-text'; readonly at: TextPoint; readonly length: number }
  | { readonly kind: 'delete-text'; readonly from: TextPoint; readonly to: TextPoint }
  | { readonly kind: 'split-block'; readonly originalBlockId: BlockId; readonly newBlockId: BlockId; readonly at: TextPoint }
  | { readonly kind: 'merge-blocks'; readonly removedBlockId: BlockId; readonly survivorBlockId: BlockId; readonly survivorOffset: number }
  | { readonly kind: 'move-blocks'; readonly blockIds: readonly BlockId[]; readonly fromParentId: BlockId | PageId; readonly toParentId: BlockId | PageId }
  | { readonly kind: 'copy-blocks'; readonly originalToCopy: ReadonlyMap<BlockId, BlockId> }
  | { readonly kind: 'delete-blocks'; readonly deletedBlockIds: readonly BlockId[]; readonly fallback: BlockPoint | TextPoint }
  | { readonly kind: 'set-collapsed'; readonly blockId: BlockId; readonly collapsed: boolean }
  | { readonly kind: 'view-projection-change'; readonly ownerBlockId: BlockId; readonly visibleRowIds: readonly PageId[] };

export interface SelectionMapping {
  readonly revisionBefore: ClientRevision;
  readonly revisionAfter: ClientRevision;
  readonly steps: readonly SelectionMapStep[];
  mapPoint(point: TextPoint | BlockPoint | CellPoint): TextPoint | BlockPoint | CellPoint | null;
  mapSelection(selection: SelectionState): SelectionMapResult;
}

export interface SelectionMappingOptions {
  readonly stateAfter?: DocumentState;
  readonly revisionAfter?: ClientRevision;
  readonly selectCopiedBlocks?: boolean;
}

export function mapSelectionThroughTransaction(
  selection: SelectionState,
  stateBefore: DocumentState,
  transaction: TransactionRecord,
  options: SelectionMappingOptions = {}
): SelectionMapResult {
  return mapSelectionThroughOperations(selection, stateBefore, transaction.operations, options);
}

export function mapSelectionThroughOperations(
  selection: SelectionState,
  stateBefore: DocumentState,
  operations: readonly Operation[],
  options: SelectionMappingOptions = {}
): SelectionMapResult {
  let current = selection;
  let status: SelectionMapResult['status'] = 'mapped';
  let reason = '';

  for (const operation of operations) {
    const mapped = mapSelectionThroughOperation(current, stateBefore, operation, options);
    current = mapped.status === 'invalid' ? mapped.fallback : mapped.selection;
    if (mapped.status !== 'mapped') {
      status = mapped.status;
      reason = mapped.reason;
    }
  }

  const stateAfter = options.stateAfter;
  if (stateAfter) {
    const validation = validateSelection(stateAfter, current, { repair: true });
    if (!validation.ok) {
      const repaired = validation.repaired ?? createNoneSelection('blur');
      return { status: 'repaired', selection: repaired, reason: validation.issues.map(issue => issue.message).join('; ') };
    }
  }

  return status === 'mapped'
    ? { status, selection: current }
    : { status: 'repaired', selection: current, reason };
}

export function mapSelectionThroughOperation(
  selection: SelectionState,
  stateBefore: DocumentState,
  operation: Operation,
  options: SelectionMappingOptions = {}
): SelectionMapResult {
  let mapped = selection;
  let repairedReason: string | undefined;
  const revisionAfter = options.revisionAfter;

  if (operation.op === 'replace_rich_text') {
    mapped = mapSelectionTextPoints(selection, point => mapTextPointThroughReplace(point, operation.target, operation.range, operation.replacement, revisionAfter));
  } else if (operation.op === 'remove_child' && operation.mode !== 'detach') {
    const deleted = new Set<BlockId>([operation.childId, ...descendantBlockIds(stateBefore, operation.childId)]);
    const result = repairSelectionIfBlocksRemoved(selection, stateBefore, deleted, options.stateAfter);
    mapped = result.selection;
    repairedReason = result.repaired ? 'Selection referenced removed blocks' : undefined;
  } else if (operation.op === 'set_lifecycle' && (operation.lifecycle === 'trashed' || operation.lifecycle === 'deleted' || operation.lifecycle === 'archived')) {
    const deleted = lifecycleAffectedBlockIds(stateBefore, operation);
    if (deleted.size > 0) {
      const result = repairSelectionIfBlocksRemoved(selection, stateBefore, deleted, options.stateAfter);
      mapped = result.selection;
      repairedReason = result.repaired ? `Selection referenced ${operation.lifecycle} content` : undefined;
    }
  } else if (operation.op === 'move_block' || operation.op === 'insert_child') {
    if (selection.kind === 'block') mapped = normalizeBlockSelection(options.stateAfter ?? stateBefore, selection);
  } else if (operation.op === 'set_block_type' && selectionReferencesBlock(selection, operation.blockId)) {
    const validation = validateSelection(options.stateAfter ?? stateBefore, selection, { repair: true });
    if (!validation.ok) {
      mapped = validation.repaired ?? createNoneSelection('blur');
      repairedReason = 'Selection was repaired after block type change';
    }
  }

  const stateAfter = options.stateAfter;
  if (stateAfter) {
    const validation = validateSelection(stateAfter, mapped, { repair: true });
    if (!validation.ok) {
      const repaired = validation.repaired ?? createNoneSelection('blur');
      return { status: 'repaired', selection: repaired, reason: validation.issues.map(issue => issue.message).join('; ') };
    }
  }

  return repairedReason
    ? { status: 'repaired', selection: mapped, reason: repairedReason }
    : { status: 'mapped', selection: mapped };
}

export function createSelectionMapping(
  revisionBefore: ClientRevision,
  revisionAfter: ClientRevision,
  steps: readonly SelectionMapStep[],
  state?: DocumentState
): SelectionMapping {
  return {
    revisionBefore,
    revisionAfter,
    steps,
    mapPoint(point) {
      return steps.reduce<TextPoint | BlockPoint | CellPoint | null>((current, step) => current ? mapPointThroughStep(current, step, revisionAfter) : null, point);
    },
    mapSelection(selection) {
      let mapped = selection;
      let repaired = false;
      for (const step of steps) {
        const before = mapped;
        mapped = mapSelectionTextPoints(mapped, point => mapTextPointThroughStep(point, step, revisionAfter));
        if (step.kind === 'delete-blocks') {
          const result = repairSelectionIfBlocksRemoved(mapped, state, new Set(step.deletedBlockIds));
          mapped = result.selection;
          repaired = repaired || result.repaired;
        }
        if (before !== mapped && step.kind === 'copy-blocks') repaired = true;
      }
      if (state) {
        const validation = validateSelection(state, mapped, { repair: true });
        if (!validation.ok) return { status: 'repaired', selection: validation.repaired ?? createNoneSelection('blur'), reason: validation.issues.map(issue => issue.message).join('; ') };
      }
      return repaired ? { status: 'repaired', selection: mapped, reason: 'Selection was remapped through structural changes' } : { status: 'mapped', selection: mapped };
    }
  };
}

function mapPointThroughStep(point: TextPoint | BlockPoint | CellPoint, step: SelectionMapStep, revisionAfter: ClientRevision): TextPoint | BlockPoint | CellPoint | null {
  if ('offset' in point) return mapTextPointThroughStep(point, step, revisionAfter);
  if ('side' in point) return mapBlockPointThroughStep(point, step, revisionAfter);
  return point;
}

function mapTextPointThroughStep(point: TextPoint, step: SelectionMapStep, revisionAfter: ClientRevision): TextPoint {
  switch (step.kind) {
    case 'insert-text':
      return sameTextAddress(point, step.at) ? mapTextPointThroughInsertion(point, step.at.offset, step.length, revisionAfter) : point;
    case 'delete-text':
      return sameTextAddress(point, step.from) ? mapTextPointThroughDeletion(point, step.from.offset, step.to.offset, revisionAfter) : point;
    case 'split-block':
      if (point.blockId !== step.originalBlockId || compareRichTextPaths(point.path, step.at.path) !== 0) return point;
      if (point.offset > step.at.offset || (point.offset === step.at.offset && (point.affinity === 'after' || point.affinity === 'inside'))) {
        return { ...point, blockId: step.newBlockId, offset: Math.max(0, point.offset - step.at.offset), revision: revisionAfter };
      }
      return { ...point, revision: revisionAfter };
    case 'merge-blocks':
      return point.blockId === step.removedBlockId
        ? { ...point, blockId: step.survivorBlockId, offset: step.survivorOffset + point.offset, revision: revisionAfter }
        : { ...point, revision: revisionAfter };
    case 'copy-blocks': {
      const copyId = step.originalToCopy.get(point.blockId);
      return copyId ? { ...point, blockId: copyId, revision: revisionAfter } : point;
    }
    case 'delete-blocks':
    case 'move-blocks':
    case 'set-collapsed':
    case 'view-projection-change':
      return { ...point, revision: revisionAfter };
  }
}

function mapBlockPointThroughStep(point: BlockPoint, step: SelectionMapStep, revisionAfter: ClientRevision): BlockPoint | TextPoint | null {
  switch (step.kind) {
    case 'copy-blocks': {
      const blockId = step.originalToCopy.get(point.blockId);
      return blockId ? { ...point, blockId, revision: revisionAfter } : point;
    }
    case 'delete-blocks':
      if (!step.deletedBlockIds.includes(point.blockId)) return point;
      return 'offset' in step.fallback ? step.fallback : { ...step.fallback, revision: revisionAfter };
    case 'insert-text':
    case 'delete-text':
    case 'split-block':
    case 'merge-blocks':
    case 'move-blocks':
    case 'set-collapsed':
    case 'view-projection-change':
      return { ...point, revision: revisionAfter };
  }
}

function mapSelectionTextPoints(selection: SelectionState, mapper: (point: TextPoint) => TextPoint): SelectionState {
  switch (selection.kind) {
    case 'caret': {
      const point = mapper(selection.point);
      return createCaretSelection(point, selection.preferredBlockId);
    }
    case 'rich_text_range': {
      const anchor = mapper(selection.anchor);
      const focus = mapper(selection.focus);
      return { ...selection, anchor, focus };
    }
    case 'mixed': {
      const anchor = mapper(selection.anchor);
      const focus = mapper(selection.focus);
      return { ...selection, anchor, focus };
    }
    case 'none':
    case 'block':
    case 'cell':
    case 'gap':
      return selection;
  }
}

function mapTextPointThroughReplace(
  point: TextPoint,
  target: RichTextTarget,
  range: TextRangeAnchor,
  replacement: RichText,
  revisionAfter?: ClientRevision
): TextPoint {
  if (!textPointMatchesTarget(point, target)) return point;
  const start = Math.min(range.startUtf16, range.endUtf16);
  const end = Math.max(range.startUtf16, range.endUtf16);
  const replacementLength = plainTextFromRichText(replacement).length;
  const revision = revisionAfter ?? point.revision;

  if (start === end) return mapTextPointThroughInsertion(point, start, replacementLength, revision);
  return mapTextPointThroughReplacement(point, start, end, replacementLength, revision);
}

function mapTextPointThroughInsertion(point: TextPoint, offset: number, length: number, revision: ClientRevision): TextPoint {
  if (length === 0) return { ...point, revision };
  if (point.offset < offset) return { ...point, revision };
  if (point.offset > offset) return { ...point, offset: point.offset + length, revision };
  const sticksAfterInsertedText = point.affinity === 'after' || point.affinity === 'inside';
  return { ...point, offset: sticksAfterInsertedText ? point.offset + length : point.offset, revision };
}

function mapTextPointThroughDeletion(point: TextPoint, fromOffset: number, toOffset: number, revision: ClientRevision): TextPoint {
  const start = Math.min(fromOffset, toOffset);
  const end = Math.max(fromOffset, toOffset);
  if (point.offset < start) return { ...point, revision };
  if (point.offset > end) return { ...point, offset: point.offset - (end - start), revision };
  return { ...point, offset: start, revision };
}

function mapTextPointThroughReplacement(point: TextPoint, start: number, end: number, replacementLength: number, revision: ClientRevision): TextPoint {
  if (point.offset < start) return { ...point, revision };
  if (point.offset > end) return { ...point, offset: point.offset + replacementLength - (end - start), revision };
  const offset = point.affinity === 'after' || (point.offset === end && point.affinity !== 'before')
    ? start + replacementLength
    : start;
  return { ...point, offset, revision };
}

function sameTextAddress(left: TextPoint, right: TextPoint): boolean {
  return left.blockId === right.blockId && compareRichTextPaths(left.path, right.path) === 0;
}

function textPointMatchesTarget(point: TextPoint, target: RichTextTarget): boolean {
  const field: RichTextFieldPath = target.field;
  if (field.kind === 'block_data') return target.blockId === point.blockId && pathMatchesBlockDataField(point.path, field.key);
  if (field.kind === 'page_property') return target.pageId === point.blockId && pathMatchesPageProperty(point.path, field.propertyId);
  if (field.kind === 'comment') return pathMatchesComment(point.path, field.commentId);
  return false;
}

function pathMatchesBlockDataField(path: RichTextPath, key: string): boolean {
  const parts = path.parts.map(String);
  const signatures = [
    [key],
    ['data', key],
    ['block_data', key]
  ];
  return signatures.some(signature => arraysEqual(parts, signature));
}

function pathMatchesPageProperty(path: RichTextPath, propertyId: PropertyId): boolean {
  const parts = path.parts.map(String);
  const id = String(propertyId);
  return arraysEqual(parts, ['property', id]) || arraysEqual(parts, ['page_property', id]) || arraysEqual(parts, ['properties', id]);
}

function pathMatchesComment(path: RichTextPath, commentId: string): boolean {
  const parts = path.parts.map(String);
  return arraysEqual(parts, ['comment', commentId]) || arraysEqual(parts, ['comments', commentId, 'richText']);
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface RectLike {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
  readonly x?: number;
  readonly y?: number;
}

export interface LayoutRect {
  readonly id: string;
  readonly blockId?: BlockId;
  readonly parentBlockId?: BlockId | PageId;
  readonly viewId?: ViewId;
  readonly blockType?: BlockType;
  readonly depth: number;
  readonly rect: RectLike;
  readonly contentRect?: RectLike;
  readonly rowRect?: RectLike;
  readonly handleRect?: RectLike;
  readonly gutterRect?: RectLike;
  readonly childContentRect?: RectLike;
  readonly scrollContainerId?: string;
  readonly visible: boolean;
  readonly collapsed?: boolean;
  readonly virtual?: boolean;
  readonly acceptsChildren?: boolean;
  readonly readonly?: boolean;
  readonly columnIndex?: number;
  readonly rowIndex?: number;
  readonly zIndex?: number;
  readonly tableBlockId?: BlockId;
  readonly rowId?: BlockId | PageId;
  readonly columnId?: PropertyId | string;
}

export type DropPosition = 'before' | 'after' | 'inside-start' | 'inside-end' | 'side-left' | 'side-right';

export type DropTarget =
  | BlockPositionDropTarget
  | ColumnPositionDropTarget
  | TablePositionDropTarget
  | DatabaseViewDropTarget
  | ExternalImportDropTarget
  | InvalidDropTarget;

export interface BlockPositionDropTarget {
  readonly kind: 'block-position';
  readonly parentId: BlockId | PageId;
  readonly referenceBlockId?: BlockId;
  readonly position: DropPosition;
  readonly depth: number;
  readonly indicatorRect: RectLike;
  readonly allowedEffects: readonly ('move' | 'copy')[];
}

export interface ColumnPositionDropTarget {
  readonly kind: 'column-position';
  readonly columnListId?: BlockId;
  readonly targetColumnId?: BlockId;
  readonly side: 'left' | 'right';
  readonly widthRatioPreview?: readonly number[];
  readonly indicatorRect: RectLike;
  readonly allowedEffects: readonly ('move' | 'copy')[];
}

export interface TablePositionDropTarget {
  readonly kind: 'table-position';
  readonly tableBlockId: BlockId;
  readonly rowId?: BlockId | PageId;
  readonly columnId?: PropertyId | string;
  readonly position: 'row-before' | 'row-after' | 'column-before' | 'column-after' | 'cell';
  readonly indicatorRect: RectLike;
  readonly allowedEffects: readonly ('move' | 'copy')[];
}

export interface DatabaseViewDropTarget {
  readonly kind: 'database-view-position';
  readonly databaseBlockId: BlockId;
  readonly viewId: ViewId;
  readonly beforePageId?: PageId;
  readonly afterPageId?: PageId;
  readonly groupKey?: string;
  readonly operation: 'manual-order' | 'set-group-property' | 'open-page' | 'move-view-block';
  readonly indicatorRect: RectLike;
  readonly allowedEffects: readonly ('move' | 'copy')[];
}

export interface ExternalImportDropTarget {
  readonly kind: 'external-import';
  readonly parentId: BlockId | PageId;
  readonly referenceBlockId?: BlockId;
  readonly position: 'before' | 'after' | 'end' | 'replace-selection';
  readonly accepts: readonly ('files' | 'urls' | 'html' | 'text')[];
  readonly indicatorRect: RectLike;
}

export interface InvalidDropTarget {
  readonly kind: 'invalid';
  readonly reason: 'cycle' | 'schema' | 'readonly' | 'self-drop' | 'unsupported-payload' | 'filtered-view' | 'unloaded-target' | 'platform';
  readonly message: string;
  readonly nearestValidTarget?: DropTarget;
}

export interface DragPayload {
  readonly id: string;
  readonly source: 'internal-blocks' | 'internal-text' | 'internal-cells' | 'external';
  readonly selectionBeforeDrag: SelectionState;
  readonly sourcePageId?: PageId;
  readonly sourceViewId?: ViewId;
  readonly rootBlockIds?: readonly BlockId[];
  readonly coveredBlockIds?: readonly BlockId[];
  readonly textHtml?: string;
  readonly textPlain?: string;
  readonly textMarkdown?: string;
  readonly files?: readonly FileLike[];
  readonly urls?: readonly string[];
  readonly rows?: readonly PageId[];
  readonly columns?: readonly (PropertyId | string)[];
  readonly effectAllowed: readonly DropEffect[];
  readonly requestedEffect: DropEffect;
  readonly createdAt: number;
}

export interface FileLike {
  readonly name: string;
  readonly type?: string;
  readonly size?: number;
  readonly lastModified?: number;
}

export interface DropIndicator {
  readonly target: DropTarget;
  readonly effect: DropEffect;
  readonly kind: 'line' | 'box' | 'column' | 'table' | 'invalid';
  readonly rect: RectLike;
  readonly label: string;
}

export interface ReorderOperation {
  readonly op: 'reorder' | 'indent' | 'outdent' | 'move' | 'copy' | 'wrap-in-columns' | 'move-database-items';
  readonly payloadId: string;
  readonly blockIds: readonly BlockId[];
  readonly destination: DropTarget;
  readonly preserveRelativeOrder: boolean;
  readonly allocateNewIds: boolean;
  readonly nestingDelta?: -1 | 0 | 1;
  readonly columnWidthRatios?: readonly number[];
  readonly databaseUpdate?: {
    readonly viewId: ViewId;
    readonly groupPropertyId?: PropertyId;
    readonly groupValue?: unknown;
    readonly manualOrderKeyBefore?: string;
    readonly manualOrderKeyAfter?: string;
  };
  readonly selectionAfter: SelectionState;
}

export interface ResolveDropTargetOptions {
  readonly state: DocumentState;
  readonly pointer: Point;
  readonly rects: readonly LayoutRect[];
  readonly payload: DragPayload;
  readonly rootParentId?: BlockId | PageId;
  readonly canvasRect?: RectLike;
  readonly viewport?: 'phone' | 'tablet' | 'desktop';
  readonly sideBandSize?: number;
  readonly edgeBandRatio?: number;
  readonly allowColumns?: boolean;
  readonly readOnly?: boolean;
}

export interface DropValidationResult {
  readonly ok: boolean;
  readonly reason?: InvalidDropTarget['reason'];
  readonly message: string;
}

export function createInternalBlockDragPayload(
  id: string,
  selectionBeforeDrag: SelectionState,
  rootBlockIds: readonly BlockId[],
  options: {
    sourcePageId?: PageId;
    coveredBlockIds?: readonly BlockId[];
    requestedEffect?: DropEffect;
    effectAllowed?: readonly DropEffect[];
    createdAt?: number;
  } = {}
): DragPayload {
  return {
    id,
    source: 'internal-blocks',
    selectionBeforeDrag,
    rootBlockIds: [...rootBlockIds],
    coveredBlockIds: options.coveredBlockIds ? [...options.coveredBlockIds] : [...rootBlockIds],
    requestedEffect: options.requestedEffect ?? 'move',
    effectAllowed: options.effectAllowed ?? ['move', 'copy'],
    createdAt: options.createdAt ?? Date.now(),
    ...(options.sourcePageId !== undefined ? { sourcePageId: options.sourcePageId } : {})
  };
}

export function makeRect(left: number, top: number, width: number, height: number): RectLike {
  return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top };
}

export function containsPoint(rect: RectLike, point: Point): boolean {
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}

export function resolveDropTarget(options: ResolveDropTargetOptions): DropTarget {
  const { state, pointer, payload } = options;
  if (options.readOnly) return invalidDropTarget('readonly', 'Invalid drop target: editor is read-only');

  const candidates = options.rects
    .filter(rect => rect.visible && !rect.virtual && containsPoint(rect.rowRect ?? rect.rect, pointer))
    .sort((left, right) => (right.zIndex ?? 0) - (left.zIndex ?? 0) || right.depth - left.depth);

  const layout = candidates[0];
  if (!layout) {
    if (options.canvasRect && options.rootParentId && containsPoint(options.canvasRect, pointer)) {
      const target: BlockPositionDropTarget = {
        kind: 'block-position',
        parentId: options.rootParentId,
        position: 'inside-end',
        depth: 0,
        indicatorRect: makeRect(options.canvasRect.left, options.canvasRect.bottom - 2, options.canvasRect.width, 2),
        allowedEffects: allowedMoveCopyEffects(payload)
      };
      return validatedDropTarget(target, state, payload);
    }
    return invalidDropTarget('platform', 'Invalid drop target: pointer is outside the editor');
  }

  if (layout.readonly) return invalidDropTarget('readonly', 'Invalid drop target: target is read-only');
  if (!layout.blockId) return invalidDropTarget('unloaded-target', 'Invalid drop target: layout rectangle is not associated with a block');

  if (layout.blockType === 'table' || layout.tableBlockId) {
    const tableTarget = resolveTableDropTarget(layout, pointer, payload);
    if (tableTarget) return validatedDropTarget(tableTarget, state, payload);
  }

  const contentRect = layout.contentRect ?? layout.rect;
  const rowRect = layout.rowRect ?? layout.rect;
  const edgeBand = Math.max(4, Math.min(18, rowRect.height * (options.edgeBandRatio ?? 0.25)));
  const sideBandSize = options.sideBandSize ?? 24;
  const allowColumns = options.allowColumns === true && options.viewport !== 'phone';

  if (allowColumns && pointer.x <= contentRect.left + sideBandSize) {
    const target: ColumnPositionDropTarget = {
      kind: 'column-position',
      targetColumnId: layout.blockId,
      side: 'left',
      widthRatioPreview: [0.5, 0.5],
      indicatorRect: makeRect(contentRect.left, contentRect.top, 2, contentRect.height),
      allowedEffects: allowedMoveCopyEffects(payload)
    };
    return validatedDropTarget(target, state, payload);
  }

  if (allowColumns && pointer.x >= contentRect.right - sideBandSize) {
    const target: ColumnPositionDropTarget = {
      kind: 'column-position',
      targetColumnId: layout.blockId,
      side: 'right',
      widthRatioPreview: [0.5, 0.5],
      indicatorRect: makeRect(contentRect.right - 2, contentRect.top, 2, contentRect.height),
      allowedEffects: allowedMoveCopyEffects(payload)
    };
    return validatedDropTarget(target, state, payload);
  }

  const parentId = layout.parentBlockId ?? parentIdForBlock(state, layout.blockId);
  if (!parentId) return invalidDropTarget('unloaded-target', 'Invalid drop target: parent is not loaded');

  const position: DropPosition = pointer.y <= rowRect.top + edgeBand
    ? 'before'
    : pointer.y >= rowRect.bottom - edgeBand
      ? 'after'
      : layout.acceptsChildren === true || blockAcceptsChildren(state.blocks[layout.blockId])
        ? 'inside-end'
        : pointer.y < rowRect.top + rowRect.height / 2 ? 'before' : 'after';

  const target: BlockPositionDropTarget = position === 'inside-end'
    ? {
        kind: 'block-position',
        parentId: layout.blockId,
        referenceBlockId: layout.blockId,
        position,
        depth: layout.depth + 1,
        indicatorRect: makeInsideIndicatorRect(layout),
        allowedEffects: allowedMoveCopyEffects(payload)
      }
    : {
        kind: 'block-position',
        parentId,
        referenceBlockId: layout.blockId,
        position,
        depth: layout.depth,
        indicatorRect: makeLineIndicatorRect(layout, position),
        allowedEffects: allowedMoveCopyEffects(payload)
      };

  return validatedDropTarget(target, state, payload);
}

function validatedDropTarget(target: DropTarget, state: DocumentState, payload: DragPayload): DropTarget {
  const validation = validateDropTarget(target, state, payload);
  return validation.ok ? target : invalidDropTarget(validation.reason ?? 'schema', validation.message, target);
}

export function validateDropTarget(target: DropTarget, state: DocumentState, payload?: DragPayload): DropValidationResult {
  if (target.kind === 'invalid') return { ok: false, reason: target.reason, message: target.message };
  if (!payload) return { ok: true, message: 'Drop target is valid' };
  if (!targetAllowsEffect(target, payload.requestedEffect)) return { ok: false, reason: 'unsupported-payload', message: `Invalid drop target: ${payload.requestedEffect} is not allowed` };

  if (payload.source === 'internal-blocks') {
    const rootBlockIds = payload.rootBlockIds ?? [];
    if (rootBlockIds.length === 0) return { ok: false, reason: 'unsupported-payload', message: 'Invalid drop target: no blocks are being dragged' };
    if (target.kind === 'block-position') return validateBlockPositionDrop(state, rootBlockIds, target);
    if (target.kind === 'column-position') return validateColumnDrop(state, rootBlockIds, target);
    if (target.kind === 'table-position') return validateTableDrop(state, rootBlockIds, target);
    if (target.kind === 'external-import') return { ok: false, reason: 'unsupported-payload', message: 'Invalid drop target: internal blocks cannot use external import target' };
  }

  if (payload.source === 'external' && target.kind === 'external-import') return { ok: true, message: 'External import target is valid' };
  if (payload.source === 'external' && target.kind === 'block-position') return { ok: true, message: 'External payload may be inserted at a block position' };

  return { ok: true, message: 'Drop target is valid' };
}

export function canDrop(payload: DragPayload, target: DropTarget, state: DocumentState): boolean {
  return validateDropTarget(target, state, payload).ok;
}

function validateBlockPositionDrop(state: DocumentState, rootBlockIds: readonly BlockId[], target: BlockPositionDropTarget): DropValidationResult {
  const parent = state.blocks[target.parentId as BlockId];
  if (!parent) return { ok: false, reason: 'unloaded-target', message: 'Invalid drop target: parent is not loaded' };

  for (const blockId of rootBlockIds) {
    if (blockId === target.parentId) return { ok: false, reason: 'cycle', message: 'Invalid drop target: cannot move a block into itself' };
    if (isAncestorBlock(state, blockId, target.parentId as BlockId)) return { ok: false, reason: 'cycle', message: 'Invalid drop target: cannot move a block into its descendant' };
    if (target.referenceBlockId === blockId && (target.position === 'before' || target.position === 'after')) {
      return { ok: false, reason: 'self-drop', message: 'Invalid drop target: cannot drop a block onto itself' };
    }
  }

  const childTypes = rootBlockIds.map(id => state.blocks[id]?.type).filter((type): type is BlockType => type !== undefined);
  if (!canParentAcceptBlockTypes(parent, childTypes)) return { ok: false, reason: 'schema', message: `Invalid drop target: ${parent.type} cannot accept the dragged blocks` };
  return { ok: true, message: 'Block position drop is valid' };
}

function validateColumnDrop(state: DocumentState, rootBlockIds: readonly BlockId[], target: ColumnPositionDropTarget): DropValidationResult {
  if (!target.targetColumnId) return { ok: false, reason: 'schema', message: 'Invalid drop target: missing column target' };
  if (rootBlockIds.includes(target.targetColumnId)) return { ok: false, reason: 'self-drop', message: 'Invalid drop target: cannot create columns with the dragged target itself' };
  for (const blockId of rootBlockIds) {
    if (isAncestorBlock(state, blockId, target.targetColumnId)) return { ok: false, reason: 'cycle', message: 'Invalid drop target: cannot create a column beside a descendant' };
  }
  return { ok: true, message: 'Column drop is valid' };
}

function validateTableDrop(state: DocumentState, rootBlockIds: readonly BlockId[], target: TablePositionDropTarget): DropValidationResult {
  const table = state.blocks[target.tableBlockId];
  if (!table || table.type !== 'table') return { ok: false, reason: 'schema', message: 'Invalid drop target: target table is not valid' };
  const childTypes = rootBlockIds.map(id => state.blocks[id]?.type);
  if (target.position.startsWith('row') && childTypes.some(type => type !== 'table_row')) {
    return { ok: false, reason: 'schema', message: 'Invalid drop target: only table rows can be moved into table row zones' };
  }
  return { ok: true, message: 'Table drop is valid' };
}

export function invalidDropTarget(reason: InvalidDropTarget['reason'], message: string, nearestValidTarget?: DropTarget): InvalidDropTarget {
  return {
    kind: 'invalid',
    reason,
    message,
    ...(nearestValidTarget !== undefined ? { nearestValidTarget } : {})
  };
}

export function dropIndicatorForTarget(target: DropTarget, effect: DropEffect = 'move'): DropIndicator | undefined {
  switch (target.kind) {
    case 'block-position':
      return {
        target,
        effect,
        kind: target.position === 'inside-end' || target.position === 'inside-start' ? 'box' : 'line',
        rect: target.indicatorRect,
        label: `${effect} ${target.position.replace('-', ' ')}`
      };
    case 'column-position':
      return { target, effect, kind: 'column', rect: target.indicatorRect, label: `${effect} as column ${target.side}` };
    case 'table-position':
      return { target, effect, kind: 'table', rect: target.indicatorRect, label: `${effect} ${target.position}` };
    case 'database-view-position':
      return { target, effect, kind: 'box', rect: target.indicatorRect, label: `${effect} database item` };
    case 'external-import':
      return { target, effect: 'copy', kind: 'line', rect: target.indicatorRect, label: 'import external content' };
    case 'invalid':
      return undefined;
  }
}

export function createReorderOperationDescriptor(
  payload: DragPayload,
  target: DropTarget,
  state: DocumentState,
  effect: DropEffect = payload.requestedEffect
): ReorderOperation | undefined {
  if (payload.source !== 'internal-blocks' || !payload.rootBlockIds || !canDrop(payload, target, state)) return undefined;
  const blockIds = normalizeSelectedRootBlockIds(state, payload.rootBlockIds);
  const selectionAfter = target.kind === 'block-position' && blockIds.length > 0
    ? createBlockSelection(state, blockIds[0] as BlockId, blockIds[blockIds.length - 1] as BlockId) ?? payload.selectionBeforeDrag
    : payload.selectionBeforeDrag;
  return {
    op: effect === 'copy' ? 'copy' : 'move',
    payloadId: payload.id,
    blockIds,
    destination: target,
    preserveRelativeOrder: true,
    allocateNewIds: effect === 'copy',
    nestingDelta: target.kind === 'block-position' ? nestingDeltaForTarget(state, blockIds, target) : 0,
    selectionAfter
  };
}

export function buildMoveBlockOperations(payload: DragPayload, target: DropTarget, state: DocumentState): MoveBlockOperation[] {
  if (payload.source !== 'internal-blocks' || payload.requestedEffect !== 'move' || target.kind !== 'block-position') return [];
  if (!validateDropTarget(target, state, payload).ok) return [];
  const blockIds = normalizeSelectedRootBlockIds(state, payload.rootBlockIds ?? []);
  if (blockIds.length === 0) return [];

  const ordered = target.position === 'after' || target.position === 'inside-start'
    ? [...blockIds].reverse()
    : blockIds;
  return ordered.map(blockId => ({
    op: 'move_block',
    blockId,
    newParentId: target.parentId,
    at: insertPositionForTarget(target)
  }));
}

export function buildReorderOperations(payload: DragPayload, target: DropTarget, state: DocumentState): Operation[] {
  return buildMoveBlockOperations(payload, target, state);
}

function insertPositionForTarget(target: BlockPositionDropTarget): InsertPosition {
  if (target.position === 'before' && target.referenceBlockId) return { kind: 'before', siblingId: target.referenceBlockId };
  if (target.position === 'after' && target.referenceBlockId) return { kind: 'after', siblingId: target.referenceBlockId };
  if (target.position === 'inside-start') return { kind: 'index', index: 0 };
  return { kind: 'append' };
}

export interface DropModifierState {
  readonly altKey?: boolean;
  readonly optionKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
}

export function isCopyModifierPressed(modifiers: DropModifierState, platform: 'mac' | 'windows' | 'linux' | 'unknown' = 'unknown'): boolean {
  if (modifiers.altKey === true || modifiers.optionKey === true) return true;
  return platform !== 'mac' && modifiers.ctrlKey === true;
}

export function requestedEffectFromModifiers(
  payload: DragPayload,
  modifiers: DropModifierState,
  options: { platform?: 'mac' | 'windows' | 'linux' | 'unknown'; preferLinkWithMeta?: boolean } = {}
): DropEffect {
  if (options.preferLinkWithMeta === true && modifiers.metaKey === true && payload.effectAllowed.includes('link')) return 'link';
  if (isCopyModifierPressed(modifiers, options.platform) && payload.effectAllowed.includes('copy')) return 'copy';
  if (payload.effectAllowed.includes(payload.requestedEffect)) return payload.requestedEffect;
  return payload.effectAllowed.includes('move') ? 'move' : payload.effectAllowed.includes('copy') ? 'copy' : payload.effectAllowed[0] ?? 'move';
}

export type ExternalDropDescriptor =
  | { readonly kind: 'files'; readonly files: readonly FileLike[] }
  | { readonly kind: 'urls'; readonly urls: readonly string[]; readonly text?: string; readonly html?: string }
  | { readonly kind: 'html'; readonly html: string; readonly text?: string }
  | { readonly kind: 'text'; readonly text: string };

export interface ExternalDropInput {
  readonly files?: readonly FileLike[];
  readonly text?: string;
  readonly html?: string;
  readonly uriList?: string;
}

export function describeExternalDrop(input: ExternalDropInput): ExternalDropDescriptor[] {
  const descriptors: ExternalDropDescriptor[] = [];
  if (input.files && input.files.length > 0) descriptors.push({ kind: 'files', files: input.files });
  const urls = uniqueStrings([...extractUrls(input.uriList ?? ''), ...extractUrls(input.text ?? ''), ...extractAnchorUrls(input.html ?? '')]);
  if (urls.length > 0) descriptors.push({ kind: 'urls', urls, ...(input.text !== undefined ? { text: input.text } : {}), ...(input.html !== undefined ? { html: input.html } : {}) });
  if (input.html && input.html.trim().length > 0) descriptors.push({ kind: 'html', html: input.html, ...(input.text !== undefined ? { text: input.text } : {}) });
  if (input.text && input.text.trim().length > 0 && urls.length === 0) descriptors.push({ kind: 'text', text: input.text });
  return descriptors;
}

export function createExternalDragPayload(id: string, selectionBeforeDrag: SelectionState, input: ExternalDropInput, createdAt: number = Date.now()): DragPayload {
  const descriptors = describeExternalDrop(input);
  const urls = descriptors.flatMap(descriptor => descriptor.kind === 'urls' ? descriptor.urls : []);
  return {
    id,
    source: 'external',
    selectionBeforeDrag,
    effectAllowed: ['copy'],
    requestedEffect: 'copy',
    createdAt,
    ...(input.files !== undefined ? { files: input.files } : {}),
    ...(urls.length > 0 ? { urls } : {}),
    ...(input.text !== undefined ? { textPlain: input.text } : {}),
    ...(input.html !== undefined ? { textHtml: input.html } : {})
  };
}

export interface LayoutMetrics {
  readonly indentUnit: number;
  readonly handleGutter: number;
  readonly contentGutter: number;
  readonly blockGap: number;
  readonly minColumnWidth: number;
}

export const DEFAULT_LAYOUT_METRICS: LayoutMetrics = Object.freeze({
  indentUnit: 24,
  handleGutter: 32,
  contentGutter: 8,
  blockGap: 4,
  minColumnWidth: 220
});

export function indentationForDepth(depth: number, metrics: LayoutMetrics = DEFAULT_LAYOUT_METRICS): number {
  return Math.max(0, depth) * metrics.indentUnit;
}

export function contentRectForDepth(rowRect: RectLike, depth: number, metrics: LayoutMetrics = DEFAULT_LAYOUT_METRICS): RectLike {
  const left = rowRect.left + metrics.handleGutter + metrics.contentGutter + indentationForDepth(depth, metrics);
  return makeRect(left, rowRect.top, Math.max(0, rowRect.right - left), rowRect.height);
}

export function childContentRect(parentContentRect: RectLike, metrics: LayoutMetrics = DEFAULT_LAYOUT_METRICS): RectLike {
  const left = parentContentRect.left + metrics.indentUnit;
  return makeRect(left, parentContentRect.bottom + metrics.blockGap, Math.max(0, parentContentRect.right - left), 0);
}

export function normalizeColumnWidthRatios(ratios: readonly number[]): number[] {
  const positive = ratios.map(value => Number.isFinite(value) && value > 0 ? value : 1);
  const total = positive.reduce((sum, value) => sum + value, 0) || positive.length || 1;
  return positive.map(value => value / total);
}

export function columnsCollapseForViewport(viewportWidth: number, columnCount: number, metrics: LayoutMetrics = DEFAULT_LAYOUT_METRICS): boolean {
  return columnCount <= 1 ? false : viewportWidth / columnCount < metrics.minColumnWidth;
}

export function columnRects(container: RectLike, ratios: readonly number[], gap = 24): RectLike[] {
  const normalized = normalizeColumnWidthRatios(ratios);
  const availableWidth = Math.max(0, container.width - Math.max(0, normalized.length - 1) * gap);
  let left = container.left;
  return normalized.map(ratio => {
    const width = availableWidth * ratio;
    const rect = makeRect(left, container.top, width, container.height);
    left += width + gap;
    return rect;
  });
}

export type TableZone = 'outside' | 'cell' | 'row-before' | 'row-after' | 'column-before' | 'column-after';

export interface TableZoneOptions {
  readonly rowCount: number;
  readonly columnCount: number;
  readonly edgeBand?: number;
}

export function tableZoneAtPoint(tableRect: RectLike, point: Point, options: TableZoneOptions): { readonly zone: TableZone; readonly rowIndex?: number; readonly columnIndex?: number } {
  if (!containsPoint(tableRect, point) || options.rowCount <= 0 || options.columnCount <= 0) return { zone: 'outside' };
  const rowHeight = tableRect.height / options.rowCount;
  const columnWidth = tableRect.width / options.columnCount;
  const rowIndex = Math.min(options.rowCount - 1, Math.max(0, Math.floor((point.y - tableRect.top) / rowHeight)));
  const columnIndex = Math.min(options.columnCount - 1, Math.max(0, Math.floor((point.x - tableRect.left) / columnWidth)));
  const edgeBand = options.edgeBand ?? Math.min(10, rowHeight / 4, columnWidth / 4);
  if (point.y <= tableRect.top + rowIndex * rowHeight + edgeBand) return { zone: 'row-before', rowIndex };
  if (point.y >= tableRect.top + (rowIndex + 1) * rowHeight - edgeBand) return { zone: 'row-after', rowIndex };
  if (point.x <= tableRect.left + columnIndex * columnWidth + edgeBand) return { zone: 'column-before', columnIndex };
  if (point.x >= tableRect.left + (columnIndex + 1) * columnWidth - edgeBand) return { zone: 'column-after', columnIndex };
  return { zone: 'cell', rowIndex, columnIndex };
}

export interface VirtualizedRectLookup {
  getRect(blockId: BlockId): LayoutRect | undefined;
  getVisibleRects(): readonly LayoutRect[];
  getNearestMountedRect(blockId: BlockId, direction: 'before' | 'after'): LayoutRect | undefined;
  scrollToBlock?(blockId: BlockId, options?: { align?: 'start' | 'center' | 'end' | 'nearest' }): void | Promise<void>;
}

export function resolveRectFromLookup(lookup: VirtualizedRectLookup, blockId: BlockId, direction: 'before' | 'after' = 'after'): LayoutRect | undefined {
  return lookup.getRect(blockId) ?? lookup.getNearestMountedRect(blockId, direction);
}

export function announceSelection(selection: SelectionState, state?: DocumentState): string {
  switch (selection.kind) {
    case 'none':
      return 'No editor selection';
    case 'caret':
      return `Caret in ${blockLabel(state?.blocks[selection.point.blockId])}`;
    case 'rich_text_range':
      return selection.anchor.blockId === selection.focus.blockId
        ? `Text selected in ${blockLabel(state?.blocks[selection.anchor.blockId])}`
        : `Text selected from ${blockLabel(state?.blocks[selection.anchor.blockId])} to ${blockLabel(state?.blocks[selection.focus.blockId])}`;
    case 'mixed':
      return `Text and ${selection.fullySelectedBlockIds.length} blocks selected from ${blockLabel(state?.blocks[selection.anchor.blockId])} to ${blockLabel(state?.blocks[selection.focus.blockId])}`;
    case 'block':
      return `${selection.rootBlockIds.length} ${selection.rootBlockIds.length === 1 ? 'block' : 'blocks'} selected`;
    case 'cell':
      return `${selection.selectedRowIds.length} rows and ${selection.selectedColumnIds.length} columns selected`;
    case 'gap':
      return dropTargetAnnouncement(selection.target);
  }
}

export function announceDrop(target: DropTarget, payload: DragPayload, effect: DropEffect = payload.requestedEffect): string {
  if (target.kind === 'invalid') return target.message;
  const count = payload.rootBlockIds?.length ?? payload.files?.length ?? payload.urls?.length ?? 1;
  const noun = payload.source === 'external' ? 'item' : 'block';
  return `${effect === 'copy' ? 'Copy' : effect === 'move' ? 'Move' : 'Link'} ${count} ${count === 1 ? noun : `${noun}s`} ${dropTargetAnnouncement(target)}`;
}

function dropTargetAnnouncement(target: DropTarget): string {
  switch (target.kind) {
    case 'block-position':
      return `${target.position.replace('-', ' ')} block`;
    case 'column-position':
      return `as a column on the ${target.side}`;
    case 'table-position':
      return `at table ${target.position}`;
    case 'database-view-position':
      return `in database view by ${target.operation}`;
    case 'external-import':
      return `import ${target.accepts.join(', ')} ${target.position}`;
    case 'invalid':
      return target.message;
  }
}

function orderedTextBoundaryBlocks(anchor: TextPoint, focus: TextPoint, state: DocumentState, traversalScopeRootId?: BlockId | PageId): BlockId[] {
  const rootId = traversalScopeRootId ?? commonTraversalRootId(state, anchor.blockId, focus.blockId);
  const order = visibleBlockIds(state, rootId);
  const anchorIndex = order.indexOf(anchor.blockId);
  const focusIndex = order.indexOf(focus.blockId);
  if (anchorIndex < 0 || focusIndex < 0) return uniqueBlockIds([anchor.blockId, focus.blockId]);
  return order.slice(Math.min(anchorIndex, focusIndex), Math.max(anchorIndex, focusIndex) + 1);
}

export function visibleBlockIds(
  state: DocumentState,
  rootId?: BlockId | PageId,
  options: { includeRoot?: boolean; includeCollapsedDescendants?: boolean } = {}
): BlockId[] {
  const roots = rootId ? [rootId as BlockId] : state.workspace.rootPageIds.map(id => id as BlockId);
  const result: BlockId[] = [];
  const visit = (blockId: BlockId, isRoot: boolean): void => {
    const block = state.blocks[blockId];
    if (!isActiveBlock(block)) return;
    if (!isRoot || options.includeRoot === true) result.push(blockId);
    if (isCollapsed(block) && options.includeCollapsedDescendants !== true) return;
    for (const childId of block.children) visit(childId, false);
  };
  for (const root of roots) visit(root, true);
  return result;
}

export function editableBlockIds(state: DocumentState, rootId?: BlockId | PageId): BlockId[] {
  return visibleBlockIds(state, rootId).filter(id => editableRichTextForBlock(state.blocks[id]) !== undefined);
}

export function adjacentEditableBlock(
  state: DocumentState,
  blockId: BlockId,
  direction: BlockNavigationDirection,
  rootId?: BlockId | PageId
): EditableBlockNavigationTarget | undefined {
  const order = editableBlockIds(state, rootId);
  const currentIndex = order.indexOf(blockId);
  if (currentIndex < 0) return undefined;
  const nextIndex = direction === 'previous' ? currentIndex - 1 : currentIndex + 1;
  const nextBlockId = order[nextIndex] as BlockId | undefined;
  if (!nextBlockId) return undefined;
  const boundary = direction === 'previous' ? 'end' : 'start';
  const point = textPointAtBlockBoundary(state, nextBlockId, boundary);
  return point ? { blockId: nextBlockId, boundary, point } : undefined;
}

export function buildKeyboardReorderOperations(
  state: DocumentState,
  blockId: BlockId,
  direction: BlockNavigationDirection
): MoveBlockOperation[] {
  const block = state.blocks[blockId];
  if (!isActiveBlock(block)) return [];
  const parentId = parentIdForBlockRecord(block);
  if (!parentId) return [];
  const siblingIds = state.blocks[parentId as BlockId]?.children ?? [];
  const index = siblingIds.indexOf(blockId);
  const referenceId = siblingIds[direction === 'previous' ? index - 1 : index + 1];
  const reference = referenceId ? state.blocks[referenceId] : undefined;
  if (index < 0 || !reference) return [];
  return [{
    op: 'move_block',
    blockId,
    newParentId: parentId,
    at: direction === 'previous'
      ? { kind: 'before', siblingId: reference.id }
      : { kind: 'after', siblingId: reference.id }
  }];
}

function commonTraversalRootId(state: DocumentState, a: BlockId, b: BlockId): BlockId | PageId | undefined {
  const aPath = ancestorPath(state, a);
  const bSet = new Set(ancestorPath(state, b));
  return aPath.find(id => bSet.has(id)) ?? topPageId(state, a) ?? topPageId(state, b);
}

function ancestorPath(state: DocumentState, blockId: BlockId): (BlockId | PageId)[] {
  const path: (BlockId | PageId)[] = [];
  let current = state.blocks[blockId];
  const seen = new Set<BlockId | PageId>();
  while (current && !seen.has(current.id)) {
    path.push(current.id);
    seen.add(current.id);
    const parentId = parentIdForBlockRecord(current);
    if (!parentId) break;
    current = state.blocks[parentId as BlockId];
  }
  return path.reverse();
}

function topPageId(state: DocumentState, blockId: BlockId): BlockId | PageId | undefined {
  const path = ancestorPath(state, blockId);
  return path.find(id => state.pages[id as PageId]) ?? path[0];
}

function inferTraversalScope(state: DocumentState, rootId?: BlockId | PageId): TraversalScope {
  if (!rootId) return 'page';
  const block = state.blocks[rootId as BlockId];
  if (!block) return 'page';
  if (block.type === 'column') return 'column';
  if (block.type === 'database_view') return 'database-view';
  if (block.type === 'toggle' || block.type.startsWith('toggle_heading')) return 'toggle';
  return 'page';
}

function coveredBlockIdsForRoots(state: DocumentState, roots: readonly BlockId[]): BlockId[] {
  const ids: BlockId[] = [];
  for (const root of roots) ids.push(root, ...descendantBlockIds(state, root));
  return uniqueBlockIds(ids);
}

function descendantBlockIds(state: DocumentState, blockId: BlockId): BlockId[] {
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

function isAncestorBlock(state: DocumentState, ancestorId: BlockId, descendantId: BlockId): boolean {
  let current = state.blocks[descendantId];
  const seen = new Set<BlockId>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const parentId = parentIdForBlockRecord(current);
    if (parentId === ancestorId) return true;
    current = parentId ? state.blocks[parentId as BlockId] : undefined;
  }
  return false;
}

function parentIdForBlock(state: DocumentState, blockId: BlockId): BlockId | PageId | undefined {
  const block = state.blocks[blockId];
  return block ? parentIdForBlockRecord(block) : undefined;
}

function parentIdForBlockRecord(block: BlockRecord): BlockId | PageId | undefined {
  switch (block.parent.kind) {
    case 'block':
      return block.parent.blockId;
    case 'page':
      return block.parent.pageId;
    default:
      return undefined;
  }
}

function validateTextPoint(state: DocumentState, point: TextPoint, issues: SelectionValidationIssue[]): void {
  const block = state.blocks[point.blockId];
  if (!validateBlockReference(state, point.blockId, issues)) return;
  const richText = block ? richTextAtPath(block, point.path) : undefined;
  if (!richText) {
    issues.push({ code: 'invalid-path', message: 'Text point path does not resolve to rich text', blockId: point.blockId });
    return;
  }
  const length = plainTextFromRichText(richText).length;
  if (!Number.isInteger(point.offset) || point.offset < 0 || point.offset > length) {
    issues.push({ code: 'invalid-offset', message: `Text point offset ${point.offset} is outside 0..${length}`, blockId: point.blockId });
  }
}

function validateBlockReference(state: DocumentState, blockId: BlockId, issues: SelectionValidationIssue[]): boolean {
  const block = state.blocks[blockId];
  if (!block) {
    issues.push({ code: 'missing-block', message: `Block ${String(blockId)} does not exist`, blockId });
    return false;
  }
  if (!isActiveBlock(block)) {
    issues.push({ code: 'inactive-block', message: `Block ${String(blockId)} is not active`, blockId });
    return false;
  }
  return true;
}

function repairTextPoint(state: DocumentState, point: TextPoint): TextPoint | undefined {
  const block = state.blocks[point.blockId];
  const richText = block ? richTextAtPath(block, point.path) : undefined;
  if (block && isActiveBlock(block) && richText) {
    const offset = clamp(point.offset, 0, plainTextFromRichText(richText).length);
    return { ...point, offset };
  }
  return findNearestEditableTextPoint(state, point.blockId);
}

function findNearestEditableTextPoint(state: DocumentState, nearBlockId?: BlockId, excluded: ReadonlySet<BlockId> = new Set()): TextPoint | undefined {
  const order = visibleBlockIds(state).filter(id => !excluded.has(id) && editableRichTextForBlock(state.blocks[id]) !== undefined);
  if (order.length === 0) return undefined;
  const nearIndex = nearBlockId ? order.indexOf(nearBlockId) : -1;
  if (nearIndex >= 0) {
    for (let index = nearIndex - 1; index >= 0; index -= 1) {
      const point = textPointAtBlockBoundary(state, order[index] as BlockId, 'end');
      if (point) return point;
    }
    for (let index = nearIndex + 1; index < order.length; index += 1) {
      const point = textPointAtBlockBoundary(state, order[index] as BlockId, 'start');
      if (point) return point;
    }
  }
  return textPointAtBlockBoundary(state, order[0] as BlockId, 'start');
}

function textPointAtBlockBoundary(state: DocumentState, blockId: BlockId, boundary: 'start' | 'end'): TextPoint | undefined {
  const block = state.blocks[blockId];
  const richText = editableRichTextForBlock(block);
  if (!block || !richText) return undefined;
  const path = defaultRichTextPathForBlock(block);
  const offset = boundary === 'start' ? 0 : plainTextFromRichText(richText).length;
  return createTextPoint(block.id, offset, { path, affinity: boundary === 'start' ? 'before' : 'after' });
}

function repairSelectionIfBlocksRemoved(
  selection: SelectionState,
  stateBefore: DocumentState | undefined,
  removed: ReadonlySet<BlockId>,
  stateAfter?: DocumentState
): { readonly selection: SelectionState; readonly repaired: boolean } {
  if (!selectionIntersectsBlocks(selection, removed)) return { selection, repaired: false };
  const state = stateAfter ?? stateBefore;
  if (selection.kind === 'block' && state) {
    const roots = selection.rootBlockIds.filter(id => !removed.has(id) && ![...removed].some(removedId => isAncestorBlock(state, removedId, id)));
    if (roots.length > 0) {
      return {
        selection: createBlockSelection(state, roots[0] as BlockId, roots[roots.length - 1] as BlockId, { traversalScope: selection.traversalScope }) ?? createNoneSelection('blur'),
        repaired: true
      };
    }
  }
  const near = firstReferencedBlock(selection);
  const fallback = state ? findNearestEditableTextPoint(state, near, removed) : undefined;
  return { selection: fallback ? createCaretSelection(fallback, fallback.blockId) : createNoneSelection('blur'), repaired: true };
}

function lifecycleAffectedBlockIds(state: DocumentState, operation: Extract<Operation, { op: 'set_lifecycle' }>): Set<BlockId> {
  const affected = new Set<BlockId>();
  if (operation.record.kind === 'block' || operation.record.kind === 'page') {
    const blockId = operation.record.id as BlockId;
    affected.add(blockId);
    if (operation.cascade === true || operation.record.kind === 'page') {
      for (const descendant of descendantBlockIds(state, blockId)) affected.add(descendant);
    }
  }
  return affected;
}

function selectionIntersectsBlocks(selection: SelectionState, blockIds: ReadonlySet<BlockId>): boolean {
  return deriveSelectedBlockIds(selection, undefined, { includeDescendants: true }).some(id => blockIds.has(id));
}

function selectionReferencesBlock(selection: SelectionState, blockId: BlockId): boolean {
  return deriveSelectedBlockIds(selection).includes(blockId);
}

function firstReferencedBlock(selection: SelectionState): BlockId | undefined {
  return deriveSelectedBlockIds(selection)[0];
}

function richTextAtPath(block: BlockRecord, path: RichTextPath): RichText | undefined {
  const fromBlock = readPath(block, path.parts);
  if (isRichText(fromBlock)) return fromBlock;
  const partsWithoutData = path.parts[0] === 'data' ? path.parts.slice(1) : path.parts;
  const fromData = readPath(block.data, partsWithoutData);
  if (isRichText(fromData)) return fromData;
  return editableRichTextForBlock(block);
}

function editableRichTextForBlock(block: BlockRecord | undefined): RichText | undefined {
  if (!isActiveBlock(block)) return undefined;
  const data = block.data;
  if (isRecord(data)) {
    const richText = data.richText;
    if (isRichText(richText)) return richText;
    const title = data.title;
    if (isRichText(title)) return title;
    const cells = data.cells;
    if (Array.isArray(cells) && isRichText(cells[0])) return cells[0];
  }
  return undefined;
}

function defaultRichTextPathForBlock(block: BlockRecord): RichTextPath {
  const data = block.data;
  if (isRecord(data) && isRichText(data.title)) return { parts: ['data', 'title'] };
  if (isRecord(data) && Array.isArray(data.cells) && isRichText(data.cells[0])) return { parts: ['data', 'cells', 0] };
  return DEFAULT_RICH_TEXT_PATH;
}

function isRichText(value: unknown): value is RichText {
  return Array.isArray(value) && value.every(span => isRecord(span) && typeof span.type === 'string');
}

function readPath(root: unknown, parts: readonly (string | number)[]): unknown {
  let current = root;
  for (const part of parts) {
    if (Array.isArray(current) && typeof part === 'number') {
      current = current[part];
    } else if (isRecord(current)) {
      current = current[String(part)];
    } else {
      return undefined;
    }
  }
  return current;
}

function isActiveBlock(block: BlockRecord | undefined): block is BlockRecord {
  return block !== undefined && block.lifecycle === 'active';
}

function isCollapsed(block: BlockRecord): boolean {
  return isRecord(block.data) && block.data.collapsed === true;
}

function blockAcceptsChildren(block: BlockRecord | undefined): boolean {
  if (!isActiveBlock(block)) return false;
  switch (block.type) {
    case 'divider':
    case 'breadcrumb':
    case 'table_of_contents':
    case 'equation':
    case 'image':
    case 'video':
    case 'audio':
    case 'file':
    case 'pdf':
    case 'bookmark':
    case 'embed':
    case 'link_preview':
    case 'child_database':
    case 'database_view':
    case 'unsupported':
      return false;
    default:
      return true;
  }
}

function canParentAcceptBlockTypes(parent: BlockRecord, childTypes: readonly BlockType[]): boolean {
  if (!blockAcceptsChildren(parent)) return false;
  if (childTypes.some(type => type === 'column')) return parent.type === 'column_list';
  if (childTypes.some(type => type === 'table_row')) return parent.type === 'table';
  if (parent.type === 'column_list' || parent.type === 'table') return false;
  return parent.type !== 'table_row';
}

function blockIdsFromDropTarget(target: DropTarget): BlockId[] {
  switch (target.kind) {
    case 'block-position':
      return target.referenceBlockId ? [target.referenceBlockId] : [];
    case 'column-position':
      return [target.columnListId, target.targetColumnId].filter((id): id is BlockId => id !== undefined);
    case 'table-position':
      return [target.tableBlockId, target.rowId as BlockId | undefined].filter((id): id is BlockId => id !== undefined);
    case 'database-view-position':
      return [target.databaseBlockId];
    case 'external-import':
      return target.referenceBlockId ? [target.referenceBlockId] : [];
    case 'invalid':
      return target.nearestValidTarget ? blockIdsFromDropTarget(target.nearestValidTarget) : [];
  }
}

function targetAllowsEffect(target: DropTarget, effect: DropEffect): boolean {
  if (target.kind === 'external-import') return effect === 'copy';
  if (target.kind === 'invalid') return false;
  if (effect === 'link') return false;
  return target.allowedEffects.includes(effect);
}

function allowedMoveCopyEffects(payload: DragPayload): readonly ('move' | 'copy')[] {
  const effects = payload.effectAllowed.filter((effect): effect is 'move' | 'copy' => effect === 'move' || effect === 'copy');
  return effects.length > 0 ? effects : ['move'];
}

function makeLineIndicatorRect(layout: LayoutRect, position: DropPosition): RectLike {
  const contentRect = layout.contentRect ?? layout.rect;
  const top = position === 'before' ? contentRect.top : contentRect.bottom - 2;
  return makeRect(contentRect.left, top, contentRect.width, 2);
}

function makeInsideIndicatorRect(layout: LayoutRect): RectLike {
  const rect = layout.childContentRect ?? layout.contentRect ?? layout.rect;
  return makeRect(rect.left, rect.top, Math.max(2, rect.width), Math.max(2, rect.height || 2));
}

function resolveTableDropTarget(layout: LayoutRect, pointer: Point, payload: DragPayload): TablePositionDropTarget | undefined {
  const tableBlockId = layout.tableBlockId ?? (layout.blockType === 'table' ? layout.blockId : undefined);
  if (!tableBlockId) return undefined;
  const zone = tableZoneAtPoint(layout.rect, pointer, { rowCount: 1, columnCount: 1 });
  if (zone.zone === 'outside') return undefined;
  const position = zone.zone === 'row-before' || zone.zone === 'row-after' || zone.zone === 'column-before' || zone.zone === 'column-after' ? zone.zone : 'cell';
  return {
    kind: 'table-position',
    tableBlockId,
    ...(layout.rowId !== undefined ? { rowId: layout.rowId } : {}),
    ...(layout.columnId !== undefined ? { columnId: layout.columnId } : {}),
    position,
    indicatorRect: position === 'cell' ? layout.rect : makeRect(layout.rect.left, pointer.y, layout.rect.width, 2),
    allowedEffects: allowedMoveCopyEffects(payload)
  };
}

function nestingDeltaForTarget(state: DocumentState, blockIds: readonly BlockId[], target: BlockPositionDropTarget): -1 | 0 | 1 {
  const first = blockIds[0];
  if (!first) return 0;
  const currentParent = parentIdForBlock(state, first);
  if (currentParent === target.parentId) return 0;
  if (target.position === 'inside-end' || target.position === 'inside-start') return 1;
  const currentParentBlock = currentParent ? state.blocks[currentParent as BlockId] : undefined;
  return currentParentBlock && target.parentId === parentIdForBlockRecord(currentParentBlock) ? -1 : 0;
}

function extractUrls(text: string): string[] {
  return text
    .split(/[\s\n\r]+/u)
    .map(part => part.trim())
    .filter(part => /^https?:\/\//iu.test(part))
    .filter(part => {
      try {
        const url = new URL(part);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    });
}

function extractAnchorUrls(html: string): string[] {
  const urls: string[] = [];
  const anchorPattern = /href\s*=\s*['"]([^'"]+)['"]/giu;
  let match = anchorPattern.exec(html);
  while (match) {
    const url = match[1];
    if (url && /^https?:\/\//iu.test(url)) urls.push(url);
    match = anchorPattern.exec(html);
  }
  return urls;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function uniqueBlockIds(values: readonly BlockId[]): BlockId[] {
  return [...new Set(values)];
}

function arraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function blockLabel(block: BlockRecord | undefined): string {
  if (!block) return 'unknown block';
  return block.type.replaceAll('_', ' ');
}
