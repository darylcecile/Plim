# Notion editor architecture: data model research

## Scope

This document researches Notion's data modelling approach for a future Notion-like editor clone. It focuses on public, developer-observable evidence from Notion's engineering blog and public API/help documentation, especially Notion's own write-up on the block data model at <https://www.notion.com/blog/data-model-behind-notion>. It covers pages, blocks, nesting, workspaces/teamspaces, databases/data sources, database pages, properties, views, filters/sorts/grouping, relations, rollups, formulas, templates, synced blocks, comments/mentions, files, sharing/permissions, migration/evolution, and likely implementation patterns.

Source posture:

- **Confirmed** means directly stated in a cited public source.
- **API-confirmed** means represented in Notion's public API; this is a developer-facing proxy and may differ from Notion's private record model.
- **Inference** means a reasoned implementation conclusion drawn from the confirmed public shape. Inferences are explicitly labeled.

## Executive summary

Notion's public architecture centers on a **record graph whose primary content record is the block**. Notion states that everything visible in the editor is a block, including text, images, lists, database rows, and pages; blocks have UUIDs, a type, flexible properties, an ordered `content` array of child block IDs, and a `parent` pointer used for permissions (<https://www.notion.com/blog/data-model-behind-notion>). The `content` array builds a render tree, while the parent pointer provides an unambiguous upward path for permission checks.

