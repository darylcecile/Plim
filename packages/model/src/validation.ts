import { MODEL_FORMAT, MODEL_VERSION, TITLE_PROPERTY_ID } from './factory.js';
import { normalizeRichText, plainTextFromRichText } from './rich-text.js';
import { parentRefForContainer } from './tree.js';
import { cloneDeep, uniqueStable } from './utils.js';
import type {
  BlockDataByType,
  BlockId,
  BlockRecord,
  BlockType,
  CommentRecord,
  DataSourceRecord,
  DiscussionRecord,
  DocumentState,
  FileRef,
  JsonObject,
  PagePropertyValue,
  PageRecord,
  ParentRef,
  RecordRef,
  RichText,
  RichTextSpan,
  ValidationCode,
  ValidationIssue,
  ValidationResult
} from './types.js';

export interface ValidationOptions {
  normalize?: boolean;
}

export function normalizeDocumentState(state: DocumentState): DocumentState {
  const next = cloneDeep(state);
  next.schema = {
    ...next.schema,
    format: next.schema.format,
    version: next.schema.version,
    updatedAt: next.schema.updatedAt
  };
  next.workspace.rootPageIds = uniqueStable(next.workspace.rootPageIds).filter(id => Boolean(next.pages[id] && next.blocks[id]));
  next.workspace.rootDatabaseIds = uniqueStable(next.workspace.rootDatabaseIds).filter(id => Boolean(next.databases[id]));

  const seenChildren = new Set<BlockId>();
  for (const block of Object.values(next.blocks)) {
    const normalizedChildren: BlockId[] = [];
    for (const childId of block.children) {
      const child = next.blocks[childId];
      if (!child || seenChildren.has(childId)) continue;
      seenChildren.add(childId);
      normalizedChildren.push(childId);
      child.parent = parentRefForContainer(next, block.id);
    }
    block.children = normalizedChildren;
    block.data = normalizeBlockData(block.type, block.data) as BlockDataByType[BlockType];
  }

  for (const page of Object.values(next.pages)) {
    page.properties = normalizePageProperties(page.properties);
    const titleValue = page.properties[TITLE_PROPERTY_ID];
    const title = titleValue?.type === 'title'
      ? titleValue.title
      : next.blocks[page.id]?.type === 'page'
        ? (next.blocks[page.id] as BlockRecord<'page'>).data.title
        : [];
    page.titlePlain = plainTextFromRichText(title);
    if (next.blocks[page.id]?.type === 'page') {
      (next.blocks[page.id] as BlockRecord<'page'>).data.title = title;
    }
  }

  for (const comment of Object.values(next.comments)) {
    comment.richText = normalizeRichText(comment.richText);
  }

  for (const discussion of Object.values(next.discussions)) {
    discussion.commentIds = uniqueStable(discussion.commentIds).filter(id => next.comments[id]?.discussionId === discussion.id);
  }

  return next;
}

export function validateDocumentState(state: DocumentState, options: ValidationOptions = {}): ValidationResult {
  const issues: ValidationIssue[] = [];
  const normalized = options.normalize ? normalizeDocumentState(state) : undefined;
  const target = normalized ?? state;

  if (target.schema.format !== MODEL_FORMAT) {
    issues.push(issue('error', 'schema_mismatch', `Unsupported schema format ${String(target.schema.format)}`, 'schema.format', undefined, 'none'));
  }
  if (target.schema.version !== MODEL_VERSION) {
    issues.push(issue('error', 'version_unsupported', `Unsupported schema version ${String(target.schema.version)}`, 'schema.version', undefined, 'none'));
  }

  validateWorkspaceRoots(target, issues);
  validateRecordWorkspaceIds(target, issues);
  validatePages(target, issues);
  validateBlockStructure(target, issues);
  validateBlockData(target, issues);
  validateDataSources(target, issues);
  validateDiscussions(target, issues);

  return {
    ok: !issues.some(item => item.severity === 'error'),
    issues,
    ...(normalized ? { normalized } : {})
  };
}

