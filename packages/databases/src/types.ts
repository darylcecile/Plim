import type {
  BlockId,
  BlockRecord,
  ComputedValue,
  DataSourceId,
  DataSourceProperty,
  DataSourceRecord,
  DatabaseId,
  DatabaseRecord,
  DateMention,
  DocumentState,
  FileRef,
  ISODateTime,
  JsonObject,
  JsonValue,
  PageId,
  PagePropertyValue,
  PageRecord,
  PropertyConfig,
  PropertyId,
  PropertyType,
  RichText,
  RollupFunction,
  SelectOption,
  UserId,
  ViewId,
  ViewRecord
} from '@plim/model';

export type Revision = number;
export type QueryCursor = string;
export type SortKey = string | number | boolean | ISODateTime | null;
export type TemplateId = string;
export type DatabaseButtonId = string;
export type OpaqueId = string;

export type FooterAggregation =
  | 'count'
  | 'count_values'
  | 'percent_empty'
  | 'percent_not_empty'
  | 'sum'
  | 'average'
  | 'median'
  | 'min'
  | 'max'
  | 'range';

export type ClientDatabaseState = DocumentState & {
  revision?: Revision;
  relationGraph?: RelationGraph;
  databaseTemplates?: Record<TemplateId, DataSourceTemplate>;
  databaseButtons?: Record<DatabaseButtonId, DatabaseButtonDefinition>;
};

export type PropertySchema = DataSourceProperty;
export type DataSource = DataSourceRecord;
export type DatabaseContainer = DatabaseRecord;
export type PropertyValue = PagePropertyValue;
export type RowPage = PageRecord;

type ConfigFor<T extends PropertyType> = Extract<PropertyConfig, { type: T }>;
export type PropertySchemaFor<T extends PropertyType> = DataSourceProperty & { type: T; config: ConfigFor<T> };
export type ClientPropertySchema =
  | PropertySchemaFor<'title'>
  | PropertySchemaFor<'rich_text'>
  | PropertySchemaFor<'number'>
  | PropertySchemaFor<'select'>
  | PropertySchemaFor<'multi_select'>
  | PropertySchemaFor<'status'>
  | PropertySchemaFor<'date'>
  | PropertySchemaFor<'formula'>
  | PropertySchemaFor<'relation'>
  | PropertySchemaFor<'rollup'>
  | PropertySchemaFor<'people'>
  | PropertySchemaFor<'files'>
  | PropertySchemaFor<'checkbox'>
  | PropertySchemaFor<'url'>
  | PropertySchemaFor<'email'>
  | PropertySchemaFor<'phone_number'>
  | PropertySchemaFor<'created_time'>
  | PropertySchemaFor<'created_by'>
  | PropertySchemaFor<'last_edited_time'>
  | PropertySchemaFor<'last_edited_by'>
  | PropertySchemaFor<'unique_id'>
  | PropertySchemaFor<'unsupported'>;

export type EditablePropertyValue = Exclude<
  PagePropertyValue,
  | { type: 'formula' }
  | { type: 'rollup' }
  | { type: 'created_time' }
  | { type: 'created_by' }
  | { type: 'last_edited_time' }
  | { type: 'last_edited_by' }
  | { type: 'unique_id' }
>;

export type ViewType = ViewRecord['type'];
export type PageOpenMode = 'center_peek' | 'side_peek' | 'full_page' | 'modal';
export type CardSize = 'small' | 'medium' | 'large';

export interface PropertyVisibility {
  visible: boolean;
  widthPx?: number;
  wrap?: boolean;
  pinned?: 'left' | 'right';
  aggregation?: FooterAggregation;
}

export type CardPreviewConfig =
  | { type: 'none' }
  | { type: 'page_cover' }
  | { type: 'page_content' }
  | { type: 'files'; propertyId: PropertyId };

export interface ChartMeasure {
  propertyId?: PropertyId;
  aggregation: FooterAggregation;
}

