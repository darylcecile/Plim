declare const plimBrand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [plimBrand]: B };

export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type BlockId = Brand<string, 'BlockId' | 'PageId'>;
export type PageId = Brand<string, 'PageId'>;
export type DatabaseId = Brand<string, 'DatabaseId'>;
export type DataSourceId = Brand<string, 'DataSourceId'>;
export type ViewId = Brand<string, 'ViewId'>;
export type UserId = Brand<string, 'UserId'>;
export type CommentId = Brand<string, 'CommentId'>;
export type DiscussionId = Brand<string, 'DiscussionId'>;
export type FileId = Brand<string, 'FileId'>;
export type TransactionId = Brand<string, 'TransactionId'>;
export type PropertyId = Brand<string, 'PropertyId'>;

export type IdKind =
  | 'workspace'
  | 'block'
  | 'page'
  | 'database'
  | 'data_source'
  | 'view'
  | 'user'
  | 'comment'
  | 'discussion'
  | 'file'
  | 'transaction'
  | 'property';

export type ISODateTime = string;
export type URLString = string;
export type Version = number;

export interface DocumentState {
  schema: SchemaMetadata;
  workspace: WorkspaceRecord;
  users: Record<UserId, UserRecord>;
  blocks: Record<BlockId, BlockRecord>;
  pages: Record<PageId, PageRecord>;
  databases: Record<DatabaseId, DatabaseRecord>;
  dataSources: Record<DataSourceId, DataSourceRecord>;
  views: Record<ViewId, ViewRecord>;
  discussions: Record<DiscussionId, DiscussionRecord>;
  comments: Record<CommentId, CommentRecord>;
  files: Record<FileId, FileRecord>;
  transactions?: TransactionRecord[];
  extensions?: JsonObject;
}

export interface SchemaMetadata {
  format: 'notion-next-document';
  version: 1;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  appVersion?: string;
  minReaderVersion?: 1;
  migrations?: MigrationStamp[];
}

export interface MigrationStamp {
  from: number;
  to: number;
  migratedAt: ISODateTime;
  tool?: string;
}

export interface WorkspaceRecord {
  id: WorkspaceId;
  name: string;
  rootPageIds: PageId[];
  rootDatabaseIds: DatabaseId[];
  settings?: WorkspaceSettings;
  version: Version;
}

export interface WorkspaceSettings {
  locale?: string;
  timezone?: string;
  defaultPageId?: PageId;
}

export interface UserRecord {
  id: UserId;
  type: 'person' | 'bot' | 'guest' | 'unknown';
  name?: string;
  avatarUrl?: URLString;
  email?: string;
  unresolved?: boolean;
}

export type ParentRef =
  | { kind: 'workspace'; workspaceId: WorkspaceId }
  | { kind: 'block'; blockId: BlockId }
  | { kind: 'page'; pageId: PageId }
  | { kind: 'database'; databaseId: DatabaseId }
  | { kind: 'data_source'; dataSourceId: DataSourceId }
  | { kind: 'synced_instance'; blockId: BlockId; instanceId: BlockId };

export type LifecycleState = 'active' | 'archived' | 'trashed' | 'deleted';

export interface AuditMetadata {
  createdAt: ISODateTime;
  createdBy?: UserId;
  lastEditedAt: ISODateTime;
  lastEditedBy?: UserId;
}

export type BlockType =
  | 'paragraph'
  | 'heading_1'
  | 'heading_2'
  | 'heading_3'
  | 'bulleted_list_item'
  | 'numbered_list_item'
  | 'to_do'
  | 'toggle'
  | 'toggle_heading_1'
  | 'toggle_heading_2'
  | 'toggle_heading_3'
  | 'quote'
  | 'callout'
  | 'code'
  | 'equation'
  | 'divider'
  | 'table_of_contents'
  | 'breadcrumb'
  | 'page'
  | 'child_page'
  | 'child_database'
  | 'database_view'
  | 'column_list'
  | 'column'
  | 'table'
  | 'table_row'
  | 'template'
  | 'synced_block'
  | 'image'
  | 'video'
  | 'audio'
  | 'file'
  | 'pdf'
  | 'bookmark'
  | 'embed'
  | 'link_preview'
  | 'unsupported';

