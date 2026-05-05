# Notion-compatible client databases specification

## 1. Scope, terminology, and conformance

This document specifies browser-only, TypeScript-first behavior for implementing Notion-compatible databases in a web editor. It defines client-side data structures, editor integration points, in-memory query semantics, formula/rollup behavior, and update operations. It does **not** define a server database, SQL schema, synchronization protocol, authorization system, or network API.

Implementations that claim conformance to this specification:

- MUST model a **database block/container** separately from one or more **data sources**.
- MUST model **database rows/items as pages** that have both page body blocks and page property values.
- MUST treat property IDs, option IDs, view IDs, page IDs, data source IDs, and relation edge IDs as stable opaque identifiers.
- MUST provide deterministic client-side query, formula, rollup, relation, template, and view behavior over the currently loaded client snapshot.
- SHOULD expose optional persistence/sync adapters only as integration points around the browser store; those adapters MUST NOT change the normative in-memory semantics described here.
- MAY support additional Notion product features not described here, provided they preserve the invariants in this document.

Normative keywords such as MUST, SHOULD, and MAY are used intentionally.

### 1.1 Terms

| Term | Meaning |
| --- | --- |
| Database block | A block in the document tree that renders a database surface, either inline or as a full-page database. |
| Database container | The logical object owned by the database block. It holds title/description/icon/cover and references one or more data sources and saved views. |
| Data source | A table-like collection under a database. It owns property schema and page rows/items. |
| Row/item | A page whose parent is a data source. It has page body content plus property values conforming to the data source schema. |
| View | A persisted query and presentation preset for one data source, a database context, or a linked database block. |
| Linked database view | A block/view surface that references an existing data source without copying its schema or rows. Local view settings do not mutate the source database's own views unless explicitly saved to the source view. |
| Property schema | A data-source-level column definition: ID, name, type, ordering, visibility defaults, and type-specific config. |
| Property value | A row/page-level typed value for a property ID. Formula, rollup, created, and edited values are computed/read-only. |
| Client snapshot | The complete set of loaded blocks, pages, databases, data sources, schemas, values, relations, views, and indexes available to the query engine at one logical revision. |

## 2. Browser-only architecture

A conforming implementation MUST use a client store as the source of truth for currently visible database behavior. The store MAY be backed by IndexedDB, OPFS, localStorage, memory only, or a custom adapter, but the database module MUST be able to operate purely in memory.

```ts
type UUID = string;
type OpaqueId = string;
type Revision = number;
type ISODateTime = string;

type DatabaseId = OpaqueId;
type DataSourceId = OpaqueId;
type ViewId = OpaqueId;
type PageId = OpaqueId;
type BlockId = OpaqueId;
type PropertyId = OpaqueId;
type OptionId = OpaqueId;
type UserId = OpaqueId;

interface ClientDatabaseState {
  revision: Revision;
  blocks: Map<BlockId, BlockRecord>;
  pages: Map<PageId, PageRecord>;
  databases: Map<DatabaseId, DatabaseContainer>;
  dataSources: Map<DataSourceId, DataSource>;
  views: Map<ViewId, DataSourceView>;
  relationGraph: RelationGraph;
  computed: ComputedPropertyCache;
  indexes: QueryIndexSet;
}

interface DatabaseEngine {
  readState(): ClientDatabaseState;
  transact(ops: DatabaseOperation[], options?: TransactionOptions): DatabaseTransactionResult;
  query(input: DataSourceQueryInput): DataSourceQueryResult;
  evaluateFormula(input: FormulaEvaluationInput): FormulaEvaluationResult;
  evaluateRollup(input: RollupEvaluationInput): RollupEvaluationResult;
  subscribe(listener: (event: DatabaseStateChanged) => void): () => void;
}
```

The database module MUST be independent of server-specific concepts such as SQL tables, HTTP pagination, rate limits, or ACL checks. It MAY expose an adapter boundary:

```ts
interface ClientDatabaseAdapter {
  loadSnapshot(scope: ClientLoadScope): Promise<ClientDatabaseSnapshot>;
  persistTransaction?(tx: DatabaseTransactionResult): Promise<void>;
  resolveExternalFileUrl?(file: FileReference): Promise<string>;
  resolveUser?(id: UserId): Promise<ClientUser | undefined>;
}
```

The query engine MUST return results from the local snapshot. If the local snapshot is incomplete, query output MUST mark completeness explicitly rather than silently pretending to be exhaustive.


### 2.1 Shared support types

The following support types are intentionally small. Product implementations MAY enrich them, but MUST preserve the typed reference and value boundaries.

```ts
type ISODateOnly = string;
type NotionColor =
  | "default"
  | "gray"
  | "brown"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "pink"
  | "red";

interface RichText {
  type: "text" | "mention" | "equation";
  plainText: string;
  href?: string | null;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    code?: boolean;
    color?: NotionColor | `${NotionColor}_background`;
  };
  text?: { content: string; link?: { url: string } | null };
  mention?: { kind: "page" | "database" | "user" | "date" | "template"; id?: string; date?: DateRangeValue };
  equation?: { expression: string };
}

type IconValue = { type: "emoji"; emoji: string } | { type: "file"; file: FileReference } | { type: "external"; url: string };

type FileReference =
  | { type: "external"; url: string; name?: string }
  | { type: "browser_file"; fileId: OpaqueId; name: string; mimeType?: string; size?: number }
  | { type: "resolved"; url: string; expiresAt?: ISODateTime; name?: string };

type BlockParentRef = { type: "page"; pageId: PageId } | { type: "block"; blockId: BlockId } | { type: "database"; databaseId: DatabaseId };
interface PageBlock { id: BlockId; type: "page"; pageId: PageId; parent: BlockParentRef; orderKey: string }
interface TextBlock { id: BlockId; type: "paragraph" | "heading" | "bulleted_list_item" | "numbered_list_item"; parent: BlockParentRef; orderKey: string; richText: RichText[] }
interface OtherBlock { id: BlockId; type: string; parent: BlockParentRef; orderKey: string; payload: unknown }

interface ClientLoadScope { databaseIds?: DatabaseId[]; dataSourceIds?: DataSourceId[]; pageIds?: PageId[] }
interface ClientDatabaseSnapshot extends ClientDatabaseState { loadedAt: ISODateTime; completeness: "complete" | "partial" }
interface ClientUser { id: UserId; name: string; avatarUrl?: string; email?: string }
interface TransactionOptions { actorId?: UserId; now: ISODateTime; timeZone?: string; source?: "user" | "undo" | "redo" | "adapter" }
interface DatabaseTransactionResult { revision: Revision; applied: DatabaseOperation[]; invalidated: QueryDependencySet[]; diagnostics: FormulaDiagnostic[] }
interface DatabaseStateChanged { revision: Revision; operations: DatabaseOperation[]; changedPageIds: PageId[]; changedPropertyIds: PropertyId[] }

type QueryCursor = string;
type SortKey = string | number | boolean | ISODateTime | null;
type FooterAggregation = "count" | "count_values" | "percent_empty" | "percent_not_empty" | "sum" | "average" | "median" | "min" | "max" | "range";

interface FormulaDiagnostic { severity: "info" | "warning" | "error"; code: string; message: string; range?: { start: number; end: number } }
type PropertySchemaPatch = Partial<Omit<PropertySchema, "id" | "type">> & { config?: unknown };
type DataSourceViewPatch = Partial<Omit<DataSourceView, "id" | "databaseId" | "dataSourceId">>;
interface ButtonExecutionContext { pageId?: PageId; selectedPageIds?: PageId[]; actorId?: UserId; now: ISODateTime; timeZone?: string }
interface BlockTemplateNode { type: string; richText?: RichText[]; children?: BlockTemplateNode[]; payload?: unknown }

interface TextIndex { query(text: string): Set<PageId>; update(pageId: PageId, text: string): void }
interface NumberIndex { range(min?: number, max?: number): Set<PageId>; update(pageId: PageId, value: number | null): void }
interface DateIndex { intersect(start: ISODateTime, end: ISODateTime): Set<PageId>; update(pageId: PageId, value: DateRangeValue | null): void }
interface OptionIndex { byOption(optionId: OptionId | null): Set<PageId>; update(pageId: PageId, optionIds: OptionId[]): void }
interface CheckboxIndex { byValue(value: boolean): Set<PageId>; update(pageId: PageId, value: boolean): void }
```