export interface DashboardWidgetConfig {
  id: OpaqueId;
  viewId?: ViewId;
  title?: string;
  layout: { x: number; y: number; w: number; h: number };
}

export type ViewLayoutConfig =
  | { type: 'table'; frozenColumnCount?: number; rowHeight?: 'compact' | 'medium' | 'large'; showVerticalLines?: boolean }
  | { type: 'board'; groupBy: GroupSpec; subgroupBy?: GroupSpec; cardSize: CardSize; cardPreview?: CardPreviewConfig; hideEmptyGroups?: boolean }
  | { type: 'calendar'; datePropertyId: PropertyId; showWeekends?: boolean; cardProperties: PropertyId[] }
  | { type: 'list'; showIcon?: boolean; showPropertyIds: PropertyId[] }
  | { type: 'gallery'; cardSize: CardSize; cardPreview: CardPreviewConfig; fitImage?: boolean; showPropertyIds: PropertyId[] }
  | { type: 'timeline'; startDatePropertyId: PropertyId; endDatePropertyId?: PropertyId; groupBy?: GroupSpec; showTable?: boolean; cardProperties: PropertyId[] }
  | { type: 'form'; shownPropertyIds: PropertyId[]; requiredPropertyIds?: PropertyId[]; submitLabel?: string }
  | { type: 'chart'; chartType: 'bar' | 'line' | 'donut' | 'number'; groupBy?: GroupSpec; measure?: ChartMeasure }
  | { type: 'map'; placePropertyId?: PropertyId; titlePropertyId?: PropertyId; cardProperties: PropertyId[] }
  | { type: 'dashboard'; widgets: DashboardWidgetConfig[] };

export interface DataSourceView {
  id: ViewId;
  databaseId: DatabaseId;
  dataSourceId: DataSourceId;
  name: string;
  type: ViewType;
  query: ViewQuery;
  layout: ViewLayoutConfig;
  propertyVisibility: Record<PropertyId, PropertyVisibility>;
  propertyOrder: PropertyId[];
  openPagesIn: PageOpenMode;
  isDefault?: boolean;
  isPersonal?: boolean;
  createdTime: ISODateTime;
  lastEditedTime: ISODateTime;
}

export interface ViewQuery {
  filter?: FilterNode;
  sorts: SortSpec[];
  search?: string;
  groupBy?: GroupSpec;
  subgroupBy?: GroupSpec;
}

export type FilterNode =
  | { type: 'and'; filters: FilterNode[] }
  | { type: 'or'; filters: FilterNode[] }
  | { type: 'not'; filter: FilterNode }
  | PropertyFilter;

export interface PropertyFilter {
  type: 'property';
  propertyId: PropertyId;
  operator: FilterOperator;
  value?: JsonValue;
}

export type FilterOperator =
  | 'is_empty'
  | 'is_not_empty'
  | 'equals'
  | 'does_not_equal'
  | 'contains'
  | 'does_not_contain'
  | 'starts_with'
  | 'ends_with'
  | 'greater_than'
  | 'greater_than_or_equal_to'
  | 'less_than'
  | 'less_than_or_equal_to'
  | 'before'
  | 'after'
  | 'on_or_before'
  | 'on_or_after'
  | 'within'
  | 'past_week'
  | 'past_month'
  | 'past_year'
  | 'next_week'
  | 'next_month'
  | 'next_year'
  | 'this_week';

export interface SortSpec {
  kind?: 'property' | 'timestamp' | 'manual';
  propertyId?: PropertyId;
  timestamp?: 'created_time' | 'last_edited_time';
  direction: 'ascending' | 'descending';
  emptyPlacement?: 'first' | 'last' | 'auto';
}

export interface GroupSpec {
  propertyId: PropertyId;
  direction?: 'ascending' | 'descending';
  hideEmptyGroups?: boolean;
  showCounts?: boolean;
  dateGranularity?: 'day' | 'week' | 'month' | 'quarter' | 'year';
}