export interface BlockRecord<T extends BlockType = BlockType> extends AuditMetadata {
  id: BlockId;
  workspaceId: WorkspaceId;
  type: T;
  parent: ParentRef;
  children: BlockId[];
  lifecycle: LifecycleState;
  version: Version;
  data: BlockDataByType[T];
  preservedData?: JsonObject;
  extensions?: JsonObject;
}

export interface BlockDataByType {
  paragraph: RichTextBlockData;
  heading_1: HeadingBlockData;
  heading_2: HeadingBlockData;
  heading_3: HeadingBlockData;
  bulleted_list_item: RichTextBlockData;
  numbered_list_item: NumberedListItemData;
  to_do: TodoBlockData;
  toggle: ToggleBlockData;
  toggle_heading_1: ToggleBlockData;
  toggle_heading_2: ToggleBlockData;
  toggle_heading_3: ToggleBlockData;
  quote: RichTextBlockData;
  callout: CalloutBlockData;
  code: CodeBlockData;
  equation: EquationBlockData;
  divider: EmptyBlockData;
  table_of_contents: TableOfContentsBlockData;
  breadcrumb: EmptyBlockData;
  page: PageBlockData;
  child_page: ChildPageBlockData;
  child_database: ChildDatabaseBlockData;
  database_view: DatabaseViewBlockData;
  column_list: EmptyBlockData;
  column: ColumnBlockData;
  table: TableBlockData;
  table_row: TableRowBlockData;
  template: TemplateBlockData;
  synced_block: SyncedBlockData;
  image: FileBlockData;
  video: FileBlockData;
  audio: FileBlockData;
  file: FileBlockData;
  pdf: FileBlockData;
  bookmark: BookmarkBlockData;
  embed: EmbedBlockData;
  link_preview: LinkPreviewBlockData;
  unsupported: UnsupportedBlockData;
}

export interface EmptyBlockData { color?: NotionColor; }
export interface RichTextBlockData { richText: RichText; color?: NotionColor; }
export interface HeadingBlockData extends RichTextBlockData { isToggleable?: boolean; }
export interface NumberedListItemData extends RichTextBlockData { numbering?: 'decimal' | 'lower_alpha' | 'lower_roman'; }
export interface TodoBlockData extends RichTextBlockData { checked: boolean; }
export interface ToggleBlockData extends RichTextBlockData { collapsed?: boolean; }
export interface CalloutBlockData extends RichTextBlockData { icon?: IconRef; }
export interface CodeBlockData { richText: RichText; language?: string; caption?: RichText; }
export interface EquationBlockData { expression: string; caption?: RichText; }
export interface TableOfContentsBlockData { color?: NotionColor; }
export interface PageBlockData { title: RichText; icon?: IconRef; cover?: FileRef; }
export interface ChildPageBlockData { pageId: PageId; titleSnapshot?: string; }
export interface ChildDatabaseBlockData { databaseId: DatabaseId; titleSnapshot?: string; }
export interface DatabaseViewBlockData { viewId: ViewId; dataSourceId: DataSourceId; databaseId: DatabaseId; }
export interface ColumnBlockData { widthRatio?: number; }
export interface TableBlockData { hasColumnHeader: boolean; hasRowHeader: boolean; columnCount: number; }
export interface TableRowBlockData { cells: RichText[]; }
export interface TemplateBlockData { richText: RichText; templateChildren: BlockId[]; }
export interface SyncedBlockData { syncedFrom: null | { blockId: BlockId }; }
export interface FileBlockData { file: FileRef; caption?: RichText; }
export interface BookmarkBlockData { url: URLString; caption?: RichText; metadata?: EmbedMetadata; }
export interface EmbedBlockData { url: URLString; caption?: RichText; metadata?: EmbedMetadata; }
export interface LinkPreviewBlockData { url: URLString; metadata?: EmbedMetadata; }
export interface UnsupportedBlockData { originalType?: string; raw: JsonObject; }

export type NotionColor =
  | 'default'
  | 'gray'
  | 'brown'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'red'
  | 'gray_background'
  | 'brown_background'
  | 'orange_background'
  | 'yellow_background'
  | 'green_background'
  | 'blue_background'
  | 'purple_background'
  | 'pink_background'
  | 'red_background';

export type IconRef =
  | { type: 'emoji'; emoji: string }
  | { type: 'file'; file: FileRef }
  | { type: 'external'; url: URLString };

