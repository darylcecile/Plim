import { ModelError } from './errors.js';
import { defaultBlockData, systemClock, type Clock } from './factory.js';
import { createTransactionId, type IdFactory } from './ids.js';
import { normalizeRichText, plainTextFromRichText, replaceRichTextRange } from './rich-text.js';
import { findBlockLocation, getDescendantBlockIds, insertChildInState, isAncestorOf, moveBlockInState, removeChildFromState, requireBlock } from './tree.js';
import { normalizeDocumentState, validateDocumentState } from './validation.js';
import { cloneDeep, deepMerge, toJsonObject } from './utils.js';
import type {
  AddCommentOperation,
  AddRelationOperation,
  BlockId,
  BlockRecord,
  BlockType,
  CommentRecord,
  CreateBlockOperation,
  CreateDiscussionOperation,
  DataSourceProperty,
  DeepPartial,
  DiscussionRecord,
  DocumentState,
  FileRecord,
  InsertChildOperation,
  JsonObject,
  LifecycleState,
  MoveBlockOperation,
  Operation,
  PagePropertyValue,
  PageRecord,
  PropertyId,
  RemoveChildOperation,
  RemoveRelationOperation,
  RichText,
  SetBlockTypeOperation,
  SetLifecycleOperation,
  SetPagePropertyOperation,
  TransactionId,
  TransactionMetadata,
  TransactionRecord,
  UpdateBlockOperation,
  UpdatePageOperation,
  UpdatePropertySchemaOperation,
  UpsertDataSourceOperation,
  UpsertFileOperation,
  UpsertViewOperation,
  UserId,
  ValidationIssue,
  ViewRecord,
  WorkspaceId
} from './types.js';

export interface ApplyOperationOptions {
  clock?: Clock;
  actorId?: UserId;
}

export interface ApplyTransactionOptions extends ApplyOperationOptions {
  normalize?: boolean;
  validate?: boolean;
  recordTransaction?: boolean;
}

export interface CreateTransactionOptions {
  workspaceId: WorkspaceId;
  clientId: string;
  operations: Operation[];
  id?: TransactionId;
  actorId?: UserId;
  idFactory?: IdFactory;
  clock?: Clock;
  baseVersions?: Record<string, number>;
  metadata?: TransactionMetadata;
  status?: TransactionRecord['status'];
}

export type TransactionApplyResult =
  | { ok: true; state: DocumentState; transaction: TransactionRecord; issues: ValidationIssue[] }
  | { ok: false; state: DocumentState; transaction: TransactionRecord; issues: ValidationIssue[]; error: ModelError };

export function createTransaction(options: CreateTransactionOptions): TransactionRecord {
  const clock = options.clock ?? systemClock;
  const id = options.id ?? createTransactionId(options.idFactory);
  return {
    id,
    workspaceId: options.workspaceId,
    clientId: options.clientId,
    createdAt: clock.now(),
    baseVersions: options.baseVersions ?? {},
    operations: [...options.operations],
    status: options.status ?? 'pending',
    ...(options.actorId ? { actorId: options.actorId } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {})
  };
}

export function applyTransaction(state: DocumentState, transaction: TransactionRecord, options: ApplyTransactionOptions = {}): TransactionApplyResult {
  const original = state;
  let draft = cloneDeep(state);
  try {
    for (const operation of transaction.operations) {
      draft = applyOperation(draft, operation, options);
    }
    if (options.normalize !== false) draft = normalizeDocumentState(draft);
    const validation = options.validate === false ? { ok: true, issues: [] as ValidationIssue[] } : validateDocumentState(draft);
    if (!validation.ok) {
      const error = new ModelError('validation_failed', 'Transaction failed validation', validation.issues);
      return { ok: false, state: original, transaction: { ...transaction, status: 'rejected' }, issues: validation.issues, error };
    }
    const applied: TransactionRecord = { ...transaction, status: 'applied' };
    const next = options.recordTransaction === false
      ? draft
      : { ...draft, transactions: [...(draft.transactions ?? []), applied] };
    return { ok: true, state: next, transaction: applied, issues: validation.issues };
  } catch (cause) {
    const error = cause instanceof ModelError
      ? cause
      : new ModelError('operation_failed', cause instanceof Error ? cause.message : 'Operation failed');
    return { ok: false, state: original, transaction: { ...transaction, status: 'rejected' }, issues: error.issues ?? [], error };
  }
}