export interface ProjectionSpec {
  propertyIds?: PropertyId[];
  includeTitle?: boolean;
  includeHidden?: boolean;
}

export interface QueryWindow {
  offset?: number;
  limit: number;
  cursor?: QueryCursor;
  overscan?: number;
}

export interface DataSourceQueryInput {
  dataSourceId: DataSourceId;
  viewId?: ViewId;
  filter?: FilterNode;
  sorts?: SortSpec[];
  search?: string;
  projection?: ProjectionSpec;
  window?: QueryWindow;
  includeTrashed?: boolean;
  includeComputed?: boolean;
  includeIncomplete?: boolean;
  revision?: Revision;
  groupBy?: GroupSpec;
  formulaContext?: Partial<FormulaEvaluationContext>;
}

export interface DataSourceQueryResult {
  dataSourceId: DataSourceId;
  revision: Revision;
  rows: QueryRow[];
  groups?: QueryGroup[];
  totalKnown: number | null;
  hasMore: boolean;
  nextCursor?: QueryCursor;
  completeness: 'complete' | 'partial_snapshot' | 'computed_pending';
  dependencies: QueryDependencySet;
}

export interface QueryRow {
  pageId: PageId;
  dataSourceId: DataSourceId;
  orderKey: string;
  title: RichText;
  properties: Partial<Record<PropertyId, PagePropertyValue>>;
  sortKeys: SortKey[];
  groupKeys: GroupKey[];
}

export type GroupKey =
  | { type: 'option'; optionId: string | null }
  | { type: 'checkbox'; checked: boolean | null }
  | { type: 'date_bucket'; start: ISODateTime; end: ISODateTime; granularity: string }
  | { type: 'person'; userId: UserId | null }
  | { type: 'relation'; pageId: PageId | null }
  | { type: 'value'; value: string | number | boolean | null };

export interface QueryGroup {
  key: GroupKey;
  label: string;
  rowPageIds: PageId[];
  totalKnown: number | null;
  subgroupKeys?: GroupKey[];
}

export interface QueryDependencySet {
  dataSourceId: DataSourceId;
  schemaVersion: number;
  propertyIds: PropertyId[];
  relationPropertyIds: PropertyId[];
  formulaPropertyIds: PropertyId[];
  rollupPropertyIds: PropertyId[];
  pageIds?: PageId[];
  viewIds?: ViewId[];
}

export interface RelationEdge {
  id: OpaqueId;
  fromPageId: PageId;
  fromDataSourceId: DataSourceId;
  fromPropertyId: PropertyId;
  toPageId: PageId;
  toDataSourceId: DataSourceId;
  orderKey: string;
}

export interface RelationGraph {
  edgesById: Record<OpaqueId, RelationEdge>;
  outgoing: Record<PageId, Record<PropertyId, OpaqueId[]>>;
  incoming: Record<PageId, OpaqueId[]>;
}

export type ClientRollupFunction =
  | RollupFunction
  | 'show_original'
  | 'show_unique'
  | 'count_all'
  | 'count_unique_values'
  | 'count_empty'
  | 'count_not_empty'
  | 'range';

export interface RollupEvaluationResult {
  value: ComputedValue;
  dependencies: QueryDependencySet;
}

export interface FormulaDiagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  range?: { start: number; end: number };
}

export interface FormulaPropertyConfig {
  expression: string;
  compiled?: CompiledFormula;
}

export interface CompiledFormula {
  astVersion: 1;
  ast: FormulaAstNode;
  dependencies: FormulaDependency[];
  returnType: FormulaValueType | 'unknown';
  volatile: boolean;
  diagnostics: FormulaDiagnostic[];
}