## 3. Document-model integration

### 3.1 Database block vs data source

A database block MUST be a normal block in the editor's render tree. It MUST NOT store row data directly. It MUST reference a database container, a default data source, and an active view.

```ts
type BlockRecord = DatabaseBlock | LinkedDatabaseBlock | PageBlock | TextBlock | OtherBlock;

interface DatabaseBlock {
  id: BlockId;
  type: "database";
  parent: BlockParentRef;
  orderKey: string;
  databaseId: DatabaseId;
  isInline: boolean;
  defaultViewId?: ViewId;
}

interface LinkedDatabaseBlock {
  id: BlockId;
  type: "linked_database";
  parent: BlockParentRef;
  orderKey: string;
  sourceDataSourceId: DataSourceId;
  localViewId: ViewId;
  titleOverride?: RichText[];
}
```

The editor MUST render a full-page database as a page-like surface backed by a database block/container. It MUST render an inline database inside a parent page's block list. A linked database block MUST render rows from its referenced data source and MUST store local view settings separately from the source database's saved views.

### 3.2 Page rows/items

A row/item MUST be a page. It MUST support the same body-content operations as any other page and MUST also carry property values for its parent data source.

```ts
interface PageRecord {
  id: PageId;
  parent: PageParentRef;
  titlePropertyId?: PropertyId;
  childBlockIds: BlockId[];
  createdTime: ISODateTime;
  createdBy: UserId | null;
  lastEditedTime: ISODateTime;
  lastEditedBy: UserId | null;
  inTrash: boolean;
}

type PageParentRef =
  | { type: "workspace" }
  | { type: "page"; pageId: PageId }
  | { type: "data_source"; dataSourceId: DataSourceId; databaseId: DatabaseId };

interface DataSourceEntry {
  pageId: PageId;
  dataSourceId: DataSourceId;
  orderKey: string;
  createdTime: ISODateTime;
  lastEditedTime: ISODateTime;
  inTrash: boolean;
}
```

Creating a database row MUST create a page with parent `{ type: "data_source" }`, add a data source entry, initialize editable property values, compute metadata values, and optionally apply a template in one transaction.

## 4. Data source and property schema model

### 4.1 Data sources

```ts
interface DatabaseContainer {
  id: DatabaseId;
  blockId: BlockId;
  title: RichText[];
  description: RichText[];
  icon?: IconValue;
  cover?: FileReference;
  isInline: boolean;
  dataSourceIds: DataSourceId[];
  defaultDataSourceId: DataSourceId;
  viewIds: ViewId[];
  inTrash: boolean;
  createdTime: ISODateTime;
  lastEditedTime: ISODateTime;
}

interface DataSource {
  id: DataSourceId;
  databaseId: DatabaseId;
  title: RichText[];
  description: RichText[];
  icon?: IconValue;
  schemaVersion: number;
  properties: Record<PropertyId, PropertySchema>;
  propertyOrder: PropertyId[];
  entries: Record<PageId, DataSourceEntry>;
  templateIds: TemplateId[];
  defaultTemplateId?: TemplateId;
  buttonIds: DatabaseButtonId[];
  inTrash: boolean;
}
```

A database container MUST be able to contain multiple data sources. A data source MUST own exactly one property schema map and a collection of page entries. Moving a page between data sources MUST validate and transform property values according to the target schema.

### 4.2 Property schema union

Every property schema MUST include `id`, `name`, `type`, `description`, `positionKey`, and a type-specific config field. Names are mutable labels; IDs are the canonical reference target for views, filters, formulas, rollups, imports, exports, and update operations.

```ts
type PropertyType =
  | "title"
  | "rich_text"
  | "number"
  | "select"
  | "multi_select"
  | "status"
  | "date"
  | "people"
  | "files"
  | "checkbox"
  | "url"
  | "email"
  | "phone_number"
  | "relation"
  | "rollup"
  | "formula"
  | "created_time"
  | "created_by"
  | "last_edited_time"
  | "last_edited_by"
  | "unique_id"
  | "button";

interface BasePropertySchema<T extends PropertyType, C> {
  id: PropertyId;
  name: string;
  description?: string;
  type: T;
  config: C;
  positionKey: string;
  inTrash?: boolean;
}

type PropertySchema =
  | BasePropertySchema<"title", { required?: true }>
  | BasePropertySchema<"rich_text", {}>
  | BasePropertySchema<"number", { format: NumberFormat }>
  | BasePropertySchema<"select", { options: SelectOption[] }>
  | BasePropertySchema<"multi_select", { options: SelectOption[] }>
  | BasePropertySchema<"status", { options: StatusOption[]; groups: StatusGroup[] }>
  | BasePropertySchema<"date", { includeTimeDefault?: boolean }>
  | BasePropertySchema<"people", { allowGroups?: boolean }>
  | BasePropertySchema<"files", { maxFiles?: number }>
  | BasePropertySchema<"checkbox", {}>
  | BasePropertySchema<"url", {}>
  | BasePropertySchema<"email", {}>
  | BasePropertySchema<"phone_number", {}>
  | BasePropertySchema<"relation", RelationPropertyConfig>
  | BasePropertySchema<"rollup", RollupPropertyConfig>
  | BasePropertySchema<"formula", FormulaPropertyConfig>
  | BasePropertySchema<"created_time", {}>
  | BasePropertySchema<"created_by", {}>
  | BasePropertySchema<"last_edited_time", {}>
  | BasePropertySchema<"last_edited_by", {}>
  | BasePropertySchema<"unique_id", { prefix?: string; nextNumber: number }>
  | BasePropertySchema<"button", DatabaseButtonPropertyConfig>;

type NumberFormat =
  | "number"
  | "number_with_commas"
  | "percent"
  | "dollar"
  | "euro"
  | "pound"
  | "yen"
  | "ruble"
  | "rupee"
  | "won"
  | "yuan"
  | "real"
  | "lira"
  | "rupiah"
  | "franc"
  | "hong_kong_dollar"
  | "new_zealand_dollar"
  | "krona"
  | "norwegian_krone"
  | "mexican_peso"
  | "rand"
  | "new_taiwan_dollar"
  | "danish_krone"
  | "zloty"
  | "baht"
  | "forint"
  | "koruna"
  | "shekel"
  | "chilean_peso"
  | "philippine_peso"
  | "dirham"
  | "colombian_peso"
  | "riyal"
  | "ringgit"
  | "leu"
  | "argentine_peso"
  | "uruguayan_peso";

interface SelectOption {
  id: OptionId;
  name: string;
  color: NotionColor;
}

interface StatusOption extends SelectOption {
  groupId: OptionId;
}

interface StatusGroup {
  id: OptionId;
  name: string;
  color: NotionColor;
  optionIds: OptionId[];
}
```