export function applyOperation(state: DocumentState, operation: Operation, options: ApplyOperationOptions = {}): DocumentState {
  switch (operation.op) {
    case 'create_block':
      return applyCreateBlock(state, operation, options);
    case 'update_block':
      return applyUpdateBlock(state, operation, options);
    case 'set_block_type':
      return applySetBlockType(state, operation, options);
    case 'insert_child':
      return applyInsertChild(state, operation, options);
    case 'move_block':
      return applyMoveBlock(state, operation, options);
    case 'remove_child':
      return applyRemoveChild(state, operation, options);
    case 'set_lifecycle':
      return applySetLifecycle(state, operation, options);
    case 'replace_rich_text':
      return applyReplaceRichText(state, operation, options);
    case 'update_page':
      return applyUpdatePage(state, operation, options);
    case 'upsert_data_source':
      return touchState({ ...state, dataSources: { ...state.dataSources, [operation.dataSource.id]: operation.dataSource } }, options);
    case 'update_property_schema':
      return applyUpdatePropertySchema(state, operation, options);
    case 'set_page_property':
      return applySetPageProperty(state, operation, options);
    case 'upsert_view':
      return applyUpsertView(state, operation, options);
    case 'add_relation':
      return applyAddRelation(state, operation, options);
    case 'remove_relation':
      return applyRemoveRelation(state, operation, options);
    case 'create_discussion':
      return applyCreateDiscussion(state, operation, options);
    case 'add_comment':
      return applyAddComment(state, operation, options);
    case 'upsert_file':
      return applyUpsertFile(state, operation, options);
  }
}

function applyCreateBlock(state: DocumentState, operation: CreateBlockOperation, options: ApplyOperationOptions): DocumentState {
  if (state.blocks[operation.block.id]) throw new ModelError('duplicate_record', `Block ${String(operation.block.id)} already exists`);
  return touchState({ ...state, blocks: { ...state.blocks, [operation.block.id]: operation.block } }, options);
}

function applyUpdateBlock(state: DocumentState, operation: UpdateBlockOperation, options: ApplyOperationOptions): DocumentState {
  const block = requireBlock(state, operation.blockId);
  const merged = deepMerge<BlockRecord>(block, operation.patch);
  const nextBlock = touchBlock({ ...merged, id: block.id, workspaceId: block.workspaceId, version: Math.max(block.version + 1, merged.version) }, options);
  return touchState({ ...state, blocks: { ...state.blocks, [block.id]: nextBlock } }, options);
}

function applySetBlockType(state: DocumentState, operation: SetBlockTypeOperation, options: ApplyOperationOptions): DocumentState {
  const block = requireBlock(state, operation.blockId);
  const defaults = defaultBlockData(operation.type);
  const data = operation.dataPatch
    ? deepMerge(defaults, operation.dataPatch as DeepPartial<typeof defaults>)
    : defaults;
  const nextBlock: BlockRecord = touchBlock({
    ...block,
    type: operation.type,
    data: data as BlockRecord['data'],
    version: block.version + 1,
    ...(operation.preservePreviousData ? { preservedData: toJsonObject(block.data) } : {})
  }, options);
  return touchState({ ...state, blocks: { ...state.blocks, [block.id]: nextBlock } }, options);
}