export type FormulaAstNode =
  | { kind: 'literal'; value: FormulaValue }
  | { kind: 'prop'; propertyId?: PropertyId; nameSnapshot: string }
  | { kind: 'constant'; name: 'true' | 'false' | 'null' }
  | { kind: 'unary'; op: 'not' | 'negate'; argument: FormulaAstNode }
  | { kind: 'binary'; op: FormulaBinaryOperator; left: FormulaAstNode; right: FormulaAstNode }
  | { kind: 'call'; name: string; args: FormulaAstNode[] }
  | { kind: 'member'; object: FormulaAstNode; property: string }
  | { kind: 'list'; items: FormulaAstNode[] }
  | { kind: 'lambda'; param: string; body: FormulaAstNode }
  | { kind: 'variable'; name: string };

export type FormulaBinaryOperator =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'and'
  | 'or';

export type FormulaValueType =
  | 'null'
  | 'boolean'
  | 'number'
  | 'string'
  | 'date'
  | 'person'
  | 'page'
  | 'file'
  | 'list'
  | 'error';

export type FormulaValue =
  | { type: 'null' }
  | { type: 'boolean'; value: boolean }
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'date'; value: DateMention }
  | { type: 'person'; userId: UserId }
  | { type: 'page'; pageId: PageId; dataSourceId?: DataSourceId }
  | { type: 'file'; file: FileRef }
  | { type: 'list'; items: FormulaValue[] }
  | { type: 'error'; error: FormulaError };

export interface FormulaError {
  code:
    | 'parse_error'
    | 'unknown_property'
    | 'unknown_function'
    | 'type_error'
    | 'division_by_zero'
    | 'cycle'
    | 'depth_limit'
    | 'unsupported'
    | 'evaluation_error';
  message: string;
  range?: { start: number; end: number };
}

export interface FormulaEvaluationContext {
  now: ISODateTime;
  timeZone: string;
  locale: string;
  maxDepth: number;
  currentUserId?: UserId;
}

export interface FormulaEvaluationInput {
  dataSourceId: DataSourceId;
  pageId: PageId;
  propertyId: PropertyId;
  state: ClientDatabaseState;
  context: FormulaEvaluationContext;
}

export interface FormulaEvaluationResult {
  value: FormulaValue;
  dependencies: FormulaDependency[];
  volatile: boolean;
  diagnostics: FormulaDiagnostic[];
}

export interface FormulaDependency {
  dataSourceId: DataSourceId;
  pageId?: PageId;
  propertyId: PropertyId;
  relationTraversal?: PropertyId[];
}

export interface FormulaCompileOptions {
  dataSource: DataSourceRecord;
}

export interface DataSourceTemplate {
  id: TemplateId;
  dataSourceId: DataSourceId;
  name: string;
  isDefault: boolean;
  propertyDefaults: Partial<Record<PropertyId, PropertyTemplateValue>>;
  bodyBlocks: BlockRecord[];
  icon?: JsonValue;
  cover?: JsonValue;
  createdTime: ISODateTime;
  lastEditedTime: ISODateTime;
}

export type PropertyTemplateValue =
  | { kind: 'literal'; value: EditablePropertyValue }
  | { kind: 'template_mention'; value: 'now' | 'today' | 'current_user' }
  | { kind: 'formula'; expression: string };

export interface ButtonExecutionContext {
  dataSourceId?: DataSourceId;
  pageId?: PageId;
  selectedPageIds?: PageId[];
  now: ISODateTime;
  currentUserId?: UserId;
}

export interface DatabaseButtonDefinition {
  id: DatabaseButtonId;
  dataSourceId: DataSourceId;
  name: string;
  icon?: JsonValue;
  confirmation?: string;
  actions: DatabaseButtonAction[];
}