export type RichText = RichTextSpan[];
export type RichTextSpan = TextSpan | MentionSpan | EquationSpan;

export interface RichTextBase {
  annotations?: TextAnnotations;
  plainText?: string;
  href?: URLString | null;
  direction?: 'auto' | 'ltr' | 'rtl';
  commentIds?: DiscussionId[];
  extensions?: JsonObject;
}

export interface TextSpan extends RichTextBase {
  type: 'text';
  text: { content: string; link?: LinkRef | null };
}

export interface MentionSpan extends RichTextBase {
  type: 'mention';
  mention: MentionRef;
}

export interface EquationSpan extends RichTextBase {
  type: 'equation';
  equation: { expression: string };
}

export interface TextAnnotations {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  code?: boolean;
  color?: NotionColor;
}

export type LinkRef = { url: URLString };

export type MentionRef =
  | { kind: 'user'; userId: UserId; unresolved?: boolean }
  | { kind: 'page'; pageId: PageId; unresolved?: boolean }
  | { kind: 'database'; databaseId: DatabaseId; unresolved?: boolean }
  | { kind: 'data_source'; dataSourceId: DataSourceId; unresolved?: boolean }
  | { kind: 'view'; viewId: ViewId; unresolved?: boolean }
  | { kind: 'file'; fileId: FileId; unresolved?: boolean }
  | { kind: 'date'; date: DateMention }
  | { kind: 'template'; template: TemplateMention }
  | { kind: 'link_preview'; url: URLString }
  | { kind: 'external'; url: URLString; label?: string };

export interface DateMention {
  start: ISODateTime | string;
  end?: ISODateTime | string;
  timeZone?: string;
  includeTime?: boolean;
  reminder?: ReminderSpec | null;
}

export interface ReminderSpec {
  at: ISODateTime;
  offset?: 'at_time' | '5m' | '10m' | '15m' | '30m' | '1h' | '2h' | '1d' | '2d' | '1w';
}

export type TemplateMention =
  | { kind: 'today'; timeZone?: string }
  | { kind: 'now'; timeZone?: string }
  | { kind: 'me' };

export interface PageRecord extends AuditMetadata {
  id: PageId;
  workspaceId: WorkspaceId;
  parent: ParentRef;
  titlePlain: string;
  icon?: IconRef;
  cover?: FileRef;
  properties: Record<PropertyId, PagePropertyValue>;
  dataSourceId?: DataSourceId;
  lifecycle: LifecycleState;
  isLocked?: boolean;
  url?: URLString;
  publicUrl?: URLString | null;
  version: Version;
}

export interface DatabaseRecord extends AuditMetadata {
  id: DatabaseId;
  workspaceId: WorkspaceId;
  parent: ParentRef;
  title: RichText;
  description?: RichText;
  icon?: IconRef;
  cover?: FileRef;
  dataSourceIds: DataSourceId[];
  viewIds: ViewId[];
  isInline: boolean;
  lifecycle: LifecycleState;
  version: Version;
}

export interface DataSourceRecord extends AuditMetadata {
  id: DataSourceId;
  workspaceId: WorkspaceId;
  databaseId: DatabaseId;
  title: RichText;
  description?: RichText;
  properties: Record<PropertyId, DataSourceProperty>;
  propertyOrder: PropertyId[];
  entries: Record<PageId, DataSourceEntry>;
  lifecycle: LifecycleState;
  version: Version;
}

export interface DataSourceEntry {
  pageId: PageId;
  order?: string;
  lifecycle?: LifecycleState;
}

export type PropertyType =
  | 'title'
  | 'rich_text'
  | 'number'
  | 'select'
  | 'multi_select'
  | 'status'
  | 'date'
  | 'formula'
  | 'relation'
  | 'rollup'
  | 'people'
  | 'files'
  | 'checkbox'
  | 'url'
  | 'email'
  | 'phone_number'
  | 'created_time'
  | 'created_by'
  | 'last_edited_time'
  | 'last_edited_by'
  | 'unique_id'
  | 'unsupported';

export interface DataSourceProperty {
  id: PropertyId;
  name: string;
  description?: string;
  type: PropertyType;
  config: PropertyConfig;
  lifecycle: LifecycleState;
}