function applyInsertChild(state: DocumentState, operation: InsertChildOperation, options: ApplyOperationOptions): DocumentState {
  requireBlock(state, operation.childId);
  requireBlock(state, operation.parentId as BlockId);
  const currentLocation = findBlockLocation(state, operation.childId);
  const withoutCurrent = currentLocation && currentLocation.parentId !== operation.parentId
    ? removeChildFromState(state, currentLocation.parentId, operation.childId)
    : state;
  return touchState(insertChildInState(withoutCurrent, operation.parentId, operation.childId, operation.at), options);
}

function applyMoveBlock(state: DocumentState, operation: MoveBlockOperation, options: ApplyOperationOptions): DocumentState {
  requireBlock(state, operation.blockId);
  requireBlock(state, operation.newParentId as BlockId);
  if (operation.blockId === operation.newParentId || isAncestorOf(state, operation.blockId, operation.newParentId as BlockId)) {
    throw new ModelError('invalid_parent', 'Cannot move a block under itself or its descendant');
  }
  return touchState(moveBlockInState(state, operation.blockId, operation.newParentId, operation.at), options);
}

function applyRemoveChild(state: DocumentState, operation: RemoveChildOperation, options: ApplyOperationOptions): DocumentState {
  const child = requireBlock(state, operation.childId);
  let next = removeChildFromState(state, operation.parentId, operation.childId);
  if (operation.mode === 'detach') {
    next = {
      ...next,
      blocks: {
        ...next.blocks,
        [child.id]: touchBlock({ ...child, parent: { kind: 'workspace', workspaceId: state.workspace.id }, version: child.version + 1 }, options)
      }
    };
  } else if (operation.mode === 'trash') {
    next = setBlockLifecycle(next, child.id, 'trashed', true, options);
  } else {
    next = deleteBlockSubtree(next, child.id);
  }
  return touchState(next, options);
}

function applySetLifecycle(state: DocumentState, operation: SetLifecycleOperation, options: ApplyOperationOptions): DocumentState {
  switch (operation.record.kind) {
    case 'block':
      return touchState(setBlockLifecycle(state, operation.record.id, operation.lifecycle, operation.cascade ?? false, options), options);
    case 'page':
      return touchState(setPageLifecycle(state, operation.record.id, operation.lifecycle, options), options);
    case 'database': {
      const current = state.databases[operation.record.id];
      if (!current) throw new ModelError('missing_record', `Database ${String(operation.record.id)} does not exist`);
      return touchState({ ...state, databases: { ...state.databases, [current.id]: { ...current, lifecycle: operation.lifecycle, version: current.version + 1 } } }, options);
    }
    case 'data_source': {
      const current = state.dataSources[operation.record.id];
      if (!current) throw new ModelError('missing_record', `Data source ${String(operation.record.id)} does not exist`);
      return touchState({ ...state, dataSources: { ...state.dataSources, [current.id]: { ...current, lifecycle: operation.lifecycle, version: current.version + 1 } } }, options);
    }
    case 'discussion': {
      const current = state.discussions[operation.record.id];
      if (!current) throw new ModelError('missing_record', `Discussion ${String(operation.record.id)} does not exist`);
      const status = operation.lifecycle === 'active' ? 'open' : 'resolved';
      return touchState({ ...state, discussions: { ...state.discussions, [current.id]: { ...current, status, version: current.version + 1 } } }, options);
    }
    case 'comment': {
      const current = state.comments[operation.record.id];
      if (!current) throw new ModelError('missing_record', `Comment ${String(operation.record.id)} does not exist`);
      return touchState({ ...state, comments: { ...state.comments, [current.id]: touchComment({ ...current, lifecycle: operation.lifecycle, version: current.version + 1 }, options) } }, options);
    }
    case 'file': {
      const current = state.files[operation.record.id];
      if (!current) throw new ModelError('missing_record', `File ${String(operation.record.id)} does not exist`);
      return touchState({ ...state, files: { ...state.files, [current.id]: touchFile({ ...current, version: current.version + 1 }, options) } }, options);
    }
    case 'view': {
      const current = state.views[operation.record.id];
      if (!current) throw new ModelError('missing_record', `View ${String(operation.record.id)} does not exist`);
      return touchState({ ...state, views: { ...state.views, [current.id]: touchView({ ...current, version: current.version + 1 }, options) } }, options);
    }
  }
}