Select, multi-select, and status option names MUST be unique case-insensitively within their property. Implementations SHOULD preserve option IDs across renames and recolors. Status options MUST belong to exactly one group.

A data source SHOULD contain exactly one title property. If legacy or imported content violates this, the renderer MUST choose the first title property in `propertyOrder` as the display title and SHOULD surface a schema error.

### 4.3 Property values

Editable property values MUST be stored by property ID. Computed values MUST be derived and cached separately or marked as computed in the value map. Missing editable values MUST be interpreted as the type's empty value.

```ts
type PropertyValue =
  | { type: "title"; title: RichText[] }
  | { type: "rich_text"; richText: RichText[] }
  | { type: "number"; number: number | null }
  | { type: "select"; optionId: OptionId | null }
  | { type: "multi_select"; optionIds: OptionId[] }
  | { type: "status"; optionId: OptionId | null }
  | { type: "date"; date: DateRangeValue | null }
  | { type: "people"; userIds: UserId[] }
  | { type: "files"; files: FileReference[] }
  | { type: "checkbox"; checked: boolean }
  | { type: "url"; url: string | null }
  | { type: "email"; email: string | null }
  | { type: "phone_number"; phoneNumber: string | null }
  | { type: "relation"; pageIds: PageId[]; hasMore?: boolean }
  | { type: "rollup"; value: RollupValue; computed: true }
  | { type: "formula"; value: FormulaValue; computed: true }
  | { type: "created_time"; createdTime: ISODateTime; computed: true }
  | { type: "created_by"; createdBy: UserId | null; computed: true }
  | { type: "last_edited_time"; lastEditedTime: ISODateTime; computed: true }
  | { type: "last_edited_by"; lastEditedBy: UserId | null; computed: true }
  | { type: "unique_id"; prefix?: string; number: number; computed: true }
  | { type: "button"; buttonId: DatabaseButtonId; computed: true };

interface PagePropertyMap {
  pageId: PageId;
  dataSourceId: DataSourceId;
  values: Partial<Record<PropertyId, PropertyValue>>;
  version: number;
}

interface DateRangeValue {
  start: ISODateTime | ISODateOnly;
  end?: ISODateTime | ISODateOnly;
  timeZone?: string;
}
```

Metadata properties (`created_time`, `created_by`, `last_edited_time`, `last_edited_by`, and `unique_id`) MUST NOT be directly editable through normal property update operations. Formula and rollup values MUST NOT be directly editable. Button values are executable UI affordances and MUST NOT store user-entered row data.

The renderer MUST be able to display hidden properties in page detail panels, relation pickers, templates, formulas, and rollups when referenced; hidden property configuration only affects view presentation.


### 4.4 Large property values and property-level pagination

The client MUST support property-level windowing for large title, rich text, people, files, and relation values. This mirrors Notion's property-item behavior without requiring HTTP endpoints.

```ts
interface PropertyValuePageInput {
  dataSourceId: DataSourceId;
  pageId: PageId;
  propertyId: PropertyId;
  cursor?: QueryCursor;
  pageSize: number;
}

interface PropertyValuePageResult {
  items: PropertyValue[];
  hasMore: boolean;
  nextCursor?: QueryCursor;
  totalKnown: number | null;
}
```

A normal row query MAY return truncated multi-value properties when the view does not need the complete value. If truncation occurs, the property value MUST carry `hasMore: true` or equivalent metadata, and the page-detail UI MUST retrieve the full property through property-level windowing before editing it.

## 5. Views and display behavior

### 5.1 View definition

Views MUST store query state separately from layout state. Saved view definitions MUST be persisted in the client state. Personal/ephemeral filters or sorts MAY be layered over a saved view without mutating it.

```ts
type ViewType = "table" | "board" | "calendar" | "list" | "gallery" | "timeline" | "form" | "chart" | "map" | "dashboard";

type PageOpenMode = "center_peek" | "side_peek" | "full_page" | "modal";

interface DataSourceView {
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

interface ViewQuery {
  filter?: FilterNode;
  sorts: SortSpec[];
  search?: string;
  groupBy?: GroupSpec;
  subgroupBy?: GroupSpec;
}

interface PropertyVisibility {
  visible: boolean;
  widthPx?: number;
  wrap?: boolean;
  pinned?: "left" | "right";
  aggregation?: FooterAggregation;
}
```

View references MUST use property IDs, not names. Importers MAY accept property names for compatibility but MUST resolve and store IDs.

### 5.2 Layout configurations

```ts
type ViewLayoutConfig =
  | { type: "table"; frozenColumnCount?: number; rowHeight?: "compact" | "medium" | "large"; showVerticalLines?: boolean }
  | { type: "board"; groupBy: GroupSpec; subgroupBy?: GroupSpec; cardSize: CardSize; cardPreview?: CardPreviewConfig; hideEmptyGroups?: boolean }
  | { type: "calendar"; datePropertyId: PropertyId; showWeekends?: boolean; cardProperties: PropertyId[] }
  | { type: "list"; showIcon?: boolean; showPropertyIds: PropertyId[] }
  | { type: "gallery"; cardSize: CardSize; cardPreview: CardPreviewConfig; fitImage?: boolean; showPropertyIds: PropertyId[] }
  | { type: "timeline"; startDatePropertyId: PropertyId; endDatePropertyId?: PropertyId; groupBy?: GroupSpec; showTable?: boolean; cardProperties: PropertyId[] }
  | { type: "form"; shownPropertyIds: PropertyId[]; requiredPropertyIds?: PropertyId[]; submitLabel?: string }
  | { type: "chart"; chartType: "bar" | "line" | "donut" | "number"; groupBy?: GroupSpec; measure?: ChartMeasure }
  | { type: "map"; placePropertyId?: PropertyId; titlePropertyId?: PropertyId; cardProperties: PropertyId[] }
  | { type: "dashboard"; widgets: DashboardWidgetConfig[] };

interface ChartMeasure { propertyId?: PropertyId; aggregation: FooterAggregation }
interface DashboardWidgetConfig { id: OpaqueId; viewId?: ViewId; title?: string; layout: { x: number; y: number; w: number; h: number } }

type CardSize = "small" | "medium" | "large";

type CardPreviewConfig =
  | { type: "none" }
  | { type: "page_cover" }
  | { type: "page_content" }
  | { type: "files"; propertyId: PropertyId };
```