export type PropertyConfig =
  | { type: 'title' | 'rich_text' | 'checkbox' | 'url' | 'email' | 'phone_number' | 'created_time' | 'created_by' | 'last_edited_time' | 'last_edited_by' | 'files' | 'people' }
  | { type: 'number'; format?: 'number' | 'number_with_commas' | 'percent' | 'dollar' | 'euro' | 'pound' | 'yen' | string }
  | { type: 'select' | 'multi_select' | 'status'; options: SelectOption[]; groups?: SelectGroup[] }
  | { type: 'date' }
  | { type: 'relation'; targetDataSourceId: DataSourceId; dualProperty?: { dataSourceId: DataSourceId; propertyId: PropertyId }; maxItems?: number }
  | { type: 'rollup'; relationPropertyId: PropertyId; rollupPropertyId: PropertyId; function: RollupFunction }
  | { type: 'formula'; expression: string; compiled?: JsonObject }
  | { type: 'unique_id'; prefix?: string; nextNumber?: number }
  | { type: 'unsupported'; raw: JsonObject };

export interface SelectOption { id: string; name: string; color?: NotionColor; }
export interface SelectGroup { id: string; name: string; optionIds: string[]; color?: NotionColor; }

export type RollupFunction =
  | 'show_original' | 'show_unique' | 'count' | 'count_values' | 'sum' | 'average'
  | 'median' | 'min' | 'max' | 'range' | 'earliest_date' | 'latest_date'
  | 'date_range' | 'checked' | 'unchecked' | 'percent_checked' | 'percent_unchecked'
  | 'percent_empty' | 'percent_not_empty';

export type PagePropertyValue =
  | { id: PropertyId; type: 'title'; title: RichText }
  | { id: PropertyId; type: 'rich_text'; richText: RichText }
  | { id: PropertyId; type: 'number'; number: number | null }
  | { id: PropertyId; type: 'select'; select: SelectOption | null }
  | { id: PropertyId; type: 'multi_select'; multiSelect: SelectOption[] }
  | { id: PropertyId; type: 'status'; status: SelectOption | null }
  | { id: PropertyId; type: 'date'; date: DateMention | null }
  | { id: PropertyId; type: 'formula'; formula: ComputedValue }
  | { id: PropertyId; type: 'relation'; relation: PageReference[]; hasMore?: boolean }
  | { id: PropertyId; type: 'rollup'; rollup: ComputedValue }
  | { id: PropertyId; type: 'people'; people: UserId[] }
  | { id: PropertyId; type: 'files'; files: FileRef[] }
  | { id: PropertyId; type: 'checkbox'; checkbox: boolean }
  | { id: PropertyId; type: 'url'; url: URLString | null }
  | { id: PropertyId; type: 'email'; email: string | null }
  | { id: PropertyId; type: 'phone_number'; phoneNumber: string | null }
  | { id: PropertyId; type: 'created_time'; createdTime: ISODateTime }
  | { id: PropertyId; type: 'created_by'; createdBy: UserId }
  | { id: PropertyId; type: 'last_edited_time'; lastEditedTime: ISODateTime }
  | { id: PropertyId; type: 'last_edited_by'; lastEditedBy: UserId }
  | { id: PropertyId; type: 'unique_id'; uniqueId: { prefix?: string; number: number } }
  | { id: PropertyId; type: 'unsupported'; raw: JsonObject };

export interface PageReference { pageId: PageId; dataSourceId?: DataSourceId; }
export type ComputedValue =
  | { type: 'number'; number: number | null }
  | { type: 'string'; string: string | null }
  | { type: 'boolean'; boolean: boolean | null }
  | { type: 'date'; date: DateMention | null }
  | { type: 'array'; array: ComputedValue[] }
  | { type: 'unsupported'; raw: JsonObject };

export interface ViewRecord extends AuditMetadata {
  id: ViewId;
  workspaceId: WorkspaceId;
  databaseId: DatabaseId;
  dataSourceId?: DataSourceId;
  name: string;
  type: 'table' | 'board' | 'calendar' | 'timeline' | 'gallery' | 'list' | 'form' | 'chart' | 'map' | 'dashboard';
  filter?: FilterNode;
  sorts: SortSpec[];
  groups?: GroupSpec[];
  visiblePropertyIds?: PropertyId[];
  configuration: JsonObject;
  version: Version;
}