function applyReplaceRichText(state: DocumentState, operation: Operation & { op: 'replace_rich_text' }, options: ApplyOperationOptions): DocumentState {
  const replacement = normalizeRichText(operation.replacement);
  const field = operation.target.field;
  if (field.kind === 'block_data') {
    const blockId = operation.target.blockId;
    if (!blockId) throw new ModelError('missing_record', 'replace_rich_text target.blockId is required for block_data fields');
    const block = requireBlock(state, blockId);
    const dataRecord = block.data as Record<string, unknown>;
    const current = dataRecord[field.key];
    if (!Array.isArray(current)) throw new ModelError('invalid_rich_text', `Block field ${field.key} is not rich text`);
    const nextRichText = replaceRichTextRange(current as RichText, operation.range, replacement);
    const nextBlock = touchBlock({ ...block, data: { ...dataRecord, [field.key]: nextRichText } as BlockRecord['data'], version: block.version + 1 }, options);
    return touchState({ ...state, blocks: { ...state.blocks, [block.id]: nextBlock } }, options);
  }
  if (field.kind === 'page_property') {
    const page = state.pages[field.pageId];
    if (!page) throw new ModelError('missing_record', `Page ${String(field.pageId)} does not exist`);
    const property = page.properties[field.propertyId];
    if (!property || (property.type !== 'title' && property.type !== 'rich_text')) throw new ModelError('invalid_rich_text', 'Page property is not rich text');
    const current = property.type === 'title' ? property.title : property.richText;
    const nextRichText = replaceRichTextRange(current, operation.range, replacement);
    const value: PagePropertyValue = property.type === 'title'
      ? { ...property, title: nextRichText }
      : { ...property, richText: nextRichText };
    return applySetPageProperty(state, { op: 'set_page_property', pageId: field.pageId, propertyId: field.propertyId, value }, options);
  }
  const comment = state.comments[field.commentId];
  if (!comment) throw new ModelError('missing_record', `Comment ${String(field.commentId)} does not exist`);
  const nextComment = touchComment({ ...comment, richText: replaceRichTextRange(comment.richText, operation.range, replacement), version: comment.version + 1 }, options);
  return touchState({ ...state, comments: { ...state.comments, [comment.id]: nextComment } }, options);
}

function applyUpdatePage(state: DocumentState, operation: UpdatePageOperation, options: ApplyOperationOptions): DocumentState {
  const page = state.pages[operation.pageId];
  if (!page) throw new ModelError('missing_record', `Page ${String(operation.pageId)} does not exist`);
  const merged = deepMerge<PageRecord>(page, operation.patch);
  const nextPage = touchPage({ ...merged, id: page.id, workspaceId: page.workspaceId, version: Math.max(page.version + 1, merged.version) }, options);
  return touchState({ ...state, pages: { ...state.pages, [page.id]: nextPage } }, options);
}

function applyUpdatePropertySchema(state: DocumentState, operation: UpdatePropertySchemaOperation, options: ApplyOperationOptions): DocumentState {
  const dataSource = state.dataSources[operation.dataSourceId];
  if (!dataSource) throw new ModelError('missing_record', `Data source ${String(operation.dataSourceId)} does not exist`);
  const property = dataSource.properties[operation.propertyId];
  if (!property) throw new ModelError('missing_record', `Property ${String(operation.propertyId)} does not exist`);
  const nextProperty = deepMerge(property, operation.patch) as DataSourceProperty;
  const nextDataSource = touchDataSource({
    ...dataSource,
    properties: { ...dataSource.properties, [operation.propertyId]: nextProperty },
    version: dataSource.version + 1
  }, options);
  return touchState({ ...state, dataSources: { ...state.dataSources, [dataSource.id]: nextDataSource } }, options);
}

