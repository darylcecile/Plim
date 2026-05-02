import { asDataSourceId, asDatabaseId, asPageId, asPropertyId, asViewId, createBlockId, createIdFactory, createPageId, createWorkspaceId, type IdFactory } from './ids.js';
import { plainTextFromRichText, richTextFromPlainText } from './rich-text.js';
import type {
  AuditMetadata,
  BlockDataByType,
  BlockId,
  BlockRecord,
  BlockType,
  DataSourceId,
  DatabaseId,
  DocumentState,
  ISODateTime,
  PageId,
  PageRecord,
  ParentRef,
  PropertyId,
  RichText,
  UserId,
  ViewId,
  WorkspaceId
} from './types.js';

export const MODEL_FORMAT = 'notion-next-document' as const;
export const MODEL_VERSION = 1 as const;
export const TITLE_PROPERTY_ID: PropertyId = asPropertyId('title');

export interface Clock {
  now(): ISODateTime;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString()
};

export interface CreateDocumentOptions {
  workspaceId?: WorkspaceId;
  pageId?: PageId;
  title?: string | RichText;
  workspaceName?: string;
  idFactory?: IdFactory;
  clock?: Clock;
  actorId?: UserId;
  appVersion?: string;
}

export interface CreateBlockOptions<T extends BlockType = BlockType> {
  id?: BlockId;
  workspaceId: WorkspaceId;
  parent: ParentRef;
  type: T;
  data?: BlockDataByType[T];
  children?: BlockId[];
  lifecycle?: 'active' | 'archived' | 'trashed' | 'deleted';
  version?: number;
  clock?: Clock;
  actorId?: UserId;
  idFactory?: IdFactory;
}

export interface CreatePageOptions {
  id?: PageId;
  workspaceId: WorkspaceId;
  parent: ParentRef;
  title?: string | RichText;
  children?: BlockId[];
  clock?: Clock;
  actorId?: UserId;
  idFactory?: IdFactory;
}

export function createEmptyDocument(options: CreateDocumentOptions = {}): DocumentState {
  const idFactory = options.idFactory ?? createIdFactory();
  const clock = options.clock ?? systemClock;
  const now = clock.now();
  const workspaceId = options.workspaceId ?? createWorkspaceId(idFactory);
  const pageId = options.pageId ?? createPageId(idFactory);
  const title = typeof options.title === 'string' || options.title === undefined
    ? richTextFromPlainText(options.title ?? 'Untitled')
    : options.title;
  const { block, page } = createPage({
    id: pageId,
    workspaceId,
    parent: { kind: 'workspace', workspaceId },
    title,
    clock,
    idFactory,
    ...(options.actorId ? { actorId: options.actorId } : {})
  });

  return {
    schema: {
      format: MODEL_FORMAT,
      version: MODEL_VERSION,
      createdAt: now,
      updatedAt: now,
      ...(options.appVersion ? { appVersion: options.appVersion } : {})
    },
    workspace: {
      id: workspaceId,
      name: options.workspaceName ?? 'Workspace',
      rootPageIds: [pageId],
      rootDatabaseIds: [],
      settings: { defaultPageId: pageId },
      version: 1
    },
    users: {},
    blocks: { [pageId]: block } as Record<BlockId, BlockRecord>,
    pages: { [pageId]: page } as Record<PageId, PageRecord>,
    databases: {},
    dataSources: {},
    views: {},
    discussions: {},
    comments: {},
    files: {}
  };
}

export function createPage(options: CreatePageOptions): { block: BlockRecord<'page'>; page: PageRecord } {
  const clock = options.clock ?? systemClock;
  const idFactory = options.idFactory ?? createIdFactory();
  const id = options.id ?? createPageId(idFactory);
  const title = typeof options.title === 'string' || options.title === undefined
    ? richTextFromPlainText(options.title ?? 'Untitled')
    : options.title;
  const metadata = createAuditMetadata(clock, options.actorId);
  const block: BlockRecord<'page'> = {
    ...metadata,
    id,
    workspaceId: options.workspaceId,
    type: 'page',
    parent: options.parent,
    children: options.children ? [...options.children] : [],
    lifecycle: 'active',
    version: 1,
    data: { title }
  };
  const page: PageRecord = {
    ...metadata,
    id,
    workspaceId: options.workspaceId,
    parent: options.parent,
    titlePlain: plainTextFromRichText(title),
    properties: {
      [TITLE_PROPERTY_ID]: { id: TITLE_PROPERTY_ID, type: 'title', title }
    } as Record<PropertyId, PageRecord['properties'][PropertyId]>,
    lifecycle: 'active',
    version: 1
  };
  return { block, page };
}