export type FilterNode =
  | { op: 'and' | 'or'; filters: FilterNode[] }
  | { propertyId: PropertyId; condition: string; value?: JsonValue };
export interface SortSpec { propertyId?: PropertyId; timestamp?: 'created_time' | 'last_edited_time'; direction: 'ascending' | 'descending'; }
export interface GroupSpec { propertyId: PropertyId; direction?: 'ascending' | 'descending'; }

export interface FileRecord extends AuditMetadata {
  id: FileId;
  workspaceId: WorkspaceId;
  kind: 'external' | 'uploaded' | 'local' | 'data_url';
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  externalUrl?: URLString;
  dataUrl?: string;
  localHandleId?: string;
  accessUrl?: URLString;
  accessUrlExpiresAt?: ISODateTime;
  version: Version;
}

export type FileRef =
  | { type: 'file'; fileId: FileId }
  | { type: 'external'; url: URLString; name?: string }
  | { type: 'data_url'; dataUrl: string; name?: string; mimeType?: string };

export interface EmbedMetadata {
  title?: string;
  description?: string;
  provider?: string;
  iconUrl?: URLString;
  thumbnail?: FileRef;
  width?: number;
  height?: number;
  fetchedAt?: ISODateTime;
}

export interface DiscussionRecord extends AuditMetadata {
  id: DiscussionId;
  workspaceId: WorkspaceId;
  anchor: CommentAnchor;
  status: 'open' | 'resolved';
  commentIds: CommentId[];
  version: Version;
}

export interface CommentRecord extends AuditMetadata {
  id: CommentId;
  workspaceId: WorkspaceId;
  discussionId: DiscussionId;
  authorId?: UserId;
  richText: RichText;
  attachments?: FileRef[];
  lifecycle: LifecycleState;
  version: Version;
}

export type CommentAnchor =
  | { kind: 'page'; pageId: PageId }
  | { kind: 'block'; blockId: BlockId; scope?: 'source' | 'instance' }
  | { kind: 'property'; pageId: PageId; propertyId: PropertyId }
  | { kind: 'rich_text_range'; blockId: BlockId; field: RichTextFieldPath; range: TextRangeAnchor; scope?: 'source' | 'instance' };

export type RichTextFieldPath =
  | { kind: 'block_data'; key: string }
  | { kind: 'page_property'; pageId: PageId; propertyId: PropertyId }
  | { kind: 'comment'; commentId: CommentId };

export interface TextRangeAnchor {
  startUtf16: number;
  endUtf16: number;
  textQuote: { exact: string; prefix?: string; suffix?: string };
}

export interface TransactionRecord {
  id: TransactionId;
  workspaceId: WorkspaceId;
  actorId?: UserId;
  clientId: string;
  createdAt: ISODateTime;
  baseVersions: Record<string, Version>;
  operations: Operation[];
  status: 'pending' | 'applied' | 'reverted' | 'committed' | 'rejected';
  inverse?: Operation[];
  metadata?: TransactionMetadata;
}

export interface TransactionMetadata {
  source?: 'keyboard' | 'input' | 'paste' | 'drop' | 'command' | 'api' | 'import' | 'persistence' | 'history' | 'plugin';
  label?: string;
  undoable?: boolean;
  historyGroup?: string;
  tags?: string[];
  extensions?: JsonObject;
}

export type Operation =
  | CreateBlockOperation
  | UpdateBlockOperation
  | SetBlockTypeOperation
  | InsertChildOperation
  | MoveBlockOperation
  | RemoveChildOperation
  | SetLifecycleOperation
  | ReplaceRichTextOperation
  | UpdatePageOperation
  | UpsertDataSourceOperation
  | UpdatePropertySchemaOperation
  | SetPagePropertyOperation
  | UpsertViewOperation
  | AddRelationOperation
  | RemoveRelationOperation
  | CreateDiscussionOperation
  | AddCommentOperation
  | UpsertFileOperation;