Display behavior MUST follow these rules:

- Table views MUST render rows and visible properties as a grid and SHOULD virtualize rows and columns independently.
- Board views MUST group rows by a select, status, checkbox, person, relation, or formula-compatible property. They MUST include an empty/no-value group unless hidden by view config.
- Calendar views MUST use a date property and MUST include rows whose date range intersects the visible calendar range.
- List views MUST render rows primarily by title and configured secondary properties.
- Gallery views MUST render cards with cover/page-content/file preview selection and configured secondary properties.
- Timeline views MUST use a start date and optional end date. If no end date is present, a row MUST render as a point or one-day span according to layout settings.
- Form, chart, map, and dashboard views MAY be rendered by specialized clients. If unsupported, the editor MUST preserve their view definitions and SHOULD display a non-destructive fallback instead of deleting them.
- Hidden properties MUST remain available to filters, sorts, formulas, rollups, templates, buttons, and page detail editing.

### 5.3 Linked database views

A linked database view MUST reference an existing `DataSourceId`. It MAY store a local `DataSourceView` whose `databaseId` points to the embedding database block context. Editing row values or schema through a linked view MUST mutate the source data source. Editing filters, sorts, grouping, display properties, or layout in a linked view MUST mutate only the linked view unless the user explicitly updates a shared source view.

## 6. Client query engine

### 6.1 Query input and output

```ts
interface DataSourceQueryInput {
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
}

interface ProjectionSpec {
  propertyIds?: PropertyId[];
  includeTitle?: boolean;
  includeHidden?: boolean;
}

interface QueryWindow {
  offset?: number;
  limit: number;
  cursor?: QueryCursor;
  overscan?: number;
}

interface DataSourceQueryResult {
  dataSourceId: DataSourceId;
  revision: Revision;
  rows: QueryRow[];
  groups?: QueryGroup[];
  totalKnown: number | null;
  hasMore: boolean;
  nextCursor?: QueryCursor;
  completeness: "complete" | "partial_snapshot" | "computed_pending";
  dependencies: QueryDependencySet;
}

interface QueryRow {
  pageId: PageId;
  dataSourceId: DataSourceId;
  orderKey: string;
  title: RichText[];
  properties: Partial<Record<PropertyId, PropertyValue>>;
  sortKeys: SortKey[];
  groupKeys: GroupKey[];
}
```

The engine MUST merge the saved view query with per-call overrides in this order: saved view, personal view state, explicit `DataSourceQueryInput`. Explicit inputs MUST take precedence.

### 6.2 Filter model and operators

```ts
type FilterNode =
  | { type: "and"; filters: FilterNode[] }
  | { type: "or"; filters: FilterNode[] }
  | { type: "not"; filter: FilterNode }
  | PropertyFilter;

interface PropertyFilter {
  type: "property";
  propertyId: PropertyId;
  operator: FilterOperator;
  value?: unknown;
}

type FilterOperator =
  | "is_empty"
  | "is_not_empty"
  | "equals"
  | "does_not_equal"
  | "contains"
  | "does_not_contain"
  | "starts_with"
  | "ends_with"
  | "greater_than"
  | "greater_than_or_equal_to"
  | "less_than"
  | "less_than_or_equal_to"
  | "before"
  | "after"
  | "on_or_before"
  | "on_or_after"
  | "within"
  | "past_week"
  | "past_month"
  | "past_year"
  | "next_week"
  | "next_month"
  | "next_year"
  | "this_week";
```

The query engine MUST support compound `and`, `or`, and `not` filters. It SHOULD support at least three nested levels for Notion UI compatibility and MAY support deeper trees when evaluation cost limits are enforced.

Operator applicability:

| Property kind | Required operators |
| --- | --- |
| title, rich_text, url, email, phone_number, formula text | `equals`, `does_not_equal`, `contains`, `does_not_contain`, `starts_with`, `ends_with`, `is_empty`, `is_not_empty` |
| number, unique_id number, formula number, numeric rollup | `equals`, `does_not_equal`, `greater_than`, `greater_than_or_equal_to`, `less_than`, `less_than_or_equal_to`, `is_empty`, `is_not_empty` |
| checkbox, formula boolean | `equals`, `does_not_equal` |
| select, status | `equals`, `does_not_equal`, `is_empty`, `is_not_empty` by option ID; import/export MAY accept names. |
| multi_select | `contains`, `does_not_contain`, `is_empty`, `is_not_empty` by option ID. |
| date, created_time, last_edited_time, formula date, date rollup | `equals`, `before`, `after`, `on_or_before`, `on_or_after`, `within`, relative date operators, `is_empty`, `is_not_empty` |
| people, relation | `contains`, `does_not_contain`, `is_empty`, `is_not_empty` by user/page ID. |
| files | `is_empty`, `is_not_empty` and MAY support file-name `contains`. |
| rollup | MUST dispatch to the operator set of the rollup result type. |

Filters MUST use stable IDs internally. Text matching SHOULD be case-insensitive and accent-insensitive for user-facing search/filtering, while exact API-compatibility modes MAY be case-sensitive if explicitly configured.

### 6.3 Sorting

```ts
interface SortSpec {
  kind: "property" | "timestamp" | "manual";
  propertyId?: PropertyId;
  timestamp?: "created_time" | "last_edited_time";
  direction: "ascending" | "descending";
  emptyPlacement?: "first" | "last" | "auto";
}
```

Sorting MUST be stable. Earlier sort specs MUST take precedence over later specs. Rows equal under all explicit sort keys MUST retain the previous materialized order when available; otherwise they MUST use `orderKey`, then `createdTime`, then `pageId` as deterministic tie-breakers. Empty values SHOULD sort last in ascending order and first in descending order unless `emptyPlacement` overrides this. Error values from formulas or rollups MUST sort after non-error values by default.

Manual ordering MUST be represented by `DataSourceEntry.orderKey`. If a view has no explicit sort, the query engine MUST sort by `orderKey` and `pageId` deterministically.