function validateWorkspaceRoots(state: DocumentState, issues: ValidationIssue[]): void {
  for (const pageId of state.workspace.rootPageIds) {
    const page = state.pages[pageId];
    const block = state.blocks[pageId];
    if (!page || !block) {
      issues.push(issue('error', 'missing_record', `Root page ${String(pageId)} is missing`, 'workspace.rootPageIds', { kind: 'page', id: pageId }, 'manual'));
      continue;
    }
    if (block.parent.kind !== 'workspace' || block.parent.workspaceId !== state.workspace.id) {
      issues.push(issue('error', 'invalid_parent', `Root page ${String(pageId)} must be workspace-parented`, `blocks.${String(pageId)}.parent`, { kind: 'block', id: pageId }, 'manual'));
    }
  }
  for (const databaseId of state.workspace.rootDatabaseIds) {
    if (!state.databases[databaseId]) {
      issues.push(issue('error', 'missing_record', `Root database ${String(databaseId)} is missing`, 'workspace.rootDatabaseIds', { kind: 'database', id: databaseId }, 'manual'));
    }
  }
}

function validateRecordWorkspaceIds(state: DocumentState, issues: ValidationIssue[]): void {
  const workspaceId = state.workspace.id;
  for (const block of Object.values(state.blocks)) {
    if (block.workspaceId !== workspaceId) issues.push(issue('error', 'schema_mismatch', `Block ${String(block.id)} has a foreign workspace`, `blocks.${String(block.id)}.workspaceId`, { kind: 'block', id: block.id }, 'manual'));
  }
  for (const page of Object.values(state.pages)) {
    if (page.workspaceId !== workspaceId) issues.push(issue('error', 'schema_mismatch', `Page ${String(page.id)} has a foreign workspace`, `pages.${String(page.id)}.workspaceId`, { kind: 'page', id: page.id }, 'manual'));
  }
  for (const file of Object.values(state.files)) {
    if (file.workspaceId !== workspaceId) issues.push(issue('error', 'schema_mismatch', `File ${String(file.id)} has a foreign workspace`, `files.${String(file.id)}.workspaceId`, { kind: 'file', id: file.id }, 'manual'));
  }
}

function validatePages(state: DocumentState, issues: ValidationIssue[]): void {
  for (const page of Object.values(state.pages)) {
    const block = state.blocks[page.id];
    if (!block) {
      issues.push(issue('error', 'missing_record', `Page ${String(page.id)} has no backing block`, `pages.${String(page.id)}`, { kind: 'page', id: page.id }, 'manual'));
      continue;
    }
    if (block.type !== 'page') {
      issues.push(issue('error', 'schema_mismatch', `Page ${String(page.id)} backing block must be type page`, `blocks.${String(block.id)}.type`, { kind: 'block', id: block.id }, 'manual'));
    }
    const titleValue = page.properties[TITLE_PROPERTY_ID];
    if (!titleValue || titleValue.type !== 'title') {
      issues.push(issue('error', 'property_type_mismatch', `Page ${String(page.id)} must have a title property`, `pages.${String(page.id)}.properties.title`, { kind: 'page', id: page.id }, 'manual'));
    } else if (page.titlePlain !== plainTextFromRichText(titleValue.title)) {
      issues.push(issue('warning', 'schema_mismatch', `Page ${String(page.id)} titlePlain does not match title property`, `pages.${String(page.id)}.titlePlain`, { kind: 'page', id: page.id }, 'auto'));
    }
  }
}