export type DatabaseButtonAction =
  | { type: 'create_page'; dataSourceId: DataSourceId; templateId?: TemplateId; propertyValues?: Partial<Record<PropertyId, EditablePropertyValue>> }
  | { type: 'edit_current_page'; propertyValues: Partial<Record<PropertyId, EditablePropertyValue>> }
  | { type: 'edit_selected_pages'; propertyValues: Partial<Record<PropertyId, EditablePropertyValue>> }
  | { type: 'insert_blocks'; target: 'current_page' | { pageId: PageId }; blocks: BlockRecord[] }
  | { type: 'open_page'; pageId: PageId }
  | { type: 'open_view'; viewId: ViewId };

export type DatabaseOperation =
  | { type: 'create_database'; block: BlockRecord<'database_view' | 'child_database'>; database: DatabaseRecord; dataSources: DataSourceRecord[]; views: ViewRecord[] }
  | { type: 'update_database'; databaseId: DatabaseId; patch: Partial<Pick<DatabaseRecord, 'title' | 'description' | 'icon' | 'cover' | 'isInline' | 'lifecycle'>> }
  | { type: 'create_data_source'; databaseId: DatabaseId; dataSource: DataSourceRecord; defaultView?: ViewRecord }
  | { type: 'update_data_source'; dataSourceId: DataSourceId; patch: Partial<Pick<DataSourceRecord, 'title' | 'description' | 'lifecycle'>> }
  | { type: 'create_property'; dataSourceId: DataSourceId; property: DataSourceProperty; afterPropertyId?: PropertyId }
  | { type: 'update_property'; dataSourceId: DataSourceId; propertyId: PropertyId; patch: Partial<DataSourceProperty> }
  | { type: 'delete_property'; dataSourceId: DataSourceId; propertyId: PropertyId; mode: 'trash' | 'remove' }
  | { type: 'reorder_property'; dataSourceId: DataSourceId; propertyId: PropertyId; afterPropertyId?: PropertyId }
  | { type: 'create_page_row'; dataSourceId: DataSourceId; pageId: PageId; values?: Partial<Record<PropertyId, EditablePropertyValue>>; templateId?: TemplateId; afterPageId?: PageId }
  | { type: 'update_page_properties'; dataSourceId: DataSourceId; pageId: PageId; values: Partial<Record<PropertyId, EditablePropertyValue>> }
  | { type: 'move_page_row'; dataSourceId: DataSourceId; pageId: PageId; afterPageId?: PageId }
  | { type: 'trash_page_row'; dataSourceId: DataSourceId; pageId: PageId; inTrash: boolean }
  | { type: 'create_view'; view: ViewRecord }
  | { type: 'update_view'; viewId: ViewId; patch: Partial<ViewRecord> }
  | { type: 'delete_view'; viewId: ViewId }
  | { type: 'set_relation'; dataSourceId: DataSourceId; pageId: PageId; propertyId: PropertyId; targetPageIds: PageId[] }
  | { type: 'create_template'; template: DataSourceTemplate }
  | { type: 'update_template'; templateId: TemplateId; patch: Partial<DataSourceTemplate> }
  | { type: 'delete_template'; templateId: TemplateId };

export interface DatabaseTransactionOptions {
  now: ISODateTime;
  actorId?: UserId;
  timeZone?: string;
  locale?: string;
}

export interface DatabaseTransactionResult {
  state: ClientDatabaseState;
  revision: Revision;
  applied: DatabaseOperation[];
  invalidated: QueryDependencySet[];
  diagnostics: FormulaDiagnostic[];
}

export interface DatabaseViewBlockQueryOverrides {
  filter?: FilterNode;
  sorts?: SortSpec[];
  search?: string;
  projection?: ProjectionSpec;
  window?: QueryWindow;
  includeTrashed?: boolean;
  includeComputed?: boolean;
  formulaContext?: Partial<FormulaEvaluationContext>;
}

export interface DatabaseViewBlockQueryInput {
  blockId: BlockId;
  databaseId: DatabaseId;
  dataSourceId: DataSourceId;
  viewId?: ViewId;
  linked: boolean;
  query: DataSourceQueryInput;
}