### 6.4 Search

Database search MUST be separate from global workspace search. Data source search MUST evaluate over the local snapshot and MUST include page title. It SHOULD include visible string-like properties by default and MAY include hidden properties when `projection.includeHidden` or view settings request it. It MAY include page body blocks if the embedding editor has loaded/indexed them.

Search tokenization SHOULD normalize case, diacritics, punctuation boundaries, and Unicode whitespace. Search MUST be deterministic for a given snapshot and locale configuration.

### 6.5 Grouping

```ts
interface GroupSpec {
  propertyId: PropertyId;
  direction?: "ascending" | "descending";
  hideEmptyGroups?: boolean;
  showCounts?: boolean;
  dateGranularity?: "day" | "week" | "month" | "quarter" | "year";
}

interface QueryGroup {
  key: GroupKey;
  label: string;
  rowPageIds: PageId[];
  totalKnown: number | null;
  subgroupKeys?: GroupKey[];
}

type GroupKey =
  | { type: "option"; optionId: OptionId | null }
  | { type: "checkbox"; checked: boolean | null }
  | { type: "date_bucket"; start: ISODateTime; end: ISODateTime; granularity: string }
  | { type: "person"; userId: UserId | null }
  | { type: "relation"; pageId: PageId | null }
  | { type: "value"; value: string | number | boolean | null };
```

Rows with multi-valued group properties (multi-select, people, relation) MUST appear in each matching group unless the view explicitly requests single-group bucketing. Rows with no group value MUST appear in a no-value group unless hidden. Board views MUST require a group property; table, list, gallery, calendar, and timeline views MAY group when configured.

### 6.6 Pagination, windowing, and virtualization

Client queries MUST support UI windowing. `offset`/`limit` windows are acceptable for in-memory state. Cursor windows MAY be used to preserve stable continuation across incremental recomputes. Cursors MUST be opaque to callers.

The renderer SHOULD request an overscanned window around the visible range and MUST key rows by `pageId` rather than array index. Query results MUST include enough metadata to distinguish these cases:

- complete result set known;
- partial local snapshot loaded;
- computed formula/rollup values pending;
- rows filtered out because required properties are not loaded.

Virtualized table and timeline renderers SHOULD separately virtualize rows, columns, groups, and cards. They MUST NOT require loading every property value for every row if the view projection does not show or query that property.

### 6.7 Incremental recompute

The engine MUST track query dependencies at property/schema/view granularity.

```ts
interface QueryDependencySet {
  dataSourceId: DataSourceId;
  schemaVersion: number;
  propertyIds: PropertyId[];
  relationPropertyIds: PropertyId[];
  formulaPropertyIds: PropertyId[];
  rollupPropertyIds: PropertyId[];
  pageIds?: PageId[];
}
```

When property values, schema, relations, formulas, rollups, or view settings change, the engine SHOULD recompute only affected query rows/groups. A conforming implementation MAY fall back to full recompute, but it MUST preserve stable sorting and deterministic output.

## 7. Relations and rollups

### 7.1 Relation graph

Relations MUST be represented as page-to-page edges keyed by relation property ID. Relation values MAY also be stored in row property maps for fast rendering, but the graph is canonical for rollups, reverse lookups, and dual-relation maintenance.

```ts
interface RelationPropertyConfig {
  targetDataSourceId: DataSourceId;
  singlePage?: boolean;
  dualProperty?: {
    targetPropertyId: PropertyId;
    targetPropertyNameSnapshot?: string;
  };
}

interface RelationEdge {
  id: OpaqueId;
  fromPageId: PageId;
  fromDataSourceId: DataSourceId;
  fromPropertyId: PropertyId;
  toPageId: PageId;
  toDataSourceId: DataSourceId;
  orderKey: string;
}

interface RelationGraph {
  edgesById: Map<OpaqueId, RelationEdge>;
  outgoing: Map<PageId, Map<PropertyId, OpaqueId[]>>;
  incoming: Map<PageId, OpaqueId[]>;
}
```

When a relation property has `dualProperty`, adding, removing, or reordering an edge on one side MUST update the reciprocal edge in the same client transaction. Self-relations MUST be supported. Implementations SHOULD guard against duplicate reciprocal edges and SHOULD preserve order independently per side.

Relation picker search MUST query the target data source's title and configured searchable properties. It SHOULD use the same filter/search semantics as data source search and MUST return page references, not copied row data.

### 7.2 Rollup model

```ts
type RollupFunction =
  | "show_original"
  | "show_unique"
  | "count_all"
  | "count_values"
  | "count_unique_values"
  | "count_empty"
  | "count_not_empty"
  | "percent_empty"
  | "percent_not_empty"
  | "sum"
  | "average"
  | "median"
  | "min"
  | "max"
  | "range"
  | "earliest_date"
  | "latest_date"
  | "date_range"
  | "checked"
  | "unchecked"
  | "percent_checked"
  | "percent_unchecked";

interface RollupPropertyConfig {
  relationPropertyId: PropertyId;
  targetPropertyId: PropertyId;
  function: RollupFunction;
}

type RollupValue =
  | { type: "number"; number: number | null }
  | { type: "date"; date: DateRangeValue | null }
  | { type: "array"; values: FormulaValue[] }
  | { type: "unsupported"; reason: string }
  | { type: "error"; error: FormulaError };
```

Rollup evaluation MUST:

1. Resolve relation edges from the source row through `relationPropertyId`.
2. Read `targetPropertyId` values on related pages.
3. Normalize those values into formula-compatible values.
4. Apply the configured rollup function deterministically.
5. Return dependency metadata covering the relation property, related page IDs, and target property IDs.

Rollups MUST update when relation edges change or when target property values change. Rollups SHOULD NOT roll up another rollup unless the implementation can prove the dependency graph is acyclic and bounded; for Notion compatibility, the UI SHOULD reject rollup-of-rollup configurations by default.

Aggregation rules:

- `show_original` MUST return the ordered list of target values.
- `show_unique` MUST return target values deduplicated by normalized value identity while preserving first occurrence order.
- Count functions MUST count over the related page set after value normalization.
- Numeric functions MUST ignore empty values; if no numeric values remain, they MUST return `null` except count/percent functions.
- Date functions MUST ignore empty dates; `date_range` MUST return the earliest start and latest end/start.
- Checkbox functions MUST count checked/unchecked boolean values and ignore empty non-boolean values.
- Rollup errors MUST be value-level errors, not thrown JavaScript exceptions.

## 8. Formula engine

### 8.1 Formula property config and AST

Formula source text MUST be stored as the author-edited expression. Implementations MUST compile formulas to an AST for evaluation, dependency extraction, and validation. The AST shape MAY differ internally, but it MUST preserve these semantics.