function validateBlockStructure(state: DocumentState, issues: ValidationIssue[]): void {
  const childOwners = new Map<BlockId, BlockId>();
  for (const block of Object.values(state.blocks)) {
    const localSeen = new Set<BlockId>();
    for (const childId of block.children) {
      const child = state.blocks[childId];
      if (!child) {
        issues.push(issue('error', 'missing_record', `Child block ${String(childId)} is missing`, `blocks.${String(block.id)}.children`, { kind: 'block', id: block.id }, 'auto'));
        continue;
      }
      if (localSeen.has(childId)) {
        issues.push(issue('error', 'duplicate_child', `Child ${String(childId)} appears more than once`, `blocks.${String(block.id)}.children`, { kind: 'block', id: block.id }, 'auto'));
      }
      localSeen.add(childId);
      const owner = childOwners.get(childId);
      if (owner && owner !== block.id) {
        issues.push(issue('error', 'duplicate_child', `Child ${String(childId)} appears under multiple parents`, `blocks.${String(block.id)}.children`, { kind: 'block', id: childId }, 'manual'));
      }
      childOwners.set(childId, block.id);
      if (!parentMatches(state, child.parent, block.id)) {
        issues.push(issue('error', 'parent_child_mismatch', `Child ${String(childId)} parent does not match ${String(block.id)}`, `blocks.${String(childId)}.parent`, { kind: 'block', id: childId }, 'auto'));
      }
    }
  }

  const visiting = new Set<BlockId>();
  const visited = new Set<BlockId>();
  const visit = (blockId: BlockId): void => {
    if (visited.has(blockId)) return;
    if (visiting.has(blockId)) {
      issues.push(issue('error', 'cycle', `Block ${String(blockId)} participates in a render cycle`, `blocks.${String(blockId)}.children`, { kind: 'block', id: blockId }, 'manual'));
      return;
    }
    visiting.add(blockId);
    for (const childId of state.blocks[blockId]?.children ?? []) visit(childId);
    visiting.delete(blockId);
    visited.add(blockId);
  };
  for (const blockId of Object.keys(state.blocks) as BlockId[]) visit(blockId);
}

function validateBlockData(state: DocumentState, issues: ValidationIssue[]): void {
  for (const block of Object.values(state.blocks)) {
    if (block.type === 'unsupported') {
      issues.push(issue('warning', 'unknown_type_preserved', `Unsupported block ${String(block.id)} is preserved`, `blocks.${String(block.id)}.data`, { kind: 'block', id: block.id }, 'none'));
    }
    validateRichTextFields(block, issues);
    validateBlockUrlsAndFiles(state, block, issues);
  }
}

function validateDataSources(state: DocumentState, issues: ValidationIssue[]): void {
  for (const dataSource of Object.values(state.dataSources)) {
    const titleProperties = Object.values(dataSource.properties).filter(property => property.type === 'title');
    if (titleProperties.length !== 1) {
      issues.push(issue('warning', 'schema_mismatch', `Data source ${String(dataSource.id)} should have exactly one title property`, `dataSources.${String(dataSource.id)}.properties`, { kind: 'data_source', id: dataSource.id }, 'manual'));
    }
    for (const pageId of Object.keys(dataSource.entries) as (keyof DataSourceRecord['entries'])[]) {
      if (!state.pages[pageId]) {
        issues.push(issue('error', 'missing_record', `Data source entry page ${String(pageId)} is missing`, `dataSources.${String(dataSource.id)}.entries`, { kind: 'data_source', id: dataSource.id }, 'manual'));
      }
    }
  }
}

function validateDiscussions(state: DocumentState, issues: ValidationIssue[]): void {
  for (const discussion of Object.values(state.discussions)) {
    validateAnchor(state, discussion, issues);
    for (const commentId of discussion.commentIds) {
      const comment = state.comments[commentId];
      if (!comment || comment.discussionId !== discussion.id) {
        issues.push(issue('error', 'comment_anchor_invalid', `Discussion ${String(discussion.id)} references invalid comment ${String(commentId)}`, `discussions.${String(discussion.id)}.commentIds`, { kind: 'discussion', id: discussion.id }, 'manual'));
      }
    }
  }
  for (const comment of Object.values(state.comments)) {
    if (!state.discussions[comment.discussionId]) {
      issues.push(issue('error', 'comment_anchor_invalid', `Comment ${String(comment.id)} references missing discussion`, `comments.${String(comment.id)}.discussionId`, { kind: 'comment', id: comment.id }, 'manual'));
    }
  }
}