export function createBlock<T extends BlockType>(options: CreateBlockOptions<T>): BlockRecord<T> {
  const clock = options.clock ?? systemClock;
  const idFactory = options.idFactory ?? createIdFactory();
  return {
    ...createAuditMetadata(clock, options.actorId),
    id: options.id ?? createBlockId(idFactory),
    workspaceId: options.workspaceId,
    type: options.type,
    parent: options.parent,
    children: options.children ? [...options.children] : [],
    lifecycle: options.lifecycle ?? 'active',
    version: options.version ?? 1,
    data: options.data ?? defaultBlockData(options.type)
  };
}

export function createParagraphBlock(options: Omit<CreateBlockOptions<'paragraph'>, 'type' | 'data'> & { richText?: RichText; text?: string }): BlockRecord<'paragraph'> {
  return createBlock({
    ...options,
    type: 'paragraph',
    data: { richText: options.richText ?? richTextFromPlainText(options.text ?? '') }
  });
}

export function createAuditMetadata(clock: Clock = systemClock, actorId?: UserId): AuditMetadata {
  const now = clock.now();
  return {
    createdAt: now,
    lastEditedAt: now,
    ...(actorId ? { createdBy: actorId, lastEditedBy: actorId } : {})
  };
}

export function defaultBlockData<T extends BlockType>(type: T): BlockDataByType[T] {
  const emptyRichText = (): RichText => [];
  const placeholderViewId: ViewId = asViewId('');
  const placeholderDataSourceId: DataSourceId = asDataSourceId('');
  const placeholderDatabaseId: DatabaseId = asDatabaseId('');
  const emptyBlockData = () => ({});
  const richTextBlockData = () => ({ richText: emptyRichText() });
  const fileBlockData = () => ({ file: { type: 'external' as const, url: 'https://example.invalid/plim-file-placeholder' }, caption: emptyRichText() });
  const urlBlockData = () => ({ url: 'https://example.invalid/' });
  const defaults: { [K in BlockType]: () => BlockDataByType[K] } = {
    paragraph: richTextBlockData,
    heading_1: richTextBlockData,
    heading_2: richTextBlockData,
    heading_3: richTextBlockData,
    bulleted_list_item: richTextBlockData,
    numbered_list_item: () => ({ richText: emptyRichText(), numbering: 'decimal' }),
    to_do: () => ({ richText: emptyRichText(), checked: false }),
    toggle: () => ({ richText: emptyRichText(), collapsed: false }),
    toggle_heading_1: () => ({ richText: emptyRichText(), collapsed: false }),
    toggle_heading_2: () => ({ richText: emptyRichText(), collapsed: false }),
    toggle_heading_3: () => ({ richText: emptyRichText(), collapsed: false }),
    quote: richTextBlockData,
    callout: richTextBlockData,
    code: () => ({ richText: emptyRichText(), language: 'plain text' }),
    equation: () => ({ expression: '' }),
    divider: emptyBlockData,
    table_of_contents: () => ({ color: 'default' }),
    breadcrumb: emptyBlockData,
    page: () => ({ title: richTextFromPlainText('Untitled') }),
    child_page: () => ({ pageId: asPageId('') }),
    child_database: () => ({ databaseId: placeholderDatabaseId }),
    database_view: () => ({ viewId: placeholderViewId, dataSourceId: placeholderDataSourceId, databaseId: placeholderDatabaseId }),
    column_list: emptyBlockData,
    column: emptyBlockData,
    table: () => ({ hasColumnHeader: false, hasRowHeader: false, columnCount: 1 }),
    table_row: () => ({ cells: [] }),
    template: () => ({ richText: emptyRichText(), templateChildren: [] }),
    synced_block: () => ({ syncedFrom: null }),
    image: fileBlockData,
    video: fileBlockData,
    audio: fileBlockData,
    file: fileBlockData,
    pdf: fileBlockData,
    bookmark: urlBlockData,
    embed: urlBlockData,
    link_preview: urlBlockData,
    unsupported: () => ({ raw: {} })
  };

  return defaults[type]();
}