```ts
interface FormulaPropertyConfig {
  expression: string;
  compiled?: CompiledFormula;
}

interface CompiledFormula {
  astVersion: number;
  ast: FormulaAstNode;
  dependencies: FormulaDependency[];
  returnType: FormulaValueType | "unknown";
  volatile: boolean;
  diagnostics: FormulaDiagnostic[];
}

type FormulaAstNode =
  | { kind: "literal"; value: FormulaValue }
  | { kind: "prop"; propertyId: PropertyId; nameSnapshot?: string }
  | { kind: "constant"; name: "true" | "false" | "null" }
  | { kind: "unary"; op: "not" | "negate"; argument: FormulaAstNode }
  | { kind: "binary"; op: FormulaBinaryOperator; left: FormulaAstNode; right: FormulaAstNode }
  | { kind: "call"; name: string; args: FormulaAstNode[] }
  | { kind: "member"; object: FormulaAstNode; property: string }
  | { kind: "list"; items: FormulaAstNode[] }
  | { kind: "lambda"; param: string; body: FormulaAstNode }
  | { kind: "variable"; name: string };

type FormulaBinaryOperator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "and"
  | "or";
```

`prop("Name")` references MUST compile to property IDs. The compiler MAY keep a name snapshot for readable diagnostics, but evaluation MUST not break when a property is renamed.

### 8.2 Formula value types

```ts
type FormulaValueType =
  | "null"
  | "boolean"
  | "number"
  | "string"
  | "date"
  | "person"
  | "page"
  | "file"
  | "list"
  | "error";

type FormulaValue =
  | { type: "null" }
  | { type: "boolean"; value: boolean }
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "date"; value: DateRangeValue }
  | { type: "person"; userId: UserId }
  | { type: "page"; pageId: PageId; dataSourceId?: DataSourceId }
  | { type: "file"; file: FileReference }
  | { type: "list"; items: FormulaValue[] }
  | { type: "error"; error: FormulaError };

interface FormulaError {
  code:
    | "parse_error"
    | "unknown_property"
    | "unknown_function"
    | "type_error"
    | "division_by_zero"
    | "cycle"
    | "depth_limit"
    | "unsupported"
    | "evaluation_error";
  message: string;
  range?: { start: number; end: number };
}
```

Notion API formula results are exposed as boolean, date, number, or string, but the client formula evaluator MUST support internal lists, pages, people, files, and null because Notion formulas operate over relation, people, and list-like values before producing final display values.

### 8.3 Null, empty, and error semantics

The engine MUST distinguish empty/null from error:

- Empty editable values MUST normalize to `{ type: "null" }` for formula input unless a function explicitly expects the original collection type.
- `empty(value)` MUST return true for null, empty string, empty list, empty relation, no select/status option, no date, and no files.
- Arithmetic with null SHOULD treat null as zero only for explicit numeric conversion functions. Direct arithmetic on null SHOULD return a type error unless a compatibility mode chooses Notion-like coercion.
- String concatenation MAY coerce numbers, booleans, dates, pages, and people using display formatting, but MUST be deterministic for a fixed locale/timezone context.
- Comparisons involving null MUST be deterministic: null equals null, null does not equal non-null, and ordering comparisons with null MUST return false except through explicit empty checks.
- Formula errors MUST propagate through dependent expressions unless handled by a supported error-handling function. They MUST render as formula errors and MUST not crash the editor.

### 8.4 Supported functions and operators

A conforming formula implementation MUST include these categories:

| Category | Required examples |
| --- | --- |
| Logic/control | `if`, `ifs`, `and`, `or`, `not`, `empty` |
| Type conversion | `format`, `toNumber`, `parseDate` |
| Text | `concat`, `length`, `substring`, `contains`, `startsWith`, `endsWith`, `lower`, `upper`, `replace`, `replaceAll`, `test` |
| Numeric | `abs`, `round`, `ceil`, `floor`, `sqrt`, `min`, `max`, `sum` |
| Date/time | `now`, `today`, `dateAdd`, `dateSubtract`, `dateBetween`, `formatDate`, `timestamp`, `fromTimestamp`, `start`, `end` |
| Lists | `map`, `filter`, `some`, `every`, `find`, `first`, `last`, `at`, `flat`, `unique`, `join`, `sort`, `reverse` |
| Relations/pages/users | property access for page/person display values, IDs, and relation-derived lists |
| Display/style | `style`, `unstyle`, link/display helpers MAY be implemented as rich display metadata while returning strings for API-compatible output. |

The implementation SHOULD mirror Notion Formula 2.0 syntax where feasible. Unsupported functions MUST produce `unknown_function` diagnostics at compile time or evaluation time.

### 8.5 Deterministic evaluation context

```ts
interface FormulaEvaluationInput {
  dataSourceId: DataSourceId;
  pageId: PageId;
  propertyId: PropertyId;
  state: ClientDatabaseState;
  context: FormulaEvaluationContext;
}

interface FormulaEvaluationContext {
  now: ISODateTime;
  timeZone: string;
  locale: string;
  maxDepth: number;
  currentUserId?: UserId;
}

interface FormulaEvaluationResult {
  value: FormulaValue;
  dependencies: FormulaDependency[];
  volatile: boolean;
  diagnostics: FormulaDiagnostic[];
}

interface FormulaDependency {
  dataSourceId: DataSourceId;
  pageId?: PageId;
  propertyId: PropertyId;
  relationTraversal?: PropertyId[];
}
```

Formula evaluation MUST be deterministic for a fixed state and context. `now()` and `today()` MUST read from `context.now`, not directly from `Date.now()`. Formula functions MUST NOT perform network access, random number generation, DOM reads, localStorage reads, or other side effects.

### 8.6 Dependency tracking, cycles, and recalculation

The compiler MUST extract static property dependencies where possible. The evaluator MUST record dynamic dependencies from relation traversal, rollups, list operations, and page/person access. Formula and rollup dependencies MUST form a directed graph. The engine MUST topologically recalculate dirty computed properties and MUST detect cycles.

If a cycle is detected, every property in the cycle MUST evaluate to `{ type: "error", code: "cycle" }`. If the dependency chain exceeds `maxDepth`, the result MUST be a `depth_limit` error. Implementations SHOULD default `maxDepth` to a Notion-compatible limit such as 15 formula/rollup layers.

Volatile formulas using `now()` or `today()` MUST be marked `volatile` and invalidated on a schedule appropriate to their precision: `now()` at least once per visible minute, `today()` at local day boundaries, and both when timezone changes.

### 8.7 Formula examples

Source:

```text
if(and(prop("Due") < today(), prop("Status") != "Done"), "Overdue", "OK")
```

Compiled shape:

```json
{
  "astVersion": 1,
  "dependencies": [
    { "propertyId": "due" },
    { "propertyId": "status" }
  ],
  "returnType": "string",
  "volatile": true
}
```

TypeScript evaluation:

```ts
const result = engine.evaluateFormula({
  dataSourceId: "ds-tasks",
  pageId: "page-task-1",
  propertyId: "formula-health",
  state: engine.readState(),
  context: {
    now: "2026-05-01T12:00:00.000Z",
    timeZone: "America/Los_Angeles",
    locale: "en-US",
    maxDepth: 15,
  },
});

if (result.value.type === "string") {
  console.log(result.value.value);
}
```

## 9. Templates and buttons

### 9.1 Database templates

Database templates MUST be modeled as page blueprints associated with a data source. A template MAY include property defaults, page body blocks, icon/cover defaults, and template variables.

```ts
type TemplateId = OpaqueId;

interface DataSourceTemplate {
  id: TemplateId;
  dataSourceId: DataSourceId;
  name: string;
  isDefault: boolean;
  propertyDefaults: Partial<Record<PropertyId, PropertyTemplateValue>>;
  bodyBlockTemplate: BlockTemplateNode[];
  icon?: IconValue;
  cover?: FileReference;
  createdTime: ISODateTime;
  lastEditedTime: ISODateTime;
}

type PropertyTemplateValue =
  | { kind: "literal"; value: EditablePropertyValue }
  | { kind: "template_mention"; value: "now" | "today" | "current_user" }
  | { kind: "formula"; expression: string };
```

Creating a row with a template MUST apply explicit user-provided property values after template defaults unless the command requests template override behavior. Template mentions such as `now`, `today`, and `current_user` MUST resolve through the transaction context's clock, timezone, and current user.

Template application MAY be asynchronous in a sync adapter, but the browser editor MUST represent it as a pending local operation with deterministic final content. If both explicit child blocks and a template are supplied, the operation MUST either reject or apply a documented deterministic merge policy; Notion-compatible mode SHOULD reject.

### 9.2 Buttons

Database buttons and button properties MUST be local editor actions, not server jobs. Button definitions MAY live at data-source level or property-schema level and MUST execute as client transactions.

```ts
type DatabaseButtonId = OpaqueId;

interface DatabaseButtonPropertyConfig {
  buttonId: DatabaseButtonId;
}

interface DatabaseButtonDefinition {
  id: DatabaseButtonId;
  dataSourceId: DataSourceId;
  name: string;
  icon?: IconValue;
  confirmation?: string;
  actions: DatabaseButtonAction[];
}

type DatabaseButtonAction =
  | { type: "create_page"; dataSourceId: DataSourceId; templateId?: TemplateId; propertyValues?: Partial<Record<PropertyId, EditablePropertyValue>> }
  | { type: "edit_current_page"; propertyValues: Partial<Record<PropertyId, EditablePropertyValue>> }
  | { type: "edit_selected_pages"; propertyValues: Partial<Record<PropertyId, EditablePropertyValue>> }
  | { type: "insert_blocks"; target: "current_page" | { pageId: PageId }; blocks: BlockTemplateNode[] }
  | { type: "open_page"; pageId: PageId }
  | { type: "open_view"; viewId: ViewId };
```

Button execution MUST validate that target schemas and properties exist. It MUST NOT mutate formula, rollup, metadata, or unique ID values directly. Multi-action buttons MUST execute atomically in one transaction or fail without partial state changes.

## 10. Update operations and transactions

### 10.1 Operation model

```ts
type DatabaseOperation =
  | { type: "create_database"; block: DatabaseBlock; database: DatabaseContainer; dataSources: DataSource[]; views: DataSourceView[] }
  | { type: "update_database"; databaseId: DatabaseId; patch: Partial<Pick<DatabaseContainer, "title" | "description" | "icon" | "cover" | "isInline" | "inTrash">> }
  | { type: "create_data_source"; databaseId: DatabaseId; dataSource: DataSource; defaultView?: DataSourceView }
  | { type: "update_data_source"; dataSourceId: DataSourceId; patch: Partial<Pick<DataSource, "title" | "description" | "icon" | "inTrash">> }
  | { type: "create_property"; dataSourceId: DataSourceId; property: PropertySchema; afterPropertyId?: PropertyId }
  | { type: "update_property"; dataSourceId: DataSourceId; propertyId: PropertyId; patch: PropertySchemaPatch }
  | { type: "delete_property"; dataSourceId: DataSourceId; propertyId: PropertyId; mode: "trash" | "remove" }
  | { type: "reorder_property"; dataSourceId: DataSourceId; propertyId: PropertyId; afterPropertyId?: PropertyId }
  | { type: "create_page_row"; dataSourceId: DataSourceId; pageId: PageId; values?: Partial<Record<PropertyId, EditablePropertyValue>>; templateId?: TemplateId; afterPageId?: PageId }
  | { type: "update_page_properties"; dataSourceId: DataSourceId; pageId: PageId; values: Partial<Record<PropertyId, EditablePropertyValue>> }
  | { type: "move_page_row"; dataSourceId: DataSourceId; pageId: PageId; afterPageId?: PageId }
  | { type: "trash_page_row"; dataSourceId: DataSourceId; pageId: PageId; inTrash: boolean }
  | { type: "create_view"; view: DataSourceView }
  | { type: "update_view"; viewId: ViewId; patch: DataSourceViewPatch }
  | { type: "delete_view"; viewId: ViewId }
  | { type: "set_relation"; dataSourceId: DataSourceId; pageId: PageId; propertyId: PropertyId; targetPageIds: PageId[] }
  | { type: "create_template"; template: DataSourceTemplate }
  | { type: "update_template"; templateId: TemplateId; patch: Partial<DataSourceTemplate> }
  | { type: "delete_template"; templateId: TemplateId }
  | { type: "execute_button"; buttonId: DatabaseButtonId; context: ButtonExecutionContext };

type EditablePropertyValue = Exclude<PropertyValue, { computed: true } | { type: "button" }>;
```

Operations MUST validate against the current client state before mutation. A transaction MUST either apply all operations or none. On success, the transaction MUST increment the state revision, update affected `lastEditedTime`/`lastEditedBy` metadata, invalidate affected computed values and query caches, and emit one state change event.

### 10.2 Schema updates

Schema updates MUST preserve property IDs. Renaming a property MUST not break filters, sorts, views, formulas, rollups, templates, or buttons. Changing a property type MUST run a deterministic migration:

- compatible conversions MAY preserve values (for example select to status by option mapping);
- incompatible conversions MUST either clear values with user confirmation or keep archived raw values for undo/import recovery;
- formula, rollup, metadata, unique ID, and button property values MUST be regenerated rather than migrated as editable data.

Deleting a property SHOULD trash it first so undo can restore schema and values. Permanent removal MUST remove view references or mark them invalid, remove formula dependencies or produce diagnostics, remove relation edges for relation properties, and invalidate rollups.

### 10.3 Relation updates