function applySetPageProperty(state: DocumentState, operation: SetPagePropertyOperation, options: ApplyOperationOptions): DocumentState {
  const page = state.pages[operation.pageId];
  if (!page) throw new ModelError('missing_record', `Page ${String(operation.pageId)} does not exist`);
  let nextPage = touchPage({
    ...page,
    properties: { ...page.properties, [operation.propertyId]: operation.value },
    version: page.version + 1
  }, options);
  let nextBlocks = state.blocks;
  if (operation.value.type === 'title') {
    nextPage = { ...nextPage, titlePlain: plainTextFromRichText(operation.value.title) };
    const block = state.blocks[operation.pageId];
    if (block?.type === 'page') {
      nextBlocks = {
        ...state.blocks,
        [block.id]: touchBlock({ ...block, data: { ...block.data, title: operation.value.title }, version: block.version + 1 }, options)
      };
    }
  }
  return touchState({ ...state, pages: { ...state.pages, [page.id]: nextPage }, blocks: nextBlocks }, options);
}

function applyUpsertView(state: DocumentState, operation: UpsertViewOperation, options: ApplyOperationOptions): DocumentState {
  return touchState({ ...state, views: { ...state.views, [operation.view.id]: touchView(operation.view, options) } }, options);
}

function applyAddRelation(state: DocumentState, operation: AddRelationOperation, options: ApplyOperationOptions): DocumentState {
  const page = state.pages[operation.pageId];
  if (!page) throw new ModelError('missing_record', `Page ${String(operation.pageId)} does not exist`);
  if (!state.pages[operation.targetPageId]) throw new ModelError('missing_record', `Target page ${String(operation.targetPageId)} does not exist`);
  const current = page.properties[operation.propertyId];
  const relation: PagePropertyValue = current?.type === 'relation'
    ? { ...current, relation: current.relation.some(ref => ref.pageId === operation.targetPageId) ? current.relation : [...current.relation, { pageId: operation.targetPageId }] }
    : { id: operation.propertyId, type: 'relation', relation: [{ pageId: operation.targetPageId }] };
  return applySetPageProperty(state, { op: 'set_page_property', pageId: operation.pageId, propertyId: operation.propertyId, value: relation }, options);
}

function applyRemoveRelation(state: DocumentState, operation: RemoveRelationOperation, options: ApplyOperationOptions): DocumentState {
  const page = state.pages[operation.pageId];
  if (!page) throw new ModelError('missing_record', `Page ${String(operation.pageId)} does not exist`);
  const current = page.properties[operation.propertyId];
  if (current?.type !== 'relation') return state;
  const relation: PagePropertyValue = { ...current, relation: current.relation.filter(ref => ref.pageId !== operation.targetPageId) };
  return applySetPageProperty(state, { op: 'set_page_property', pageId: operation.pageId, propertyId: operation.propertyId, value: relation }, options);
}

function applyCreateDiscussion(state: DocumentState, operation: CreateDiscussionOperation, options: ApplyOperationOptions): DocumentState {
  if (state.discussions[operation.discussion.id]) throw new ModelError('duplicate_record', `Discussion ${String(operation.discussion.id)} already exists`);
  return touchState({ ...state, discussions: { ...state.discussions, [operation.discussion.id]: touchDiscussion(operation.discussion, options) } }, options);
}

function applyAddComment(state: DocumentState, operation: AddCommentOperation, options: ApplyOperationOptions): DocumentState {
  if (state.comments[operation.comment.id]) throw new ModelError('duplicate_record', `Comment ${String(operation.comment.id)} already exists`);
  const discussion = state.discussions[operation.comment.discussionId];
  if (!discussion) throw new ModelError('missing_record', `Discussion ${String(operation.comment.discussionId)} does not exist`);
  const nextDiscussion: DiscussionRecord = {
    ...discussion,
    commentIds: discussion.commentIds.includes(operation.comment.id) ? discussion.commentIds : [...discussion.commentIds, operation.comment.id],
    version: discussion.version + 1
  };
  return touchState({
    ...state,
    discussions: { ...state.discussions, [discussion.id]: nextDiscussion },
    comments: { ...state.comments, [operation.comment.id]: touchComment(operation.comment, options) }
  }, options);
}