export interface CreateBlockOperation { op: 'create_block'; block: BlockRecord; }
export interface UpdateBlockOperation { op: 'update_block'; blockId: BlockId; patch: DeepPartial<BlockRecord>; }
export interface SetBlockTypeOperation { op: 'set_block_type'; blockId: BlockId; type: BlockType; dataPatch?: JsonObject; preservePreviousData?: boolean; }
export interface InsertChildOperation { op: 'insert_child'; parentId: BlockId | PageId; childId: BlockId; at: InsertPosition; }
export interface MoveBlockOperation { op: 'move_block'; blockId: BlockId; newParentId: BlockId | PageId; at: InsertPosition; }
export interface RemoveChildOperation { op: 'remove_child'; parentId: BlockId | PageId; childId: BlockId; mode: 'detach' | 'trash' | 'delete'; }
export interface SetLifecycleOperation { op: 'set_lifecycle'; record: RecordRef; lifecycle: LifecycleState; cascade?: boolean; }
export interface ReplaceRichTextOperation { op: 'replace_rich_text'; target: RichTextTarget; range: TextRangeAnchor; replacement: RichText; }
export interface UpdatePageOperation { op: 'update_page'; pageId: PageId; patch: DeepPartial<PageRecord>; }
export interface UpsertDataSourceOperation { op: 'upsert_data_source'; dataSource: DataSourceRecord; }
export interface UpdatePropertySchemaOperation { op: 'update_property_schema'; dataSourceId: DataSourceId; propertyId: PropertyId; patch: DeepPartial<DataSourceProperty>; }
export interface SetPagePropertyOperation { op: 'set_page_property'; pageId: PageId; propertyId: PropertyId; value: PagePropertyValue; }
export interface UpsertViewOperation { op: 'upsert_view'; view: ViewRecord; }
export interface AddRelationOperation { op: 'add_relation'; pageId: PageId; propertyId: PropertyId; targetPageId: PageId; updateDual?: boolean; }
export interface RemoveRelationOperation { op: 'remove_relation'; pageId: PageId; propertyId: PropertyId; targetPageId: PageId; updateDual?: boolean; }
export interface CreateDiscussionOperation { op: 'create_discussion'; discussion: DiscussionRecord; }
export interface AddCommentOperation { op: 'add_comment'; comment: CommentRecord; }
export interface UpsertFileOperation { op: 'upsert_file'; file: FileRecord; }

export type InsertPosition =
  | { kind: 'index'; index: number }
  | { kind: 'before'; siblingId: BlockId }
  | { kind: 'after'; siblingId: BlockId }
  | { kind: 'append' };

export type RecordRef =
  | { kind: 'block'; id: BlockId }
  | { kind: 'page'; id: PageId }
  | { kind: 'database'; id: DatabaseId }
  | { kind: 'data_source'; id: DataSourceId }
  | { kind: 'view'; id: ViewId }
  | { kind: 'discussion'; id: DiscussionId }
  | { kind: 'comment'; id: CommentId }
  | { kind: 'file'; id: FileId };

export interface RichTextTarget {
  blockId?: BlockId;
  pageId?: PageId;
  propertyId?: PropertyId;
  commentId?: CommentId;
  field: RichTextFieldPath;
}

export interface SerializedDocumentV1 {
  object: 'notion_next_document';
  schema: SchemaMetadata;
  state: DocumentState;
}

export interface ClipboardFragmentV1 {
  object: 'notion_next_clipboard_fragment';
  schema: SchemaMetadata;
  rootBlockIds: BlockId[];
  state: Pick<DocumentState, 'blocks' | 'pages' | 'databases' | 'dataSources' | 'views' | 'files' | 'discussions' | 'comments' | 'users'>;
  plainText: string;
  html?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  normalized?: DocumentState;
}

export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info';
  code: ValidationCode;
  message: string;
  path: string;
  record?: RecordRef;
  fix?: 'auto' | 'manual' | 'none';
}

export type ValidationCode =
  | 'missing_record'
  | 'duplicate_child'
  | 'parent_child_mismatch'
  | 'cycle'
  | 'invalid_parent'
  | 'invalid_block_data'
  | 'invalid_rich_text'
  | 'invalid_url'
  | 'schema_mismatch'
  | 'property_type_mismatch'
  | 'relation_target_invalid'
  | 'view_reference_invalid'
  | 'comment_anchor_invalid'
  | 'file_reference_invalid'
  | 'version_unsupported'
  | 'unknown_type_preserved';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue; }
export type DeepPartial<T> = T extends JsonPrimitive
  ? T
  : T extends readonly (infer U)[]
    ? DeepPartial<U>[]
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;