Updating a relation property MUST update both the property value map and `RelationGraph`. For single-page relations, setting more than one target MUST reject. For dual relations, reciprocal updates MUST occur in the same transaction. Removing a related page or trashing it MUST either remove relation edges or preserve them as hidden references according to the editor's trash policy; query results MUST not show trashed related pages unless requested.

## 11. Indexing and performance

The client SHOULD maintain derived indexes for queryable values:

```ts
interface QueryIndexSet {
  text: Map<PropertyId, TextIndex>;
  number: Map<PropertyId, NumberIndex>;
  date: Map<PropertyId, DateIndex>;
  option: Map<PropertyId, OptionIndex>;
  checkbox: Map<PropertyId, CheckboxIndex>;
  relation: RelationGraph;
  computed: ComputedPropertyCache;
}

interface ComputedPropertyCache {
  values: Map<PageId, Map<PropertyId, ComputedPropertyCacheEntry>>;
  reverseDependencies: Map<PropertyId, Set<PropertyId>>;
}

interface ComputedPropertyCacheEntry {
  value: FormulaValue | RollupValue;
  revision: Revision;
  dependencies: FormulaDependency[];
  stale: boolean;
  error?: FormulaError;
}
```

Indexes are implementation details, but their externally visible behavior MUST match direct evaluation over the snapshot. Incremental index maintenance SHOULD happen inside transactions. Expensive formula and rollup evaluation SHOULD be lazy for non-visible properties but MUST be complete before a query filters, sorts, groups, or displays that computed property, unless the query result explicitly reports `computed_pending`.

## 12. JSON example

```json
{
  "database": {
    "id": "db-projects",
    "blockId": "block-projects-db",
    "title": [{ "type": "text", "plainText": "Projects", "text": { "content": "Projects" } }],
    "isInline": true,
    "dataSourceIds": ["ds-projects"],
    "defaultDataSourceId": "ds-projects",
    "viewIds": ["view-board", "view-table"]
  },
  "dataSource": {
    "id": "ds-projects",
    "databaseId": "db-projects",
    "schemaVersion": 7,
    "propertyOrder": ["title", "status", "owner", "due", "tasks", "open", "health"],
    "properties": {
      "title": { "id": "title", "name": "Name", "type": "title", "config": {}, "positionKey": "a" },
      "status": {
        "id": "status",
        "name": "Status",
        "type": "status",
        "config": {
          "options": [
            { "id": "todo", "name": "Not started", "color": "default", "groupId": "g-todo" },
            { "id": "doing", "name": "In progress", "color": "blue", "groupId": "g-doing" },
            { "id": "done", "name": "Done", "color": "green", "groupId": "g-done" }
          ],
          "groups": [
            { "id": "g-todo", "name": "To-do", "color": "gray", "optionIds": ["todo"] },
            { "id": "g-doing", "name": "Doing", "color": "blue", "optionIds": ["doing"] },
            { "id": "g-done", "name": "Complete", "color": "green", "optionIds": ["done"] }
          ]
        },
        "positionKey": "b"
      },
      "owner": { "id": "owner", "name": "Owner", "type": "people", "config": {}, "positionKey": "c" },
      "due": { "id": "due", "name": "Due", "type": "date", "config": {}, "positionKey": "d" },
      "tasks": {
        "id": "tasks",
        "name": "Tasks",
        "type": "relation",
        "config": { "targetDataSourceId": "ds-tasks", "dualProperty": { "targetPropertyId": "project" } },
        "positionKey": "e"
      },
      "open": {
        "id": "open",
        "name": "Open tasks",
        "type": "rollup",
        "config": { "relationPropertyId": "tasks", "targetPropertyId": "done", "function": "percent_unchecked" },
        "positionKey": "f"
      },
      "health": {
        "id": "health",
        "name": "Health",
        "type": "formula",
        "config": { "expression": "if(prop(\"Open tasks\") > 0.5, \"At risk\", \"OK\")" },
        "positionKey": "g"
      }
    }
  },
  "view": {
    "id": "view-board",
    "databaseId": "db-projects",
    "dataSourceId": "ds-projects",
    "name": "Roadmap",
    "type": "board",
    "query": {
      "filter": { "type": "property", "propertyId": "status", "operator": "does_not_equal", "value": "done" },
      "sorts": [{ "kind": "property", "propertyId": "due", "direction": "ascending" }],
      "groupBy": { "propertyId": "status", "hideEmptyGroups": false }
    },
    "layout": { "type": "board", "groupBy": { "propertyId": "status" }, "cardSize": "medium" },
    "propertyVisibility": { "owner": { "visible": true }, "due": { "visible": true }, "open": { "visible": false } }
  },
  "row": {
    "pageId": "page-project-alpha",
    "dataSourceId": "ds-projects",
    "values": {
      "title": { "type": "title", "title": [{ "type": "text", "plainText": "Alpha", "text": { "content": "Alpha" } }] },
      "status": { "type": "status", "optionId": "doing" },
      "owner": { "type": "people", "userIds": ["user-daryl"] },
      "due": { "type": "date", "date": { "start": "2026-06-01" } },
      "tasks": { "type": "relation", "pageIds": ["page-task-1", "page-task-2"] }
    }
  }
}
```

## 13. TypeScript usage example

```ts
const tx = engine.transact([
  {
    type: "create_page_row",
    dataSourceId: "ds-projects",
    pageId: "page-project-beta",
    templateId: "tmpl-project-default",
    values: {
      title: { type: "title", title: [{ type: "text", plainText: "Beta", text: { content: "Beta" } }] },
      status: { type: "status", optionId: "todo" },
      due: { type: "date", date: { start: "2026-07-15" } },
    },
  },
]);

const result = engine.query({
  dataSourceId: "ds-projects",
  viewId: "view-board",
  projection: { propertyIds: ["title", "status", "owner", "due", "health"] },
  window: { offset: 0, limit: 50, overscan: 10 },
});

for (const group of result.groups ?? []) {
  console.log(group.label, group.totalKnown);
}
```

## 14. Conformance checklist

A complete Notion-compatible client database implementation MUST support:

- database blocks and linked database blocks in the document tree;
- database containers with one or more independently schematized data sources;
- page rows/items with body blocks and property maps;
- stable property IDs and mutable property names;
- title, rich text, number, select, multi-select, status, date, people, files, checkbox, URL, email, phone, relation, rollup, formula, created/edited metadata, unique ID, and button properties;
- table, board, calendar, list, gallery, and timeline views;
- saved and personal filters, sorts, grouping, search, hidden properties, and property projection;
- stable sorting, deterministic filtering, UI windowing, virtualization-friendly query output, and incremental recompute hooks;
- relation graph maintenance including dual relations;
- rollup aggregation with dependency invalidation;
- formula parsing, AST compilation, deterministic evaluation, null/error semantics, dependency tracking, cycle/depth protection, volatile recalculation, and diagnostics;
- database templates and client-executed buttons;
- atomic update operations that integrate with editor undo/redo and metadata updates without assuming a backend.