function applyUpsertFile(state: DocumentState, operation: UpsertFileOperation, options: ApplyOperationOptions): DocumentState {
  return touchState({ ...state, files: { ...state.files, [operation.file.id]: touchFile(operation.file, options) } }, options);
}

function setBlockLifecycle(state: DocumentState, blockId: BlockId, lifecycle: LifecycleState, cascade: boolean, options: ApplyOperationOptions): DocumentState {
  const block = requireBlock(state, blockId);
  const ids = cascade ? [blockId, ...getDescendantBlockIds(state, blockId)] : [blockId];
  const blocks = { ...state.blocks };
  const pages = { ...state.pages };
  for (const id of ids) {
    const current = blocks[id];
    if (!current) continue;
    blocks[id] = touchBlock({ ...current, lifecycle, version: current.version + 1 }, options);
    const page = pages[id as keyof typeof pages];
    if (page) pages[id as keyof typeof pages] = touchPage({ ...page, lifecycle, version: page.version + 1 }, options);
  }
  return { ...state, blocks, pages };
}

function setPageLifecycle(state: DocumentState, pageId: PageRecord['id'], lifecycle: LifecycleState, options: ApplyOperationOptions): DocumentState {
  const page = state.pages[pageId];
  if (!page) throw new ModelError('missing_record', `Page ${String(pageId)} does not exist`);
  return setBlockLifecycle(state, pageId, lifecycle, true, options);
}

function deleteBlockSubtree(state: DocumentState, blockId: BlockId): DocumentState {
  const deleteIds = new Set<BlockId>([blockId, ...getDescendantBlockIds(state, blockId)]);
  const blocks = { ...state.blocks };
  const pages = { ...state.pages };
  for (const id of deleteIds) {
    delete blocks[id];
    delete pages[id as keyof typeof pages];
  }
  return {
    ...state,
    blocks,
    pages,
    workspace: {
      ...state.workspace,
      rootPageIds: state.workspace.rootPageIds.filter(id => !deleteIds.has(id)),
      version: state.workspace.version + 1
    }
  };
}

function touchState(state: DocumentState, options: ApplyOperationOptions): DocumentState {
  const clock = options.clock ?? systemClock;
  return {
    ...state,
    schema: {
      ...state.schema,
      updatedAt: clock.now()
    }
  };
}

function touchBlock<T extends BlockRecord>(block: T, options: ApplyOperationOptions): T {
  return touchAudit(block, options);
}

function touchPage<T extends PageRecord>(page: T, options: ApplyOperationOptions): T {
  return touchAudit(page, options);
}

function touchDataSource<T extends UpsertDataSourceOperation['dataSource']>(dataSource: T, options: ApplyOperationOptions): T {
  return touchAudit(dataSource, options);
}

function touchView<T extends ViewRecord>(view: T, options: ApplyOperationOptions): T {
  return touchAudit(view, options);
}

function touchDiscussion<T extends DiscussionRecord>(discussion: T, options: ApplyOperationOptions): T {
  return touchAudit(discussion, options);
}

function touchComment<T extends CommentRecord>(comment: T, options: ApplyOperationOptions): T {
  return touchAudit(comment, options);
}

function touchFile<T extends FileRecord>(file: T, options: ApplyOperationOptions): T {
  return touchAudit(file, options);
}

function touchAudit<T extends { lastEditedAt: string; lastEditedBy?: UserId }>(record: T, options: ApplyOperationOptions): T {
  const clock = options.clock ?? systemClock;
  return {
    ...record,
    lastEditedAt: clock.now(),
    ...(options.actorId ? { lastEditedBy: options.actorId } : {})
  };
}