function validateAnchor(state: DocumentState, discussion: DiscussionRecord, issues: ValidationIssue[]): void {
  const anchor = discussion.anchor;
  if (anchor.kind === 'page' && !state.pages[anchor.pageId]) {
    issues.push(issue('error', 'comment_anchor_invalid', `Discussion ${String(discussion.id)} anchors missing page`, `discussions.${String(discussion.id)}.anchor`, { kind: 'discussion', id: discussion.id }, 'manual'));
  } else if ((anchor.kind === 'block' || anchor.kind === 'rich_text_range') && !state.blocks[anchor.blockId]) {
    issues.push(issue('error', 'comment_anchor_invalid', `Discussion ${String(discussion.id)} anchors missing block`, `discussions.${String(discussion.id)}.anchor`, { kind: 'discussion', id: discussion.id }, 'manual'));
  } else if (anchor.kind === 'property' && !state.pages[anchor.pageId]?.properties[anchor.propertyId]) {
    issues.push(issue('error', 'comment_anchor_invalid', `Discussion ${String(discussion.id)} anchors missing property`, `discussions.${String(discussion.id)}.anchor`, { kind: 'discussion', id: discussion.id }, 'manual'));
  }
}

function parentMatches(state: DocumentState, actual: ParentRef, parentId: BlockId): boolean {
  const expected = parentRefForContainer(state, parentId);
  if (expected.kind === 'page') return actual.kind === 'page' && actual.pageId === expected.pageId;
  if (expected.kind === 'block') return actual.kind === 'block' && actual.blockId === expected.blockId;
  return false;
}

function normalizeBlockData<T extends BlockType>(type: T, data: BlockDataByType[T]): BlockDataByType[T] {
  switch (type) {
    case 'paragraph':
    case 'heading_1':
    case 'heading_2':
    case 'heading_3':
    case 'bulleted_list_item':
    case 'numbered_list_item':
    case 'to_do':
    case 'toggle':
    case 'toggle_heading_1':
    case 'toggle_heading_2':
    case 'toggle_heading_3':
    case 'quote':
    case 'callout':
    case 'code':
    case 'template':
      return { ...data, richText: normalizeRichText((data as { richText: RichText }).richText ?? []) } as BlockDataByType[T];
    case 'page':
      return { ...data, title: normalizeRichText((data as BlockDataByType['page']).title ?? []) } as BlockDataByType[T];
    case 'table_row':
      return { ...data, cells: ((data as BlockDataByType['table_row']).cells ?? []).map(normalizeRichText) } as BlockDataByType[T];
    case 'image':
    case 'video':
    case 'audio':
    case 'file':
    case 'pdf':
    case 'bookmark':
    case 'embed': {
      const maybeCaption = data as { caption?: RichText };
      return maybeCaption.caption ? { ...data, caption: normalizeRichText(maybeCaption.caption) } as BlockDataByType[T] : data;
    }
    case 'equation': {
      const equation = data as BlockDataByType['equation'];
      return equation.caption ? { ...data, caption: normalizeRichText(equation.caption) } as BlockDataByType[T] : data;
    }
    default:
      return data;
  }
}

function normalizePageProperties(properties: PageRecord['properties']): PageRecord['properties'] {
  const next: PageRecord['properties'] = { ...properties };
  for (const [id, value] of Object.entries(next) as [keyof PageRecord['properties'], PagePropertyValue][]) {
    next[id] = normalizePagePropertyValue(value);
  }
  return next;
}

function normalizePagePropertyValue(value: PagePropertyValue): PagePropertyValue {
  if (value.type === 'title') return { ...value, title: normalizeRichText(value.title) };
  if (value.type === 'rich_text') return { ...value, richText: normalizeRichText(value.richText) };
  return value;
}