The public API exposes this model in a safer, higher-level way: page objects contain structured page properties; page content is retrieved recursively as block children; databases are now containers for one or more data sources; data sources own schemas and rows; rows are pages; views are first-class resources over data sources with filters, sorts, and layout configuration (<https://developers.notion.com/reference/block>, <https://developers.notion.com/reference/page>, <https://developers.notion.com/reference/database>, <https://developers.notion.com/reference/data-source>, <https://developers.notion.com/reference/view>). API shapes should not be treated as exact internal table layouts, but they reveal stable conceptual boundaries.

For a clone, the key design choice is to model content as **typed records with stable IDs plus ordered parent-child edges**, not as monolithic page documents. Database pages should reuse page/block primitives while adding flexible schema/property-value storage. The clone should expect denormalized indexes for rendering, permissions, search, relations, formulas, rollups, and views.

## Confirmed facts from public sources

### 1. Blocks are the atomic content unit

Confirmed from Notion engineering:

- Notion says, "Everything you see in Notion is a block," including text, images, lists, a row in a database, and pages themselves (<https://www.notion.com/blog/data-model-behind-notion>).
- Blocks are "dynamic units of information" that can be transformed into other block types or moved around Notion (<https://www.notion.com/blog/data-model-behind-notion>).
- Notion characterizes this as an "atomic, graph-like data model" designed to let information be moved, organized, and shared granularly (<https://www.notion.com/blog/data-model-behind-notion>).
- Every block has, at minimum:
  - **ID**: Notion uses randomly generated UUID v4 IDs. Page block IDs are visible at the end of page URLs (<https://www.notion.com/blog/data-model-behind-notion>).
  - **Properties**: a data structure containing custom attributes for that block. The common `title` property stores text content for paragraphs, lists, and page titles; more elaborate block types require additional properties (<https://www.notion.com/blog/data-model-behind-notion>).
  - **Type**: determines how the block is displayed and how properties are interpreted (<https://www.notion.com/blog/data-model-behind-notion>).
  - **Content**: an array or ordered set of block IDs representing child content (<https://www.notion.com/blog/data-model-behind-notion>).
  - **Parent**: a block ID of the block's parent; Notion says the parent is used for permissions (<https://www.notion.com/blog/data-model-behind-notion>).

Confirmed API proxy:

- Public API block objects have `object: "block"`, `id`, `parent`, `type`, timestamps, creator/editor references, trash state, `has_children`, and a type-specific payload object keyed by the block type (<https://developers.notion.com/reference/block>).
- API-supported block types include paragraphs, headings, lists, toggles, to-dos, callouts, child pages, child databases, columns, embeds, files, images, synced blocks, tables, templates, and `unsupported` for internal types not yet supported by the API (<https://developers.notion.com/reference/block>).
- Some block types support child blocks, including paragraphs, list items, toggles, to-dos, child pages, child databases, synced blocks, tables, templates, and toggleable headings (<https://developers.notion.com/reference/block>).

Implementation implication:

- A clone should treat block identity as stable and independent from rendering. Block type changes should not necessarily destroy stored payload fields, because Notion confirms that type and properties are decoupled.

### 2. Type is decoupled from stored properties

Confirmed from Notion engineering:

- Notion states that block type controls rendering and interpretation of properties; changing the type changes only the type attribute, not the block's stored properties or content (<https://www.notion.com/blog/data-model-behind-notion>).
- Example: a to-do block's `checked` property is ignored when the block is converted to a heading or callout, but remains stored and reappears if converted back to a to-do (<https://www.notion.com/blog/data-model-behind-notion>).
- Notion explicitly says decoupling property storage from block type enables efficient transformations, rendering changes, and collaboration because more user intent is preserved (<https://www.notion.com/blog/data-model-behind-notion>).

API proxy:

- The public API represents each block with a top-level `type` and a type-specific object, for example a paragraph has `paragraph.rich_text`, `paragraph.color`, and optionally `paragraph.children`, while a to-do has `to_do.rich_text`, `to_do.checked`, `to_do.color`, and optionally children (<https://developers.notion.com/reference/block>).
- The API does **not** necessarily expose ignored historical properties when a block changes type. The API is a sanitized representation; the blog is stronger evidence for internal property preservation.

Inference:

- Internally, block properties are likely stored as a flexible map/JSON-like payload keyed by property names rather than a fully rigid table per block type. The public API's discriminated-union shape is likely an external serialization over a more general internal property bag.

### 3. Nesting, children, and the render tree

Confirmed from Notion engineering:

- Blocks can be nested inside other blocks, including text inside toggles and infinitely nested sub-pages inside pages (<https://www.notion.com/blog/data-model-behind-notion>).
- A block's `content` attribute stores an ordered array of child block IDs, described as "downward pointers" to content/render children (<https://www.notion.com/blog/data-model-behind-notion>).
- Notion calls the hierarchical relationship between blocks and render children the **render tree** (<https://www.notion.com/blog/data-model-behind-notion>).
- Different block types render children differently: list blocks indent children, toggles show children only when expanded, and page blocks show children in a new page rather than inline (<https://www.notion.com/blog/data-model-behind-notion>).
- Indentation is structural, not presentational. Pressing indent moves the selected block into the preceding sibling's content array when possible (<https://www.notion.com/blog/data-model-behind-notion>).

API proxy:

- A page's content is represented by a list of block objects called the page's children (<https://developers.notion.com/guides/data-apis/working-with-page-content>).
- The API `Retrieve block children` endpoint returns only the first level of children for a block and must be called recursively for a complete page tree (<https://developers.notion.com/reference/get-block-children>, <https://developers.notion.com/guides/data-apis/working-with-page-content>).
- `Retrieve block children` is paginated and returns a `results` array plus pagination fields (<https://developers.notion.com/reference/get-block-children>).
- When appending block children, Notion appends at the end by default, or can position at `start`, `end`, or after a specific block via `position.after_block` (<https://developers.notion.com/guides/data-apis/working-with-page-content>).

Inference:

- Ordering is a first-class part of the parent-child relationship. The blog confirms an ordered `content` array internally. A clone can implement this either as an array on the parent record, as an edge table with a sortable key, or both. The array is easy to read atomically but expensive for concurrent inserts/reorders; an edge table with fractional positions is easier to mutate but requires extra indexing.

### 4. Parent pointers and permissions are separate from render children

Confirmed from Notion engineering:

- Notion cannot rely only on downward `content` arrays for permissions because early versions allowed a block to be referenced by multiple content arrays, making permission inheritance ambiguous (<https://www.notion.com/blog/data-model-behind-notion>).
- Searching all blocks' content arrays to reconstruct ancestors would also be inefficient, especially on clients (<https://www.notion.com/blog/data-model-behind-notion>).
- Notion therefore uses an "upward pointer" called the `parent` attribute for the permission system (<https://www.notion.com/blog/data-model-behind-notion>).
- Notion says upward parent pointers and downward content pointers mirror each other outside of edge cases they were working to clean up (<https://www.notion.com/blog/data-model-behind-notion>).

API proxy:

- Parent objects are represented consistently across pages, databases, data sources, comments, and blocks (<https://developers.notion.com/reference/parent-object>).
- Pages can be parented by pages, data sources, blocks, or the workspace. Blocks can be parented by pages, data sources, or blocks. Databases can be parented by pages, blocks, or the workspace. Data sources are parented by databases (<https://developers.notion.com/reference/parent-object>).
- The parent object has variants such as `page_id`, `block_id`, `database_id`, `data_source_id`, and `workspace` (<https://developers.notion.com/reference/parent-object>).

Clone implication:

- Do not derive authorization by reverse-scanning child lists. Store a canonical parent pointer or closure table for access checks. If you support references/synced content in multiple places, define exactly which parent owns permissions.

### 5. Persistence, transactions, client cache, and realtime sync

Confirmed from Notion engineering:

- Notion says a block's life starts on the client. UI actions are expressed as operations that create or update a single record; multiple operations are batched into transactions committed or rejected by the server as a group (<https://www.notion.com/blog/data-model-behind-notion>).
- Notion uses "records" as a general term for persisted data, including blocks, users, workspaces, and more (<https://www.notion.com/blog/data-model-behind-notion>).
- Creating a new to-do block involves the client generating a unique ID, setting type `to_do`, setting initial properties such as empty `title` and `checked`, adding the block ID to the parent's content array, grouping operations into a transaction, applying it locally, and queueing it for persistence (<https://www.notion.com/blog/data-model-behind-notion>).
- Native apps cache accessed records in an LRU cache on top of SQLite or IndexedDB called `RecordCache` (<https://www.notion.com/blog/data-model-behind-notion>). Notion separately wrote that moving desktop apps to SQLite improved page loads and navigation by about 50% for most users (<https://www.notion.com/blog/faster-page-load-navigation>).
- `TransactionQueue` stores transactions safely in IndexedDB or SQLite until persisted by the server or rejected (<https://www.notion.com/blog/data-model-behind-notion>).
- Transactions are serialized to JSON and posted to an internal `/saveTransactions` endpoint (<https://www.notion.com/blog/data-model-behind-notion>).
- On the server, Notion loads involved records, duplicates the "before" state, applies operations to create an "after" state, validates permissions and data coherency, then commits changed records to source-of-truth databases (<https://www.notion.com/blog/data-model-behind-notion>).
- After commits, Notion schedules version history snapshots and Quick Find indexing, and notifies `MessageStore`, its realtime update service (<https://www.notion.com/blog/data-model-behind-notion>).
- Clients maintain a long-lived WebSocket connection to MessageStore, subscribe to rendered records, receive version update notifications, then call `syncRecordValues` for outdated records and update local cache (<https://www.notion.com/blog/data-model-behind-notion>).
- Page loading uses an internal `loadPageChunk` API that descends from a starting page block down the content tree and returns blocks plus dependent records; Notion notes that worst-case loading may take many database trips as it recursively crawls the tree (<https://www.notion.com/blog/data-model-behind-notion>).

Inference:

- Notion uses an optimistic, record-oriented sync model rather than shipping whole page documents after every edit. It likely stores record versions per block/property-bearing record so clients can cheaply detect stale records.
- The operation/transaction layer is probably more granular than the public REST API. The public API endpoints are resource-oriented and do not expose `saveTransactions`, `loadPageChunk`, `syncRecordValues`, or MessageStore subscriptions.

Clone implication:

- A robust clone should separate user-visible REST/GraphQL APIs from an internal operation log. Even if the first version stores whole blocks, design for per-record versions, batched operations, local optimistic state, and asynchronous indexing.

### 6. Pages as blocks plus page-specific metadata

Confirmed/API-confirmed:

- Notion engineering says pages themselves are blocks (<https://www.notion.com/blog/data-model-behind-notion>).
- The comments guide states pages are technically blocks when explaining why comment listing uses a `block_id` query parameter for pages and blocks (<https://developers.notion.com/guides/data-apis/working-with-comments>).
- Public API page objects contain `object: "page"`, `id`, timestamps, creator/editor, icon, cover, parent, trash state, properties, URL, and public URL (<https://developers.notion.com/reference/page>).
- Page content and page properties are distinct in the API. Page properties capture structured information such as dates, categories, and relationships; page content is free-form content represented by blocks (<https://developers.notion.com/guides/data-apis/working-with-page-content>).
- A page created under another page accepts only a `title` property; a page created under a data source must have property keys that match the parent data source schema (<https://developers.notion.com/reference/post-page>).
- Pages can be created with child blocks, with Markdown content, or with a data source template, depending on API parameters (<https://developers.notion.com/reference/post-page>).

Inference:

- Internally, "page" is likely a block type with additional page metadata and, when part of a data source, property values. The API separates `page` from `block` to make the public model easier and safer.

Clone implication:

- Model pages as a specialization of block, not as a completely separate document type. A page needs a block identity, render children, permissions parent, icon/cover metadata, and optional database row/property values.

### 7. Workspace and teamspace hierarchy

Confirmed/API-confirmed:

- Notion's internal permission root is the workspace: the blog describes ancestor checks up to the root of the tree, "which is the workspace" (<https://www.notion.com/blog/data-model-behind-notion>).
- The API parent object has a `workspace` parent variant for top-level pages or databases (<https://developers.notion.com/reference/parent-object>).
- The API notes that team-level pages are currently represented as having a workspace parent in the API (<https://developers.notion.com/reference/parent-object>).
- Notion help says every workspace has at least one teamspace that includes everyone by default (<https://www.notion.com/help/intro-to-teamspaces>).
- Teamspaces have their own members, owners, permission levels, and security settings; teamspace access can be open, closed, or private depending on plan (<https://www.notion.com/help/intro-to-teamspaces>).
- Default teamspaces add every workspace member by default, and pages in default teamspaces are accessible by everyone in the workspace (<https://www.notion.com/help/intro-to-teamspaces>, <https://www.notion.com/help/sharing-and-permissions>).
- Teamspaces can be archived but not deleted, and teamspace owners can restore archived teamspaces if they are also workspace owners (<https://www.notion.com/help/intro-to-teamspaces>).

Inference:

- Teamspaces are likely an organizational/access layer above top-level pages, not a different kind of content tree node exposed uniformly in the public API. Because the API maps team-level pages to workspace parents, internal teamspace membership and sidebar placement are probably separate records linked to root pages.

Clone implication:

- Do not hard-code a single global root page. Use `workspace -> teamspace -> root pages` conceptually, but keep page parentage and access grants separate enough to mirror Notion's API behavior where teamspace roots can appear as workspace-parented content.

### 8. Databases, data sources, and database items/pages

Confirmed/API-confirmed:

- The API now defines a **database** as an object containing one or more **data sources**. A database can be inline in a parent page (`is_inline: true`) or a full page (`is_inline: false`) (<https://developers.notion.com/reference/database>).
- A database object's fields include `id`, `data_sources`, timestamps, title, description, icon, cover, parent, URL, trash state, inline state, and public URL (<https://developers.notion.com/reference/database>).
- The API says properties/schema of each data source under a database can be maintained independently, and each data source has its own rows/pages (<https://developers.notion.com/reference/database>).
- Individual data sources do not have permissions settings in the API model; access to data source children is managed through databases (<https://developers.notion.com/reference/database>).
- Data sources are "individual tables of data that live under a Notion database"; pages are the items/children in a data source; page property values must conform to the data source's property objects (<https://developers.notion.com/reference/data-source>).
- The data source object contains `id`, `properties`, `parent` database, `database_parent` grandparent, timestamps, title, description, icon, and trash state (<https://developers.notion.com/reference/data-source>).
- Notion help says every database has at least one data source and a data source is a set of pages in a database (<https://www.notion.com/help/data-sources-and-linked-databases>).
- A database can contain multiple data sources, including newly created sources and linked existing sources; editing a linked data source's title, properties, or pages is reflected in the original data source, while views/filters/sorts/groups in the linked context do not affect original views (<https://www.notion.com/help/data-sources-and-linked-databases>).
- Creating a database through the API provisions one data source and one default Table view named "Default view" (<https://developers.notion.com/guides/data-apis/working-with-views>).
- API version `2025-09-03` introduced first-class multi-source database support and moved most operations that used `database_id` to `data_source_id` (<https://developers.notion.com/guides/get-started/upgrade-guide-2025-09-03>).

Potential tension to model carefully:

- API docs say data sources do not have individual permission settings and database permissions manage access (<https://developers.notion.com/reference/database>).
- The sharing help page says database page-level access rules can be configured per data source when a database contains multiple data sources (<https://www.notion.com/help/sharing-and-permissions>). This appears to be a UI/product permission rule layered on database sharing, not necessarily a standalone data-source ACL exposed by the API.

Clone implication:

- Treat database as a **container/view surface and permission boundary**, and data source as a **schema plus row collection**. This distinction is important for multi-source databases and linked database views.

### 9. Data source property schema

Confirmed/API-confirmed:

- Data source property objects define the schema of a data source and render as columns in the UI (<https://developers.notion.com/reference/property-object>).
- Every property object has `id`, `name`, `description`, `type`, and a type-specific configuration object (<https://developers.notion.com/reference/property-object>).
- Property IDs are usually short random strings/symbols; special generated properties can have human-readable IDs such as title property `id: "title"` (<https://developers.notion.com/reference/property-object>).
- Supported data source property types include checkbox, created_by, created_time, date, email, files, formula, last_edited_by, last_edited_time, multi_select, number, people, phone_number, place, relation, rich_text, rollup, select, status, title, unique_id, and URL (<https://developers.notion.com/reference/property-object>).
- Select and multi-select options have stable option IDs, names, and colors; option names must be unique case-insensitively, and commas are not valid (<https://developers.notion.com/reference/property-object>).
- Status has options and groups; groups contain sorted `option_ids` (<https://developers.notion.com/reference/property-object>).
- Unique ID is auto-incremented and unique across all pages in a data source, with optional prefix (<https://developers.notion.com/reference/property-object>).
- Formula schema stores an `expression`; rollup schema stores a relation property, a rollup property, and a function (<https://developers.notion.com/reference/property-object>).
- Relation schema points to a `data_source_id`; dual relations include a `dual_property` with synced property ID/name for the corresponding property in the related data source (<https://developers.notion.com/reference/property-object>).

Clone implication:

- Use stable property IDs everywhere internally. Display names are mutable labels. Views, filters, formula references, rollups, import/export mappings, and API clients should survive property renames.

### 10. Page property values

Confirmed/API-confirmed:

- A page object is made of page properties containing data about the page (<https://developers.notion.com/reference/page-property-values>).
- Page property value objects include `id`, `type`, and a type-specific value object (<https://developers.notion.com/reference/page-property-values>).
- The page property `id` remains constant when the property name changes and may be used instead of the name when creating/updating pages (<https://developers.notion.com/reference/page-property-values>).
- Formula values are computed results and cannot be updated directly through the API (<https://developers.notion.com/reference/page-property-values>).
- Rollup values are computed results and cannot be updated directly through the API (<https://developers.notion.com/reference/page-property-values>).
- Relations are arrays of page references; if a relation has more than 25 references in a page response, `has_more` is true and the property item endpoint should be used to retrieve complete values (<https://developers.notion.com/reference/page-property-values>).
- The docs recommend using the page property item API for formulas, rollups, and relations to avoid truncation and ensure accurate current values (<https://developers.notion.com/reference/page-property-values>).
- Title, rich_text, relation, and people properties are returned as paginated lists of property items by the retrieve-page-property endpoint (<https://developers.notion.com/reference/page-property-values>).
- The public API supports a subset of property types; unsupported types can return `null` and should be excluded when updating page properties (<https://developers.notion.com/reference/page-property-values>).

Request/size constraints relevant to data modelling:

- Notion API payloads have a maximum of 1000 block elements and 500KB overall (<https://developers.notion.com/reference/request-limits>).
- Rich text content is limited to 2000 characters per `text.content`; arrays of block types/rich text objects are limited to 100 elements; relation properties are limited to 100 related pages; people properties to 100 users in requests (<https://developers.notion.com/reference/request-limits>).

Inference:

- Internally, property values may be stored as a flexible property-value map per page, but efficient database querying likely requires secondary typed indexes or denormalized scalar columns for common filter/sort types.

### 11. Views, filters, sorts, grouping, and presentation settings

Confirmed/API-confirmed:

- Views define how pages in a data source are filtered, sorted, and displayed within a database (<https://developers.notion.com/reference/view>).
- Supported view types include table, board, calendar, timeline, gallery, list, form, chart, map, and dashboard (<https://developers.notion.com/reference/view>).
- View objects include `id`, parent database, `data_source_id`, name, type, filter, sorts, type-specific configuration, timestamps, URL, and dashboard widget linkage when applicable (<https://developers.notion.com/reference/view>).
- View filters and sorts use the same shapes as data source queries (<https://developers.notion.com/guides/data-apis/working-with-views>).
- The view configuration includes property visibility/display, group-by, sub-group-by, subtasks, covers, card layout, calendar/timeline date properties, table freeze/wrap options, map configuration, form submission settings, chart settings, and dashboard rows depending on view type (<https://developers.notion.com/guides/data-apis/working-with-views>).
- Board views require group-by configuration; table views can optionally group; board views can optionally sub-group (<https://developers.notion.com/guides/data-apis/working-with-views>).
- Linked database views can reference an existing data source from another page without creating a new schema (<https://developers.notion.com/guides/data-apis/working-with-views>, <https://www.notion.com/help/data-sources-and-linked-databases>).
- Notion help confirms each database view has its own settings; view settings include layout, property visibility, filter, sort, group, sub-group, and copy link to view (<https://www.notion.com/help/views-filters-and-sorts>).
- Users can save filters/sorts for everyone or keep them personal in the UI (<https://www.notion.com/help/views-filters-and-sorts>). The public View API primarily exposes saved view-level configuration, not necessarily every user's ephemeral local filter state.

Filters:

- Querying a data source returns pages filtered and ordered according to filter and sort criteria (<https://developers.notion.com/reference/query-a-data-source>).
- Filters operate on data source properties and can be chained with `and` and `or` compound filters (<https://developers.notion.com/reference/query-a-data-source>, <https://developers.notion.com/reference/filter-data-source-entries>).
- API filter conditions exist for checkbox, date, files, formula, multi-select, number, people, phone, relation, rich text, select, status, timestamp, verification, and unique ID (<https://developers.notion.com/reference/filter-data-source-entries>).
- API compound filter nesting is documented as supported up to two levels deep (<https://developers.notion.com/reference/filter-data-source-entries>), while the UI help says advanced filters can be nested up to three layers deep (<https://www.notion.com/help/views-filters-and-sorts>). This is an example where API shape and UI/internal capability may diverge.

Sorts:

- Data source queries can sort by a property or by entry timestamps `created_time` and `last_edited_time`, in ascending or descending direction (<https://developers.notion.com/reference/sort-data-source-entries>).
- Multiple sorts are supported; earlier sorts take precedence (<https://developers.notion.com/reference/query-a-data-source>, <https://developers.notion.com/reference/sort-data-source-entries>).
- Notion does not guarantee any particular sort order when no sort parameters are provided (<https://developers.notion.com/reference/query-a-data-source>).

Search/performance:

- Data source query pagination stops at 10,000 results per query; Notion recommends narrower filters and webhooks for incremental sync on large sources (<https://developers.notion.com/reference/query-a-data-source>).
- Notion recommends `filter_properties` to limit returned page properties and improve response speed/size, especially for databases with many properties, rollups, relations, or formulas (<https://developers.notion.com/reference/query-a-data-source>).
- Notion recommends splitting very large data sources, pruning unused complex formulas/rollups/two-way relations, and using webhooks rather than polling (<https://developers.notion.com/reference/query-a-data-source>).
- Database search in the UI looks at database page titles and properties (<https://www.notion.com/help/views-filters-and-sorts>).
- The public Search endpoint is optimized for pages/databases by name, not exhaustive enumeration or filtering within a database, and indexing is not immediate (<https://developers.notion.com/reference/search-optimizations-and-limitations>).

Clone implication:

- Views are not just client preferences. They are persisted query + presentation objects. Store filter/sort/group/layout separately from data source schema and page values.

### 12. Relations, rollups, and formulas

Relations — confirmed/API-confirmed:

- A relation property connects data between databases/data sources and represents pages from one database in a property field of another (<https://www.notion.com/help/relations-and-rollups>).
- Relation properties are one-way by default but can be configured as two-way; two-way edits propagate both directions in the UI (<https://www.notion.com/help/relations-and-rollups>).
- Relations can point to the same database/data source, though Notion recommends turning off two-way relation for self-relations to avoid duplicate properties (<https://www.notion.com/help/relations-and-rollups>).
- The API relation schema points to a target `data_source_id`, and page relation values are arrays of page references with `id` (<https://developers.notion.com/reference/property-object>, <https://developers.notion.com/reference/page-property-values>).
- API relation schema for dual relations includes `dual_property` with the synced property ID/name (<https://developers.notion.com/reference/property-object>).
- The UI can limit relations to one page or no limit (<https://www.notion.com/help/relations-and-rollups>). The public API request limits cap relation arrays in a single request at 100 related pages (<https://developers.notion.com/reference/request-limits>).

Rollups — confirmed/API-confirmed:

- Rollups aggregate data based on relations by choosing a relation property, a property on the related pages, and a calculation (<https://www.notion.com/help/relations-and-rollups>).
- API rollup schema stores relation property ID/name, rollup property ID/name, and function (<https://developers.notion.com/reference/property-object>).
- Rollup page values are computed and read-only through the API (<https://developers.notion.com/reference/page-property-values>).
- API rollup functions include average, checked, count, count values, date range, earliest/latest date, max, median, min, percent checked/empty/not empty/unchecked, range, show original, show unique, sum, unchecked, unique, and related functions (<https://developers.notion.com/reference/page-property-values>, <https://developers.notion.com/reference/property-object>).
- Help notes rollups can only be sorted when they output a numeric value and rollups cannot roll up rollups because this could create unintended loops (<https://www.notion.com/help/relations-and-rollups>).

Formulas — confirmed/API-confirmed:

- Formula properties run calculations/functions based on other database properties (<https://www.notion.com/help/formulas>).
- Formulas can use properties, built-ins/operators/booleans, and functions (<https://www.notion.com/help/formulas>).
- API formula schema stores an `expression` string (<https://developers.notion.com/reference/property-object>).
- Formula page values are computed results with type boolean, date, number, or string and cannot be updated directly via the API (<https://developers.notion.com/reference/page-property-values>).

Inference:

- Relations are likely stored as explicit edges keyed by relation property ID, not merely as embedded page-property JSON, because two-way sync, rollups, backlinks, search, permission checks, and relation lookup need efficient reverse access.
- Formula and rollup values are likely computed on demand and/or cached with dependency invalidation. Public performance guidance to prune complex formulas/rollups implies they impose query-time or index-maintenance cost (<https://developers.notion.com/reference/query-a-data-source>).

Clone implication:

- Build a dependency graph for formula/rollup invalidation early. Even if formulas initially evaluate on read, relations and rollups will quickly require reverse indexes and cycle protection.

### 13. Templates

Confirmed/API-confirmed:

- Database templates are blueprints for page properties and content under a data source (<https://developers.notion.com/guides/data-apis/creating-pages-from-templates>).
- The Notion app can create/manage templates and designate a default template (<https://developers.notion.com/guides/data-apis/creating-pages-from-templates>).
- The API can list data source templates; each template has `id`, `name`, and `is_default`, with pagination up to 100 at a time (<https://developers.notion.com/reference/list-data-source-templates>).
- Templates are regular pages in Notion; their full properties and content can be retrieved with page/content APIs when the bot has access (<https://developers.notion.com/guides/data-apis/creating-pages-from-templates>, <https://developers.notion.com/reference/list-data-source-templates>).
- Creating a page can use no template, the data source's default template, or a specific `template_id`; when applying a template, explicit children are not allowed in the request (<https://developers.notion.com/reference/post-page>).
- Template application is asynchronous. The Create Page response initially returns a blank page except initial properties, then Notion applies the template content/properties in the background and emits page created/content updated events depending on timing (<https://developers.notion.com/guides/data-apis/creating-pages-from-templates>).
- Template variables like `@now` and `@today` resolve using a timezone, configurable via `template[timezone]` (<https://developers.notion.com/reference/post-page>, <https://developers.notion.com/guides/data-apis/creating-pages-from-templates>).
- The block API also has a `template` block type representing template buttons; its children are duplicated when the template block is used in the UI (<https://developers.notion.com/reference/block>).
- Rich text can include `template_mention` objects for placeholder date/user mentions inside template buttons (<https://developers.notion.com/reference/rich-text>).

Clone implication:

- Treat templates as ordinary pages/blocks with metadata, not a wholly separate content format. Applying templates is a copy/merge operation with variable resolution and should probably run asynchronously for large templates.

### 14. Synced blocks

Confirmed/API-confirmed:

- Synced blocks let users reuse the same block and contents across pages or workspaces; edits in one instance appear in all synced locations (<https://www.notion.com/help/synced-blocks>).
- Users need access to the page containing the original block to see synced block contents; edit access to the original is required to edit copies (<https://www.notion.com/help/synced-blocks>).
- Unsyncing a copy breaks the connection; unsync all breaks all copies; deleting an original with more than 10 copies removes all copies according to the help documentation (<https://www.notion.com/help/synced-blocks>).
- API `synced_block` objects have an original form with `synced_from: null` and children, and duplicate synced blocks whose `synced_from` points to the original block ID (<https://developers.notion.com/reference/block>).
- The original's nested child blocks are mirrored in duplicate synced blocks (<https://developers.notion.com/reference/block>).

Inference:

- Synced blocks are a controlled exception to a pure tree. A duplicate block has its own location/parent but renders content from an original block subtree. This reinforces Notion's distinction between render children and permission parent.

Clone implication:

- Represent synced blocks as reference blocks with a source block ID, not by copying child blocks eagerly. Define permission behavior explicitly: read/edit should depend on both containing page access and source/original access.

### 15. Comments, discussions, and mentions

Comments — confirmed/API-confirmed:

- Users can comment at the top of a page or inline on text/blocks (<https://developers.notion.com/guides/data-apis/working-with-comments>).
- The comment object includes `id`, `parent`, `discussion_id`, timestamps, author, `rich_text`, attachments, and display name (<https://developers.notion.com/reference/comment-object>).
- Notion page permissions include comment-specific levels; users need `Can comment` or higher to add comments in the UI (<https://developers.notion.com/guides/data-apis/working-with-comments>, <https://www.notion.com/help/sharing-and-permissions>).
- API connections need comment capabilities to read or insert comments (<https://developers.notion.com/guides/data-apis/working-with-comments>, <https://developers.notion.com/reference/capabilities>).
- Public API connections can add top-level comments, update/delete comments, respond to existing discussion threads, and read open comments on a block or page; they cannot start a new inline discussion thread or retrieve resolved comments (<https://developers.notion.com/guides/data-apis/working-with-comments>).
- Listing comments returns a flat list of open comments for a page or block; multiple discussion threads are distinguished by `discussion_id` (<https://developers.notion.com/guides/data-apis/working-with-comments>).

Mentions/rich text — confirmed/API-confirmed:

- Rich text objects include `type`, type-specific object, annotations, `plain_text`, and optional `href` (<https://developers.notion.com/reference/rich-text>).
- Rich text types include `text`, `mention`, and `equation`; annotations include bold, italic, strikethrough, underline, code, and color (<https://developers.notion.com/reference/rich-text>).
- Mention objects can represent databases, dates, link previews, pages, template mentions, or users (<https://developers.notion.com/reference/rich-text>).
- If a connection lacks access to a mentioned page or database, the mention may return only the ID, with `plain_text` as `Untitled` and default annotations (<https://developers.notion.com/reference/rich-text>).

Clone implication:

- Comments should be modelled as discussion-thread records anchored to a page/block and possibly a text range or block-specific anchor. Mentions should be structured inline spans with target IDs and permission-aware rendering/redaction.

### 16. Files and media

Confirmed/API-confirmed:

- API file objects represent media assets and have `type: "file"`, `"file_upload"`, or `"external"` (<https://developers.notion.com/reference/file-object>).
- Notion-hosted files return an authenticated download URL and `expiry_time`; URLs are valid for one hour and should be refreshed by re-fetching the block/object (<https://developers.notion.com/reference/file-object>).
- External files store a public URL and never expire in API responses (<https://developers.notion.com/reference/file-object>).
- API-uploaded files use a File Upload object ID that can be attached to blocks/properties; after attachment, API responses return a type of `file` for Notion-hosted content (<https://developers.notion.com/reference/file-object>).
- Uploaded files can attach to media blocks (`file`, `image`, `pdf`, `audio`, `video`), `files` properties, and page icons/covers (<https://developers.notion.com/guides/data-apis/working-with-files-and-media>).
- Upload methods include direct upload for files up to 20MB, multipart for larger files, and indirect import from public URLs (<https://developers.notion.com/guides/data-apis/working-with-files-and-media>).
- Workspace limits differ by plan: free workspaces are limited to 5 MiB per file, paid workspaces to 5 GiB per file; files larger than 20 MiB require multipart upload (<https://developers.notion.com/guides/data-apis/working-with-files-and-media>).

Clone implication:

- Store file metadata separately from blocks/properties. Blocks/properties should reference file asset IDs or external URLs, not embed binary data. Download URLs should be short-lived signed URLs for private assets.

### 17. Sharing, permissions, and access levels

Confirmed/API-confirmed:

- Notion's block parent pointer is used for permission inheritance (<https://www.notion.com/blog/data-model-behind-notion>).
- Sharing a parent page with an internal connection grants access to all child pages, and access is inherited (<https://developers.notion.com/guides/get-started/internal-connections>).
- Internal connections operate as bot users; permissions belong to the connection, not an individual person, and persist if the user who shared a page leaves the workspace (<https://developers.notion.com/guides/get-started/internal-connections>).
- Connections also have capabilities controlling what endpoints they can call and what they can see: read/update/insert content, read/insert comments, and levels of user information access (<https://developers.notion.com/reference/capabilities>).
- Capabilities do not supersede user-granted access; if a user loses edit access where they added a connection, the connection also only has read access regardless of configured capabilities (<https://developers.notion.com/reference/capabilities>).
- UI page permission levels include Full access, Can edit, Can edit content for database pages, Can comment, and Can view (<https://www.notion.com/help/sharing-and-permissions>).
- General access can be only invited people, everyone in the workspace, or anyone on the web with link; public links can expire and can be disabled by enterprise settings (<https://www.notion.com/help/sharing-and-permissions>).
- Subpages inherit permissions from parent pages by default, but permissions can be changed on subpages (<https://www.notion.com/help/sharing-and-permissions>).
- Notion respects the broadest level of access given to a user (<https://www.notion.com/help/sharing-and-permissions>).
- Database page-level access rules can grant permissions based on a person or created-by property; rules apply across all views and linked views of that database (<https://www.notion.com/help/sharing-and-permissions>).
- Pages with public link access may be discoverable through mentions/links, two-way relations to broader pages, or nesting under broader pages (<https://www.notion.com/help/sharing-and-permissions>).

Inference:

- Notion likely combines inherited ACLs, direct shares, workspace/teamspace/group membership, public-link flags, integration capabilities, and database property-based rules at authorization time. For performance, it likely maintains denormalized access caches or ancestor paths in addition to canonical grants.

Clone implication:

- Authorization must be designed before content links/synced blocks/relations. It is difficult to retrofit after arbitrary graph references are allowed.

### 18. Migration and evolution signals

Confirmed/API-confirmed:

- Notion's API is date-versioned; the `Notion-Version` header is required (<https://developers.notion.com/reference/versioning>).
- Backwards-incompatible API changes get a new version. Backwards-compatible changes include additive fields/endpoints, opaque identifier format changes for non-record IDs/cursors, error text improvements, rate limit adjustments, and performance/ordering improvements (<https://developers.notion.com/reference/versioning>).
- Record identifiers such as page, database, user, and block IDs are guaranteed stable UUIDs, while cursors and request IDs should not be parsed or stored beyond API use (<https://developers.notion.com/reference/versioning>).
- API `2025-09-03` introduced multi-source databases and split database-level vs data-source-level operations (<https://developers.notion.com/guides/get-started/upgrade-guide-2025-09-03>).
- Notion's public block API may return `unsupported` for internal block types not yet supported by the API, with an informational `block_type` string such as `form`, `button`, or `drive` (<https://developers.notion.com/reference/block>).

Clone implication:

- The model must tolerate new block types, new property types, new view configuration fields, and migration from old conceptual boundaries to new ones. Store unknown payload fields where possible and design API clients to ignore unknown fields.

## API representation as a developer-facing proxy

The public API is extremely useful for clone design, but it should be treated as a **projection** of Notion's internal model, not the exact schema.

### Public API object map

| Concept | Public API representation | What it likely tells us | Caveats |
| --- | --- | --- | --- |
| Block | `block` object with `id`, `parent`, `type`, timestamps, `has_children`, type-specific payload (<https://developers.notion.com/reference/block>) | Content is typed and nested; stable IDs are central. | API returns sanitized type payloads, not necessarily all internal properties. |
| Page | `page` object with properties, parent, icon/cover, URL (<https://developers.notion.com/reference/page>) | Pages are content roots plus structured metadata/property values. | Pages are technically blocks, but API separates page and block resources. |
| Children/order | `Retrieve block children` returns paginated first-level children (<https://developers.notion.com/reference/get-block-children>) | Children are ordered and must be recursively loaded. | Internal blog says parent stores `content` array; API does not expose the raw array field. |
| Database | Container with one or more data source references (<https://developers.notion.com/reference/database>) | Database is now a container/view/permission surface. | Internal legacy names and data structures may differ. |
| Data source | Schema + rows/pages under a database (<https://developers.notion.com/reference/data-source>) | Schema and row collection are separate from database container. | API change is recent; UI/internal may support more cases than API. |
| Property schema | Property objects with stable IDs, names, types, config (<https://developers.notion.com/reference/property-object>) | Flexible user-defined schemas with type-specific config. | Some UI property types are unsupported or read-only via API. |
| Property value | Page property value objects keyed by property name/id (<https://developers.notion.com/reference/page-property-values>) | Rows store typed values conforming to data source schema. | API truncates/paginates complex values; computed values may be stale unless fetched specifically. |
| View | View object with type, data_source_id, filters, sorts, config (<https://developers.notion.com/reference/view>) | Views are persisted resources, not merely client UI state. | Personal unsaved filters/sorts may not be represented. |
| Comment | Comment object with discussion ID, parent, rich text, attachments (<https://developers.notion.com/reference/comment-object>) | Comments are separate threaded records anchored to blocks/pages. | API cannot create new inline discussion threads or retrieve resolved comments. |
| File | File object discriminated by hosted/upload/external type (<https://developers.notion.com/reference/file-object>) | File metadata is separate from content records. | Hosted file URLs are temporary signed URLs. |

### Important API/internal divergences

1. **Pages are blocks internally, but pages are separate API resources.** The blog and comments guide say pages are blocks; the API uses a page object for page-level metadata and block APIs for content (<https://www.notion.com/blog/data-model-behind-notion>, <https://developers.notion.com/guides/data-apis/working-with-comments>, <https://developers.notion.com/reference/page>).
2. **Internal child storage is `content`; API exposes child listing.** The blog says parent blocks store ordered child ID arrays; the API returns paginated children and `has_children`, not the raw content array (<https://www.notion.com/blog/data-model-behind-notion>, <https://developers.notion.com/reference/get-block-children>).
3. **API block types lag internal block types.** The `unsupported` block type is direct evidence that Notion has internal blocks not fully exposed publicly (<https://developers.notion.com/reference/block>).
4. **Database/data source split is API-visible and evolving.** The 2025 migration changed endpoints and parent semantics. A clone should assume product semantics evolve and keep compatibility layers (<https://developers.notion.com/guides/get-started/upgrade-guide-2025-09-03>).
5. **Permissions are partly invisible.** API parent objects and capabilities expose only a slice of UI permission behavior. Teamspaces, page-level database rules, broadest-access resolution, guest rules, and security settings are primarily help-center/product concepts (<https://developers.notion.com/reference/parent-object>, <https://www.notion.com/help/sharing-and-permissions>, <https://www.notion.com/help/intro-to-teamspaces>).
6. **API limits may be product/API constraints, not storage constraints.** Public request limits such as 100 rich text elements or 100 relation values per request do not necessarily describe internal database limits (<https://developers.notion.com/reference/request-limits>).

## Inferred internal model

This section is reasoned inference from the public sources above.

### Inference: Notion has a generic record store with typed records

The blog uses "record" broadly for persisted entities such as blocks, users, and workspaces, and describes operations updating individual records in transactions (<https://www.notion.com/blog/data-model-behind-notion>). A likely internal pattern is:

```text
record(id, table/type, version, created_time, last_edited_time, created_by, last_edited_by, payload)
```

Blocks, users, workspaces, comments, views, databases, data sources, and other entities may be different record tables or a shared record abstraction. The sync system appears record-version-based: clients subscribe to records, receive version notifications, then request changed record values.

### Inference: Blocks are flexible payload records plus structural edges

A likely block record contains:

```text
block_id uuid primary key
workspace_id uuid
logical_type text                  -- paragraph, to_do, page, synced_block, etc.
properties json/jsonb              -- flexible payload; may preserve ignored fields
content child_id[] or child edges   -- ordered render children
parent_id uuid                     -- canonical permission parent
parent_type enum                   -- block/page/data_source/workspace/etc.
created_by, created_time
last_edited_by, last_edited_time
version
trash/archive flags
```

The blog explicitly confirms `id`, `properties`, `type`, `content`, and `parent` (<https://www.notion.com/blog/data-model-behind-notion>). The exact storage medium is unknown.

### Inference: Child order may be dual-stored

Notion confirms a parent block stores a `content` array of child IDs. For performance and collaboration, it may also maintain indexes by parent or separate edge records. A clone can choose:

- **Parent array only**: simple read path and mirrors Notion's blog description; expensive concurrent reorders and large parent updates.
- **Child edge table only**: `block_children(parent_id, child_id, position_key)`; efficient mutations and indexes; reconstruct arrays on read.
- **Hybrid**: canonical edge table plus denormalized ordered array/cache for fast rendering.

Because Notion batches block creation with a parent content-array update, a clone must make block creation and insertion transactional.

### Inference: Flexible database schemas require both JSON and indexes

The API presents data source property schemas as a dynamic object keyed by property name and with stable property IDs (<https://developers.notion.com/reference/property-object>). Page property values are dynamic objects keyed by property name/ID (<https://developers.notion.com/reference/page-property-values>). A straightforward internal clone schema:

```text
data_sources(id, database_id, title, icon, schema_version, properties_json, ...)
property_defs(id, data_source_id, name, type, config_json, sort_order, archived)
pages(id, data_source_id nullable, block_id/id, ...)
page_property_values(page_id, property_id, type, value_json, scalar_text, scalar_number, scalar_date, scalar_bool)
```

`value_json` preserves full fidelity; scalar columns support filters/sorts/indexes. Select/status options deserve normalized child tables if option ordering and color are important.

### Inference: Relations need edge tables

Although the API serializes relation values as arrays of page references, relation queries, two-way relations, rollups, mentions, permissions, and relation lookup likely require an index:

```text
relation_edges(
  relation_property_id,
  from_page_id,
  to_page_id,
  target_data_source_id,
  position_key,
  created_time
)
```

The page property value can still cache ordered related IDs for read/render fidelity.

### Inference: Formula and rollup computation needs dependency tracking

Formula expressions reference properties. Rollups reference a relation property plus a target property. Therefore a clone should maintain dependencies such as:

```text
computed_property_dependencies(computed_property_id, depends_on_property_id)
rollup_dependencies(rollup_property_id, relation_property_id, target_property_id)
computed_property_cache(page_id, property_id, value_json, computed_at, stale_flag)
```

Notion's own performance guidance warns that complex formulas, rollups, and two-way relations affect query performance (<https://developers.notion.com/reference/query-a-data-source>), supporting the need for dependency/index planning.

### Inference: Permissions need canonical ancestry plus denormalized access paths

Confirmed facts require:

- Parent pointers for permission ancestry (<https://www.notion.com/blog/data-model-behind-notion>).
- Direct shares and inherited shares (<https://developers.notion.com/guides/get-started/internal-connections>, <https://www.notion.com/help/sharing-and-permissions>).
- Workspace/teamspace membership (<https://www.notion.com/help/intro-to-teamspaces>).
- Broadest-access wins (<https://www.notion.com/help/sharing-and-permissions>).
- Database page-level access rules via person properties (<https://www.notion.com/help/sharing-and-permissions>).

A clone likely needs:

```text
acl_grants(resource_id, resource_type, subject_id, subject_type, access_level, inherited_from nullable)
resource_parent(resource_id, parent_id, parent_type)
resource_ancestors(resource_id, ancestor_id, depth)       -- optional closure table/cache
teamspace_members(teamspace_id, subject_id, role)
public_links(resource_id, access_level, expires_at)
database_page_access_rules(data_source_id, person_property_id, access_level)
```

The canonical parent pointer must remain authoritative, but an ancestor/access cache prevents expensive tree walks on every request.

### Inference: Search and denormalized indexes are essential

Confirmed sources mention Quick Find indexing after transactions (<https://www.notion.com/blog/data-model-behind-notion>), database search over titles/properties (<https://www.notion.com/help/views-filters-and-sorts>), non-immediate API search indexing (<https://developers.notion.com/reference/search-optimizations-and-limitations>), and performance constraints for large data sources (<https://developers.notion.com/reference/query-a-data-source>). A clone should maintain specialized indexes:

- Full-text index over block rich text, page titles, database property values, comments, maybe file names.
- Property indexes by data source/property/type for filters and sorts.
- Relation/backlink index.
- Mention index.
- Permission-filterable search index keyed by workspace/resource ACL scope.
- View query cache for expensive views.

### Inference: Migration strategy is part of the data model

Notion's data model evolved from databases to database/data source split in the public API (<https://developers.notion.com/guides/get-started/upgrade-guide-2025-09-03>). The model also tolerates unsupported block types (<https://developers.notion.com/reference/block>) and additive API fields (<https://developers.notion.com/reference/versioning>). A clone should version:

- Block payload schemas.
- Property schema definitions.
- Formula language versions.
- View configuration versions.
- API representations.
- Background migrations and backfills.

## Clone schema implications

### Suggested conceptual schema

This is not a claim about Notion's exact schema. It is a clone-oriented schema inspired by confirmed and inferred patterns.

#### Core identity and hierarchy

```text
workspaces(
  id uuid primary key,
  name text,
  settings_json jsonb,
  created_at timestamptz
)

teamspaces(
  id uuid primary key,
  workspace_id uuid references workspaces,
  name text,
  description text,
  access_mode text,             -- open/closed/private
  is_default boolean,
  archived_at timestamptz null,
  settings_json jsonb
)

blocks(
  id uuid primary key,
  workspace_id uuid references workspaces,
  type text not null,
  parent_id uuid null,
  parent_kind text not null,     -- workspace/teamspace/page/block/data_source/database
  properties jsonb not null default '{}',
  created_by uuid,
  created_at timestamptz,
  last_edited_by uuid,
  last_edited_at timestamptz,
  version bigint not null,
  in_trash boolean not null default false
)

block_children(
  parent_block_id uuid,
  child_block_id uuid unique,
  position_key text,
  created_at timestamptz,
  primary key(parent_block_id, child_block_id)
)
```

Notes:

- If pages are block records, `pages` can be metadata over `blocks.id` rather than separate identity.
- `position_key` can be fractional indexing, lexicographic rank, or integer with rebalancing. An array field can be cached for fast reads.
- Keep `parent_id` separate from `block_children` to preserve the permission parent/render-child distinction.

#### Pages and page metadata

```text
pages(
  id uuid primary key references blocks(id),
  workspace_id uuid,
  data_source_id uuid null,
  title_plain text,
  icon_json jsonb,
  cover_file_id uuid null,
  public_url text null,
  is_locked boolean default false
)
```

`title_plain` is denormalized from rich text/title property for search, URLs, breadcrumbs, and fast sidebar rendering.

#### Databases, data sources, schemas, and values

```text
databases(
  id uuid primary key,
  workspace_id uuid,
  parent_id uuid,
  parent_kind text,
  title_json jsonb,
  description_json jsonb,
  icon_json jsonb,
  cover_file_id uuid null,
  is_inline boolean,
  in_trash boolean default false
)

data_sources(
  id uuid primary key,
  database_id uuid references databases(id),
  workspace_id uuid,
  title_json jsonb,
  description_json jsonb,
  icon_json jsonb,
  schema_version bigint,
  in_trash boolean default false
)

property_defs(
  id text,
  data_source_id uuid references data_sources(id),
  name text,
  description text,
  type text,
  config_json jsonb,
  position_key text,
  in_trash boolean default false,
  primary key(data_source_id, id)
)

page_property_values(
  page_id uuid references pages(id),
  property_id text,
  data_source_id uuid,
  type text,
  value_json jsonb,
  scalar_text text null,
  scalar_number numeric null,
  scalar_date timestamptz null,
  scalar_bool boolean null,
  updated_at timestamptz,
  primary key(page_id, property_id)
)
```

Tradeoffs:

- `value_json` preserves all property types and unknown future types.
- Scalar columns make filters/sorts feasible.
- For arrays (multi-select, people, files, relation), add child tables for indexing.
- For formula/rollup, store computed cache separately and mark stale on dependency changes.

#### Views and view queries

```text
views(
  id uuid primary key,
  database_id uuid references databases(id),
  data_source_id uuid references data_sources(id) null,
  name text,
  type text,
  filter_json jsonb,
  sorts_json jsonb,
  quick_filters_json jsonb,
  configuration_json jsonb,
  position_key text,
  created_by uuid,
  created_at timestamptz,
  last_edited_by uuid,
  last_edited_at timestamptz
)
```

Store grouping inside `configuration_json` if view-type-specific, but normalize enough to validate referenced property IDs on schema changes.

#### Relations, formulas, and rollups

```text
relation_edges(
  relation_property_id text,
  from_page_id uuid,
  to_page_id uuid,
  target_data_source_id uuid,
  position_key text,
  primary key(relation_property_id, from_page_id, to_page_id)
)

computed_property_cache(
  page_id uuid,
  property_id text,
  value_json jsonb,
  value_type text,
  stale boolean,
  computed_at timestamptz,
  primary key(page_id, property_id)
)

property_dependencies(
  property_id text,
  data_source_id uuid,
  depends_on_property_id text,
  depends_on_data_source_id uuid,
  dependency_kind text,          -- formula/rollup/relation
  primary key(property_id, data_source_id, depends_on_property_id, depends_on_data_source_id)
)
```

#### Comments, mentions, and files

```text
discussions(
  id uuid primary key,
  workspace_id uuid,
  anchor_resource_id uuid,
  anchor_resource_kind text,      -- page/block/rich_text_range/etc.
  resolved_at timestamptz null
)

comments(
  id uuid primary key,
  discussion_id uuid references discussions(id),
  parent_id uuid,
  parent_kind text,
  author_id uuid,
  rich_text_json jsonb,
  created_at timestamptz,
  last_edited_at timestamptz,
  deleted_at timestamptz null
)

mentions(
  source_block_id uuid,
  source_property_id text null,
  target_id uuid,
  target_kind text,
  position_json jsonb,
  primary key(source_block_id, target_id, target_kind, position_json)
)

files(
  id uuid primary key,
  workspace_id uuid,
  storage_kind text,              -- hosted/external/uploading
  name text,
  mime_type text,
  size_bytes bigint,
  external_url text null,
  storage_key text null,
  created_by uuid,
  created_at timestamptz
)
```

### Design tradeoffs for a clone

#### Array children vs edge table

- **Array children** mirrors Notion's confirmed internal `content` field and is very fast to render a page chunk once loaded.
- **Edge table** is easier to index, paginate, insert/reorder concurrently, and enforce uniqueness.
- **Recommendation**: use an edge table as the canonical store for clones unless you are building a local-only prototype; optionally maintain a denormalized array/cache for hot pages.

#### JSON payloads vs normalized per-type tables

- **JSON payloads** support rapid addition of block/property types and preserve unknown fields.
- **Normalized tables** enable validation, analytics, and indexes.
- **Recommendation**: use JSON as the canonical payload for block type-specific data and dynamic property values, with targeted normalized/index columns for common query paths.

#### Computed values on read vs cached

- **On-read formulas/rollups** are simple but slow for large views and hard to sort/filter.
- **Cached computed values** require invalidation but enable usable database views.
- **Recommendation**: start with on-read for MVP, but design a dependency graph and cache table from day one.

#### Permission checks by tree walk vs closure/cache

- **Tree walk** is simpler and faithful to parent pointers.
- **Closure/access cache** is faster for search, list views, and API calls.
- **Recommendation**: keep canonical parent pointers and direct grants, then add cached ancestor/access tables with invalidation on moves/shares.

#### Database pages as blocks vs separate row records

- **Pages as blocks** gives one content model for docs and database rows, matching Notion's core idea.
- **Separate rows** may simplify table implementations but duplicates page/document features.
- **Recommendation**: make database rows pages/blocks with property values. This is the Notion-like path and supports opening any row as a full page with children.

### Pitfalls to avoid

1. **Treating a page as a single document blob.** This breaks granular moves, block-level comments, sync, permissions, and realtime updates.
2. **Using mutable property names as identifiers.** Notion uses stable property IDs because names change (<https://developers.notion.com/reference/page-property-values>).
3. **Ignoring order as data.** Indentation and block movement mutate structure, not just style (<https://www.notion.com/blog/data-model-behind-notion>).
4. **Deriving permissions from child arrays.** Notion explicitly explains why this is unsafe/inefficient (<https://www.notion.com/blog/data-model-behind-notion>).
5. **Embedding relation values only in JSON.** Relations need reverse lookup, rollups, backlinks, and permission-aware search.
6. **Making formulas a display-only feature.** Users expect filtering/sorting/rollups over computed values; this requires typed outputs and caches.
7. **Assuming database equals table.** Current Notion separates database container, data source, view, and page rows (<https://developers.notion.com/reference/database>, <https://developers.notion.com/reference/data-source>, <https://developers.notion.com/reference/view>).
8. **Assuming public API support equals product support.** `unsupported` blocks prove internal types can exist before API support (<https://developers.notion.com/reference/block>).
9. **Not planning for API/model migrations.** The 2025 data source migration shows major conceptual refactors happen (<https://developers.notion.com/guides/get-started/upgrade-guide-2025-09-03>).
10. **Underestimating search/indexing.** Notion separately schedules Quick Find indexing after transactions, and public search has indexing delays (<https://www.notion.com/blog/data-model-behind-notion>, <https://developers.notion.com/reference/search-optimizations-and-limitations>).
11. **Ignoring permission-aware rendering of mentions/synced blocks/files.** Mentions can be redacted when access is missing; synced blocks require original access; hosted file URLs expire (<https://developers.notion.com/reference/rich-text>, <https://www.notion.com/help/synced-blocks>, <https://developers.notion.com/reference/file-object>).
12. **Trying to make every edit synchronous.** Notion uses async template application, background indexing, WebSocket notifications, and sync fetches (<https://developers.notion.com/guides/data-apis/creating-pages-from-templates>, <https://www.notion.com/blog/data-model-behind-notion>).

### Suggested implementation stages for a clone

1. **Block tree MVP**
   - Blocks with UUIDs, type, JSON payload, parent pointer, ordered children.
   - Page as a block type with title/icon/cover metadata.
   - Basic editor operations as transactions: create block, update payload, move block, delete/trash.

2. **Structured properties/data sources**
   - Data source schema with stable property IDs.
   - Page property values with typed scalar indexes.
   - Table/list views with basic filters/sorts.

3. **Realtime and local cache**
   - Per-record versions.
   - Operation queue and optimistic UI.
   - WebSocket notifications by record/page subscription.
   - Background page chunk loading.

4. **Advanced database features**
   - Multiple views, group/subgroup config.
   - Relations with edge table.
   - Formula parser/evaluator and computed cache.
   - Rollups with dependency graph.

5. **Collaboration and permissions**
   - Workspace/teamspace membership.
   - Page/database shares, inherited ACLs, public links.
   - Comments/discussions and mentions.
   - Permission-aware search and redaction.

6. **Operational maturity**
   - Search indexing pipeline.
   - File upload/signed URL service.
   - Version history/snapshots.
   - Schema migrations and API versioning.

## Gaps and open questions

Public sources leave these important details unknown:

1. **Source-of-truth database technology.** The blog says Notion commits to source-of-truth databases, but does not identify the database engine or table layout (<https://www.notion.com/blog/data-model-behind-notion>).
2. **Exact operation schema.** `/saveTransactions` is mentioned, but operation types, conflict resolution, idempotency, and retry semantics are not public (<https://www.notion.com/blog/data-model-behind-notion>).
3. **Ordering algorithm.** The blog confirms ordered content arrays; public sources do not reveal whether Notion uses arrays only, fractional indices, CRDT sequences, or other ordering aids internally.
4. **Concurrency model details.** Notion describes optimistic local application and server validation, but not how simultaneous edits to the same block/property/content array are merged or rejected.
5. **Permission cache/inheritance implementation.** Parent pointers are confirmed, but ACL tables, group expansion, broadest-access computation, teamspace roots, and page-level access internals are not public.
6. **Formula language engine internals.** Public help documents syntax and API stores expressions/results, but parser, type checker, dependency invalidation, and cycle handling are not described (<https://www.notion.com/help/formulas>, <https://developers.notion.com/reference/property-object>).
7. **Rollup execution strategy.** It is unknown which rollups are cached, recomputed, partially indexed, or evaluated at query time.
8. **Search/index architecture.** Quick Find indexing is confirmed, and API search limitations are documented, but indexing technology and permission filtering implementation are not public (<https://www.notion.com/blog/data-model-behind-notion>, <https://developers.notion.com/reference/search-optimizations-and-limitations>).
9. **Full internal block catalog.** The public API has `unsupported` blocks, so it is incomplete by definition (<https://developers.notion.com/reference/block>).
10. **Teamspace API model.** Help documentation describes teamspaces, but public parent objects currently represent team-level pages as workspace-parented (<https://developers.notion.com/reference/parent-object>, <https://www.notion.com/help/intro-to-teamspaces>).
11. **Comment anchors.** API comments expose discussions and parents, but not full internal anchoring for inline text ranges or resolved comments (<https://developers.notion.com/guides/data-apis/working-with-comments>).
12. **Template merge details.** Template pages and asynchronous application are documented, but exact merge precedence for conflicting properties/children and large-template task internals are not public (<https://developers.notion.com/guides/data-apis/creating-pages-from-templates>).

## Final takeaways for clone design

- Start with a **block record graph**, not documents.
- Keep **stable UUIDs** and **stable property IDs** everywhere.
- Store **typed payloads flexibly** so block/property types can evolve without destructive migrations.
- Separate **render children** from **permission parent**.
- Treat **database**, **data source**, **view**, and **page row** as distinct concepts.
- Build indexes for property queries, relations, computed values, mentions, search, and permissions from the beginning, even if they are initially simple.
- Make migrations and unknown/unsupported types first-class concerns; Notion's public API evolution shows the model will change.