function validateRichTextFields(block: BlockRecord, issues: ValidationIssue[]): void {
  const validate = (richText: RichText, path: string): void => {
    for (let index = 0; index < richText.length; index += 1) {
      const span = richText[index];
      if (!span) continue;
      validateSpan(span, `${path}.${index}`, issues, block.id);
    }
  };
  const data = block.data as { richText?: RichText; title?: RichText; caption?: RichText; cells?: RichText[] };
  if (data.richText) validate(data.richText, `blocks.${String(block.id)}.data.richText`);
  if (data.title) validate(data.title, `blocks.${String(block.id)}.data.title`);
  if (data.caption) validate(data.caption, `blocks.${String(block.id)}.data.caption`);
  if (data.cells) data.cells.forEach((cell, index) => validate(cell, `blocks.${String(block.id)}.data.cells.${index}`));
}

function validateSpan(span: RichTextSpan, path: string, issues: ValidationIssue[], blockId: BlockId): void {
  if (span.type === 'text') {
    if (span.text.content.length === 0) issues.push(issue('info', 'invalid_rich_text', 'Empty text span should be normalized away', path, { kind: 'block', id: blockId }, 'auto'));
    if (span.text.link && !isAllowedUrl(span.text.link.url)) issues.push(issue('error', 'invalid_url', `Unsafe URL ${span.text.link.url}`, `${path}.text.link.url`, { kind: 'block', id: blockId }, 'manual'));
  } else if (span.type === 'mention') {
    if ((span.mention.kind === 'external' || span.mention.kind === 'link_preview') && !isAllowedUrl(span.mention.url)) {
      issues.push(issue('error', 'invalid_url', `Unsafe mention URL ${span.mention.url}`, `${path}.mention.url`, { kind: 'block', id: blockId }, 'manual'));
    }
  }
}

function validateBlockUrlsAndFiles(state: DocumentState, block: BlockRecord, issues: ValidationIssue[]): void {
  const data = block.data as { url?: string; file?: FileRef };
  if (data.url && !isAllowedUrl(data.url)) {
    issues.push(issue('error', 'invalid_url', `Unsafe block URL ${data.url}`, `blocks.${String(block.id)}.data.url`, { kind: 'block', id: block.id }, 'manual'));
  }
  if (data.file) validateFileRef(state, data.file, `blocks.${String(block.id)}.data.file`, { kind: 'block', id: block.id }, issues);
}

function validateFileRef(state: DocumentState, file: FileRef, path: string, record: RecordRef, issues: ValidationIssue[]): void {
  if (file.type === 'file' && !state.files[file.fileId]) {
    issues.push(issue('error', 'file_reference_invalid', `File reference ${String(file.fileId)} is missing`, path, record, 'manual'));
  } else if (file.type === 'external' && !isAllowedUrl(file.url)) {
    issues.push(issue('error', 'invalid_url', `Unsafe file URL ${file.url}`, path, record, 'manual'));
  } else if (file.type === 'data_url' && !file.dataUrl.startsWith('data:')) {
    issues.push(issue('error', 'file_reference_invalid', 'Data URL file reference must start with data:', path, record, 'manual'));
  }
}

export function isAllowedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' || url.protocol === 'tel:';
  } catch {
    return false;
  }
}

function issue(
  severity: ValidationIssue['severity'],
  code: ValidationCode,
  message: string,
  path: string,
  record?: RecordRef,
  fix?: ValidationIssue['fix']
): ValidationIssue {
  return {
    severity,
    code,
    message,
    path,
    ...(record ? { record } : {}),
    ...(fix ? { fix } : {})
  };
}

export function createUnsupportedBlockData(originalType: string, raw: JsonObject): BlockDataByType['unsupported'] {
  return { originalType, raw };
}

export function normalizeComment(comment: CommentRecord): CommentRecord {
  return { ...comment, richText: normalizeRichText(comment.richText) };
}
