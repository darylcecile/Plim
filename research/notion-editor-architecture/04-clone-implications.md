# Notion Editor Architecture: Clone Implications

## Scope

This document synthesizes public information about Notion's editor, block model, databases, API, offline/sync behavior, sharing, comments, and search, then turns it into an actionable architecture proposal for building a Notion-like clone. It is intentionally implementation-oriented: block schema, page/database/data-source model, query model, editor transactions, command and markdown rules, keyboard/selection behavior, drag/drop ordering, renderer/editor split, permissions, comments, collaboration, search, offline latency, migrations, and public API design.

Evidence labels:

- **Confirmed** means Notion has stated the behavior or shape in public engineering posts, help docs, or API docs.
- **Inferred** means the architecture is a reasonable interpretation of confirmed behavior, but Notion has not published the internal implementation details.
- **Recommended for clone** means a concrete design choice for our implementation, not a claim about Notion internals.

Primary public sources include Notion's block data model engineering post, which states that everything in Notion is a block and describes IDs, properties, type, content pointers, parent pointers, transactions, RecordCache, TransactionQueue, `/saveTransactions`, MessageStore WebSocket updates, `syncRecordValues`, and `loadPageChunk` ([Notion data model](https://www.notion.com/blog/data-model-behind-notion)); official API docs for blocks, pages, databases, data sources, rich text, properties, comments, search, webhooks, request limits, and versioning ([block object](https://developers.notion.com/reference/block), [page object](https://developers.notion.com/reference/page), [database object](https://developers.notion.com/reference/database), [data source object](https://developers.notion.com/reference/data-source)); help docs for blocks, keyboard/markdown/slash commands, databases, data sources, relations/rollups, formulas, sharing, comments, synced blocks, public publishing, and search ([what is a block](https://www.notion.com/help/what-is-a-block), [keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts), [data sources](https://www.notion.com/help/data-sources-and-linked-databases), [relations and rollups](https://www.notion.com/help/relations-and-rollups), [formulas](https://www.notion.com/help/formulas), [sharing and permissions](https://www.notion.com/help/sharing-and-permissions), [comments](https://www.notion.com/help/comments-mentions-and-reminders), [search](https://www.notion.com/help/search)); and infrastructure posts about offline mode, local SQLite, sharding, and data-lake/search/AI scale ([offline mode](https://www.notion.com/blog/how-we-made-notion-available-offline), [faster page load navigation](https://www.notion.com/blog/faster-page-load-navigation), [sharding Postgres](https://www.notion.com/blog/sharding-postgres-at-notion), [data lake](https://www.notion.com/blog/building-and-scaling-notions-data-lake)).

---

## Confirmed public facts that should shape a clone

### Blocks, render tree, and transactions

- **Confirmed:** Notion models text, images, lists, database rows, and pages as blocks; blocks use randomly generated UUID v4 IDs; each block has `properties`, `type`, `content` (ordered child block IDs), and `parent` (upward pointer used for permissions) ([Notion data model](https://www.notion.com/blog/data-model-behind-notion)).
- **Confirmed:** The block `type` controls rendering and interpretation of properties. Changing the type does not erase properties/content; unused properties can be ignored and later reused if the block is turned back into a type that understands them ([Notion data model](https://www.notion.com/blog/data-model-behind-notion)).
- **Confirmed:** The `content` attribute defines the render tree and order of render children; different block types render children differently. Lists render children indented, toggles hide/show children, and page blocks render children on a separate page ([Notion data model](https://www.notion.com/blog/data-model-behind-notion)).
- **Confirmed:** Indentation is structural, not only visual. Indenting tries to move the selected block into the preceding sibling's content array ([Notion data model](https://www.notion.com/blog/data-model-behind-notion)).
- **Confirmed:** User actions such as typing, creating blocks, and dragging blocks are represented as operations that create or update records. Operations are batched into transactions that are committed or rejected as a group ([Notion data model](https://www.notion.com/blog/data-model-behind-notion)).
- **Confirmed:** The client applies transactions optimistically to local state in milliseconds, writes local copies into RecordCache, persists transactions in TransactionQueue, serializes them to JSON, and posts to `/saveTransactions` ([Notion data model](https://www.notion.com/blog/data-model-behind-notion)).
- **Confirmed:** On the server, Notion loads relevant records, creates before/after data, validates permissions/coherency, commits changed records, schedules version history and Quick Find indexing, and notifies MessageStore for real-time updates ([Notion data model](https://www.notion.com/blog/data-model-behind-notion)).

### Public API object model

- **Confirmed:** The public block object has `object: "block"`, `id`, `parent`, `type`, created/edited metadata, `in_trash`, `has_children`, and a type-specific object keyed by the block type. Supported child-capable block types include paragraph, list items, callout, child page, child database, columns, toggle headings, quote, synced block, table, template, to-do, and toggle ([block object](https://developers.notion.com/reference/block)).
- **Confirmed:** The public page object has `object: "page"`, `id`, created/edited metadata, icon, cover, parent, `in_trash`, `properties`, `url`, and `public_url` ([page object](https://developers.notion.com/reference/page)).
- **Confirmed:** In the current API model, a database contains one or more data sources. A database may be inline or full-page; data source schemas and rows are managed through data sources; permissions for data-source children are managed through databases because individual data sources do not have independent permissions settings ([database object](https://developers.notion.com/reference/database), [data source object](https://developers.notion.com/reference/data-source)).
- **Confirmed:** Data sources are tables of data under a database. Pages are items/children in a data source, and page property values must conform to property objects in the parent data source schema ([data source object](https://developers.notion.com/reference/data-source)).
- **Confirmed:** Querying a data source returns pages filtered and sorted by property filters/sorts. Compound `and`/`or` filters map to UI filters; nested sorts have precedence order; query results are paginated and capped at 10,000 results per query in the public API ([query data source](https://developers.notion.com/reference/query-a-data-source), [filter data source entries](https://developers.notion.com/reference/filter-data-source-entries), [sort data source entries](https://developers.notion.com/reference/sort-data-source-entries)).
- **Confirmed:** Rich text objects represent block text and contain `type` (`text`, `mention`, or `equation`), `annotations`, `plain_text`, `href`, and type-specific payloads. Annotations include bold, italic, strikethrough, underline, code, and color ([rich text](https://developers.notion.com/reference/rich-text)).
- **Confirmed:** API versions are date-named and selected with a required `Notion-Version` header. Backward-compatible changes include additive response fields, opaque cursor changes, error-message wording, rate-limit changes, and performance/ordering improvements ([versioning](https://developers.notion.com/reference/versioning)).

### Databases, views, properties, formulas, relations, rollups

- **Confirmed:** Notion help describes databases as containers of pages. Each row in a table is a page, and each database is also a page that can be moved/nested like other pages ([what is a database](https://www.notion.com/help/what-is-a-database)).
- **Confirmed:** Database content can be visualized as table, list, board, calendar, gallery, timeline, chart, and forms; view settings include layout, property visibility, filter, sort, group, sub-group, and page-open mode. Each view has independent settings ([views, filters, and sorts](https://www.notion.com/help/views-filters-and-sorts)).
- **Confirmed:** A database can have multiple data sources; linked data sources respect access from their original database; linked views can have independent views/filters/sorts/groups while edits to titles, properties, or pages update the original source ([data sources and linked databases](https://www.notion.com/help/data-sources-and-linked-databases)).
- **Confirmed:** Property types include text/rich text, number, select, status, multi-select, date, formula, relation, rollup, person, file, checkbox, URL, email, phone, created/edited metadata, button, ID, and place in the UI; the API property schema includes many corresponding typed objects ([database properties](https://www.notion.com/help/database-properties), [property object](https://developers.notion.com/reference/property-object)).
- **Confirmed:** Relations link pages in another data source; two-way relations create a corresponding relation in the destination and edits work both ways. Rollups aggregate through a relation over a selected property using functions such as sum, average, min, max, count, show original, show unique, earliest/latest date, etc. ([relations and rollups](https://www.notion.com/help/relations-and-rollups), [property object](https://developers.notion.com/reference/property-object)).
- **Confirmed:** Formula properties store an expression and evaluate to typed results. Public docs show formulas can reference properties, built-ins, functions, list operations, page IDs, relation lists, and rollups; common errors document a 15-layer depth limit for formulas that reference other formulas or rollups ([formulas](https://www.notion.com/help/formulas), [formula syntax](https://www.notion.com/help/formula-syntax), [common formula errors](https://www.notion.com/help/common-formula-errors), [property object](https://developers.notion.com/reference/property-object)).

### UX and editor controls

- **Confirmed:** Notion's help docs present “everything is a block”, `/` opens block creation, and block handles can turn blocks into other types or drag/drop them ([what is a block](https://www.notion.com/help/what-is-a-block), [block basics](https://www.notion.com/help/guides/block-basics-build-the-foundation-for-your-teams-pages)).
- **Confirmed:** The keyboard docs include markdown input rules: `*`, `-`, or `+` + space for bullet; `[]` + space for to-do; `1.`, `a.`, or `i.` + space for numbered list; `#`, `##`, `###` + space for headings; `>` + space for toggle; `"` + space for quote; `---` for divider; inline `**`, `*`, backticks, and `~` for marks ([keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)).
- **Confirmed:** `/turn`, `/color`, slash commands for block insertion, `@` mentions, `[[` page linking/creation, `+` page creation/linking, and many block-specific slash aliases are documented ([keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)).
- **Confirmed:** Block selection behavior is explicitly documented: `esc` selects the current block, `cmd/ctrl+a` once selects the cursor block, arrow keys move block selection, shift+arrows extend selection, shift+click range-selects blocks, delete removes selected blocks, `cmd/ctrl+d` duplicates, `cmd/ctrl+/` edits selected blocks, and `cmd/ctrl+shift+arrow` moves selected blocks ([keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)).
- **Confirmed:** Notion page rendering uses adjacency-based rules for spacing: pages are generally vertical stacks, and list-like neighbors get reduced padding so lists remain compact while paragraphs can have breathing room ([updating page design](https://www.notion.com/blog/updating-the-design-of-notion-pages)).

### Permissions, comments, sync, offline, search, infrastructure

- **Confirmed:** Notion block permissions use upward `parent` pointers because content arrays could historically reference blocks in multiple places and because ancestor traversal through content arrays would be inefficient/ambiguous for permissions ([Notion data model](https://www.notion.com/blog/data-model-behind-notion)).
- **Confirmed:** Sharing supports people/groups/teamspaces, guests, general access (`Only people invited`, workspace-wide, anyone with link), public publishing, access levels (`Full access`, `Can edit`, database-only `Can edit content`, `Can comment`, `Can view`), page-level access rules driven by person/created-by properties, inheritance for subpages, and broadest-access-wins semantics ([sharing and permissions](https://www.notion.com/help/sharing-and-permissions), [public publishing](https://www.notion.com/help/public-pages-and-web-publishing)).
- **Confirmed:** Comments include top-level page discussions, inline text/block comments, database page comments, and database property comments, with resolve/reopen/edit/delete flows and a comments pane ([comments, mentions, reminders](https://www.notion.com/help/comments-mentions-and-reminders), [comment object](https://developers.notion.com/reference/comment-object), [create comment](https://developers.notion.com/reference/create-a-comment)).
- **Confirmed:** Notion clients maintain long-lived WebSocket connections to MessageStore, subscribe to records being rendered, receive version notifications, compare local versions, then request current record values via `syncRecordValues` ([Notion data model](https://www.notion.com/blog/data-model-behind-notion)).
- **Confirmed:** Page loading uses `loadPageChunk`, descending from a page/block into the content tree and returning blocks plus dependent records needed to render; Notion lays out and renders pages using React ([Notion data model](https://www.notion.com/blog/data-model-behind-notion)).
- **Confirmed:** Notion's desktop/native apps use SQLite for client-side storage; the performance post says SQLite made initial page loads and page navigation 50% faster for most users, replacing IndexedDB as the desktop storage layer due to quotas/bugs/performance concerns ([faster page load navigation](https://www.notion.com/blog/faster-page-load-navigation)).
- **Confirmed:** Offline mode required pages to be fully available and dynamically migrated to a new CRDT data model for conflict resolution; Notion stores why pages are offline using `offline_page` and `offline_action`, subscribes to page update channels, tracks `lastDownloadedTimestamp`, and reconciles offline trees as pages/databases move or rows/views change ([offline mode](https://www.notion.com/blog/how-we-made-notion-available-offline)).
- **Confirmed:** Quick Find indexing happens asynchronously after transactions, and public search docs note indexing delays and that API search is best for pages/databases by name, not exhaustive enumeration or database filtering ([Notion data model](https://www.notion.com/blog/data-model-behind-notion), [search API optimizations](https://developers.notion.com/reference/search-optimizations-and-limitations), [search help](https://www.notion.com/help/search)).
- **Confirmed:** At scale, Notion sharded Postgres by workspace ID; all blocks belong to exactly one workspace, and related sharded tables include blocks, comments/discussions/collections reachable from block relationships. Public posts describe 480 logical shards, 32 then 96 physical DBs, and later data lake ingestion for update-heavy block data ([sharding Postgres](https://www.notion.com/blog/sharding-postgres-at-notion), [great re-shard](https://www.notion.com/blog/the-great-re-shard), [data lake](https://www.notion.com/blog/building-and-scaling-notions-data-lake)).

---

## Proposed clone architecture

### Architectural principles

1. **One universal content primitive:** Use `Block` as the single persisted primitive for pages, paragraphs, headings, list items, media, embeds, tables, database containers, synced blocks, and rows. This is directly motivated by Notion's confirmed “everything is a block” model ([Notion data model](https://www.notion.com/blog/data-model-behind-notion)).
2. **Separate render containment from permission ancestry:** Keep a render edge/order model and a permission parent. Notion explicitly distinguishes downward `content` pointers from upward `parent` pointers for permissions ([Notion data model](https://www.notion.com/blog/data-model-behind-notion)). For a clone, this prevents ACL ambiguity when blocks are embedded, synced, linked, or transcluded.
3. **Optimistic local-first editing with server validation:** Apply operations immediately in a local store; queue transactions durably; server validates before/after permissions and invariants; broadcast version notifications; clients fetch changed records. This mirrors the public transaction/MessageStore flow but can be implemented with our own protocol ([Notion data model](https://www.notion.com/blog/data-model-behind-notion)).
4. **Typed properties over generic pages:** Database rows are pages with structured properties. Schemas live on data sources; values live on pages/entries. This is confirmed in the API ([data source object](https://developers.notion.com/reference/data-source), [page property values](https://developers.notion.com/reference/page-property-values)).
5. **Renderer/editor split:** A read-only renderer should understand block JSON and database views without editor state. The editor wraps renderer components with selection, local transactions, command menus, drag/drop, collaboration cursors, and input rules. This is a clone recommendation; Notion confirms React rendering, not its internal component architecture ([Notion data model](https://www.notion.com/blog/data-model-behind-notion)).
6. **Public API is not the sync API:** Expose stable REST/GraphQL objects resembling blocks/pages/data sources/comments/webhooks. Keep internal CRDT/op-log protocol separate so public API consumers are insulated from collaboration internals. Notion's public API is object/REST/version-header based while its internal editor uses transactions and record sync ([versioning](https://developers.notion.com/reference/versioning), [Notion data model](https://www.notion.com/blog/data-model-behind-notion)).

### High-level services

```text
Client app
  ├─ Block renderer (read-only components)
  ├─ Editor controller (selection, input rules, slash menu, commands)
  ├─ Local store (SQLite on desktop/mobile; IndexedDB fallback on web)
  ├─ Durable transaction queue
  ├─ Realtime subscriber (WebSocket/SSE)
  └─ Offline manager (available pages, dependency tracking, CRDT snapshots)

Backend
  ├─ Transaction API: validate/apply batched operations
  ├─ Read API: load page chunks, block children, data-source query
  ├─ Realtime gateway: subscriptions and version notifications
  ├─ Search/index pipeline: blocks, page titles, properties, comments optional
  ├─ Permission service: inherited ACL and materialized access paths
  ├─ Database/query service: views, filters, sorts, rollups, formulas
  ├─ Comment/discussion service
  ├─ Public API + OAuth/integrations + webhooks
  └─ Migration/versioning service

Storage
  ├─ OLTP DB partitioned by workspace_id
  ├─ Object/file store for uploads
  ├─ Search index (ACL-aware)
  ├─ Event log / outbox for realtime, indexing, webhooks
  └─ Optional analytics/data lake for denormalized/search/AI workloads
```

### Recommended implementation sequence

1. **MVP:** blocks, pages, page loading, block CRUD, local optimistic queue, simple server transactions, slash commands, markdown input rules, keyboard selection, drag/drop order keys, basic ACL, comments, and search by title/content.
2. **Database MVP:** data sources, schemas, rows as pages, table/list/board views, filters/sorts, property values, relations as page references, rollups with limited functions, formulas with a small expression evaluator.
3. **Collaboration:** WebSocket record subscriptions, transaction conflict detection, presence cursors, per-record versions, idempotency keys, undo/redo, durable outbox.
4. **Offline/local-first:** SQLite/IndexedDB record cache, offline page dependency graph, CRDT rich text, CRDT/list ordering for block children or conflict-aware move ops, reconnect reconciliation.
5. **Scale:** workspace partitioning, materialized permission closure, async indexing, CDC/outbox, webhooks, API versioning, backfill/double-write migration patterns.

---

## Data model proposal

### Conceptual OLTP tables/documents

The model below is relational, but the same shapes can be stored as documents. For Postgres, use `jsonb` for type-specific payloads and maintain queryable side tables for properties, relations, permissions, and search.

#### Workspaces and identities

```sql
workspace(id uuid primary key, name text, created_at timestamptz, plan text)
user_account(id uuid primary key, email text unique, name text, avatar_url text)
workspace_member(workspace_id uuid, user_id uuid, role text, status text,
                 primary key(workspace_id, user_id))
group(id uuid primary key, workspace_id uuid, name text)
group_member(group_id uuid, user_id uuid, primary key(group_id, user_id))
```

#### Blocks and render edges

Recommended core block table:

```sql
block(
  id uuid primary key,
  workspace_id uuid not null,
  type text not null,
  properties jsonb not null default '{}',
  permission_parent_id uuid null,
  created_by uuid not null,
  created_at timestamptz not null,
  last_edited_by uuid not null,
  last_edited_at timestamptz not null,
  version bigint not null default 0,
  archived boolean not null default false,
  in_trash boolean not null default false,
  schema_version int not null default 1
)

block_child_edge(
  parent_block_id uuid not null,
  child_block_id uuid not null,
  workspace_id uuid not null,
  order_key text not null,
  edge_kind text not null default 'render',
  created_at timestamptz not null,
  primary key(parent_block_id, child_block_id, edge_kind),
  unique(parent_block_id, edge_kind, order_key),
  unique(child_block_id, edge_kind) -- optional if only one render parent is allowed
)
```

**Confirmed basis:** Notion stores downward content pointers as an ordered array of block IDs and upward parent pointers for permissions ([Notion data model](https://www.notion.com/blog/data-model-behind-notion)). **Recommended for clone:** Store child order in `block_child_edge.order_key` rather than mutating a large parent `content` array on every move. Expose an API shape with `children`/`content` arrays to match the mental model.

Why edge table plus `permission_parent_id`?

- Efficient ordered pagination: `where parent_block_id = ? order by order_key limit 100`.
- Move can update one edge row plus permission parent changes for moved subtree if needed.
- Synced/transcluded blocks can use `edge_kind = 'embed' | 'sync_instance'` without changing permission ancestry.
- Permission service can materialize ancestry from `permission_parent_id`, not discover parents by reverse-scanning child arrays.

#### Pages

Pages are blocks, but an auxiliary table improves routing and indexing.

```sql
page(
  id uuid primary key references block(id),
  workspace_id uuid not null,
  title_plain text,
  icon jsonb,
  cover jsonb,
  parent_kind text not null, -- page | data_source | workspace | database
  parent_id uuid null,
  public_url text null,
  is_locked boolean not null default false,
  last_opened_at timestamptz null
)
```

**Confirmed basis:** Notion pages are blocks in the engineering post; the API exposes page-specific icon, cover, parent, properties, URL, and public URL ([Notion data model](https://www.notion.com/blog/data-model-behind-notion), [page object](https://developers.notion.com/reference/page)). **Recommended for clone:** Keep page metadata denormalized for fast navigation, search, and URL resolution while preserving `block` as source of truth.

#### Databases, data sources, views

```sql
database(
  id uuid primary key references block(id),
  workspace_id uuid not null,
  title jsonb not null,
  description jsonb not null default '[]',
  is_inline boolean not null default false,
  icon jsonb,
  cover jsonb
)

data_source(
  id uuid primary key,
  database_id uuid not null references database(id),
  workspace_id uuid not null,
  name text not null,
  title jsonb not null default '[]',
  description jsonb not null default '[]',
  archived boolean not null default false,
  version bigint not null default 0
)

data_source_property(
  id text not null, -- stable short id or uuid; title property may be 'title'
  data_source_id uuid not null,
  name text not null,
  type text not null,
  config jsonb not null default '{}',
  position_key text not null,
  archived boolean not null default false,
  primary key(data_source_id, id),
  unique(data_source_id, name)
)

data_source_entry(
  data_source_id uuid not null,
  page_id uuid not null references page(id),
  workspace_id uuid not null,
  order_key text null, -- default/manual table order if no sort
  created_at timestamptz not null,
  primary key(data_source_id, page_id)
)

data_source_view(
  id uuid primary key,
  database_id uuid not null,
  data_source_id uuid null, -- null can mean multi-source view
  workspace_id uuid not null,
  name text not null,
  layout text not null, -- table | board | list | calendar | gallery | timeline | chart | form
  filters jsonb not null default '{}',
  sorts jsonb not null default '[]',
  groups jsonb not null default '[]',
  property_visibility jsonb not null default '{}',
  open_pages_in text not null default 'side_peek',
  local_to_user_id uuid null -- null shared, non-null private/personal view preference
)
```

**Confirmed basis:** A database contains data sources, data source schemas are independent, pages are data-source items, and views have independent settings for layout, property visibility, filter, sort, group, and page-open behavior ([database object](https://developers.notion.com/reference/database), [data source object](https://developers.notion.com/reference/data-source), [views, filters, and sorts](https://www.notion.com/help/views-filters-and-sorts)).

#### Page property values

```sql
page_property_value(
  page_id uuid not null,
  data_source_id uuid not null,
  property_id text not null,
  workspace_id uuid not null,
  type text not null,
  value jsonb not null,
  version bigint not null default 0,
  primary key(page_id, data_source_id, property_id)
)
```

For performance, maintain typed indexes or side tables:

```sql
property_value_text(page_id uuid, property_id text, value text, tsv tsvector)
property_value_number(page_id uuid, property_id text, value numeric)
property_value_date(page_id uuid, property_id text, start_at timestamptz, end_at timestamptz)
property_value_select(page_id uuid, property_id text, option_id text)
property_value_people(page_id uuid, property_id text, user_id uuid)
property_value_relation(page_id uuid, property_id text, related_page_id uuid, position_key text)
```

**Confirmed basis:** Page property values have stable property IDs, type-discriminated values, and formula/rollup/relation pagination behaviors ([page property values](https://developers.notion.com/reference/page-property-values)). **Recommended for clone:** Use the JSON table as write model and side tables as read/query/index model.

#### Comments and discussions

```sql
discussion(
  id uuid primary key,
  workspace_id uuid not null,
  parent_kind text not null, -- page | block | property | text_range
  parent_id uuid not null,
  property_id text null,
  anchor jsonb null, -- rich-text range, block id, property id, resolved text quote
  status text not null default 'open', -- open | resolved
  created_by uuid not null,
  created_at timestamptz not null
)

comment(
  id uuid primary key,
  discussion_id uuid not null,
  workspace_id uuid not null,
  rich_text jsonb not null,
  attachments jsonb not null default '[]',
  display_name jsonb null,
  created_by uuid not null,
  created_at timestamptz not null,
  last_edited_at timestamptz not null,
  deleted_at timestamptz null
)
```

**Confirmed basis:** Notion supports page, block, and discussion comments in the API, and UI comments can attach to pages, text ranges, blocks, database pages, and database properties ([create comment](https://developers.notion.com/reference/create-a-comment), [comments](https://www.notion.com/help/comments-mentions-and-reminders), [database properties](https://www.notion.com/help/database-properties)).

#### Permissions

```sql
acl_grant(
  id uuid primary key,
  workspace_id uuid not null,
  resource_kind text not null, -- workspace | teamspace | page | database | data_source | block
  resource_id uuid not null,
  subject_kind text not null, -- user | group | workspace | public_link | web
  subject_id text not null,
  capability text not null, -- full_access | edit | edit_content | comment | view
  expires_at timestamptz null,
  created_by uuid not null,
  created_at timestamptz not null
)

page_level_access_rule(
  id uuid primary key,
  data_source_id uuid not null,
  property_id text not null, -- person or created_by property
  capability text not null,
  enabled boolean not null default true
)

permission_closure(
  workspace_id uuid not null,
  resource_id uuid not null,
  ancestor_id uuid not null,
  depth int not null,
  primary key(workspace_id, resource_id, ancestor_id)
)
```

**Confirmed basis:** Notion permissions inherit through parent pointers; sharing supports access levels and database page-level access from person/created-by properties; broadest access wins ([Notion data model](https://www.notion.com/blog/data-model-behind-notion), [sharing and permissions](https://www.notion.com/help/sharing-and-permissions)). **Recommended for clone:** Materialize a permission closure asynchronously for search/query and recompute on subtree moves.

#### Operation log and outbox

```sql
transaction(
  id uuid primary key,
  workspace_id uuid not null,
  actor_id uuid not null,
  client_id text not null,
  idempotency_key text not null,
  base_versions jsonb not null,
  operations jsonb not null,
  status text not null, -- accepted | rejected | partially_rebased
  created_at timestamptz not null,
  committed_at timestamptz null,
  unique(client_id, idempotency_key)
)

record_version(
  workspace_id uuid not null,
  record_kind text not null,
  record_id uuid not null,
  version bigint not null,
  updated_at timestamptz not null,
  primary key(record_kind, record_id)
)

outbox_event(
  id uuid primary key,
  workspace_id uuid not null,
  type text not null, -- record.updated | page.content_updated | index.block | webhook.page.updated
  entity_kind text not null,
  entity_id uuid not null,
  payload jsonb not null,
  created_at timestamptz not null,
  delivered_at timestamptz null
)
```

**Confirmed basis:** Notion batches operations into transactions, records versions, schedules indexing/version-history work, and notifies realtime services after successful commits ([Notion data model](https://www.notion.com/blog/data-model-behind-notion)).

### Block JSON examples

#### Paragraph block with rich text

```json
{
  "object": "block",
  "id": "8e7c9f1f-3dc9-4b7e-8ed5-f36c7c2a808a",
  "workspace_id": "6c71a2fe-27af-4424-a38b-d55fe2d8dabc",
  "type": "paragraph",
  "parent": { "type": "block_id", "block_id": "page-uuid" },
  "properties": {
    "title": [
      {
        "type": "text",
        "text": { "content": "Ship the first clone milestone", "link": null },
        "annotations": {
          "bold": false,
          "italic": false,
          "strikethrough": false,
          "underline": false,
          "code": false,
          "color": "default"
        },
        "plain_text": "Ship the first clone milestone",
        "href": null
      }
    ],
    "color": "default"
  },
  "content": [],
  "order_key": "hzzzzz"
}
```

This intentionally keeps a Notion-like `title` rich-text property because Notion says `title` is the common property for paragraphs/lists/page titles ([Notion data model](https://www.notion.com/blog/data-model-behind-notion)) and the API exposes rich-text arrays for text-bearing blocks ([block object](https://developers.notion.com/reference/block), [rich text](https://developers.notion.com/reference/rich-text)).

#### To-do block with preserved extra properties

```json
{
  "object": "block",
  "id": "b2d4cb3c-2d1f-4d36-9ffc-815fb76bdb84",
  "type": "to_do",
  "properties": {
    "title": [{ "type": "text", "text": { "content": "Write importer" }, "plain_text": "Write importer" }],
    "checked": false,
    "color": "default",
    "last_callout_icon": { "type": "emoji", "emoji": "💡" }
  },
  "content": ["6a74...child-note"],
  "order_key": "i00000"
}
```

**Recommended for clone:** Preserve unknown/unused properties through `turn_into` operations. This follows Notion's confirmed behavior that changing a block type does not destroy properties/content; the renderer may ignore unused properties until a type uses them again ([Notion data model](https://www.notion.com/blog/data-model-behind-notion)).

#### Page block / page metadata

```json
{
  "object": "page",
  "id": "f3ce1fb8-0a35-410a-bde3-969689e42b2b",
  "type": "page",
  "parent": { "type": "workspace", "workspace": true },
  "icon": { "type": "emoji", "emoji": "🧱" },
  "cover": null,
  "properties": {
    "title": [
      { "type": "text", "text": { "content": "Clone architecture" }, "plain_text": "Clone architecture" }
    ]
  },
  "content": ["8e7c9f1f-3dc9-4b7e-8ed5-f36c7c2a808a", "b2d4cb3c-2d1f-4d36-9ffc-815fb76bdb84"],
  "url": "https://app.example.com/Clone-architecture-f3ce1fb80a35410abde3969689e42b2b",
  "public_url": null
}
```

#### Database and data source

```json
{
  "object": "database",
  "id": "db-uuid",
  "title": [{ "type": "text", "text": { "content": "Projects" }, "plain_text": "Projects" }],
  "is_inline": true,
  "data_sources": [
    { "id": "ds-projects", "name": "Projects" },
    { "id": "ds-milestones", "name": "Milestones" }
  ]
}
```

```json
{
  "object": "data_source",
  "id": "ds-projects",
  "parent": { "type": "database_id", "database_id": "db-uuid" },
  "properties": {
    "Name": { "id": "title", "name": "Name", "type": "title", "title": {} },
    "Status": {
      "id": "stat",
      "name": "Status",
      "type": "status",
      "status": {
        "options": [
          { "id": "todo", "name": "Not started", "color": "default" },
          { "id": "doing", "name": "In progress", "color": "blue" },
          { "id": "done", "name": "Done", "color": "green" }
        ],
        "groups": [
          { "id": "grp1", "name": "To-do", "option_ids": ["todo"] },
          { "id": "grp2", "name": "In progress", "option_ids": ["doing"] },
          { "id": "grp3", "name": "Complete", "option_ids": ["done"] }
        ]
      }
    },
    "Tasks": {
      "id": "rel_tasks",
      "name": "Tasks",
      "type": "relation",
      "relation": {
        "data_source_id": "ds-tasks",
        "dual_property": {
          "synced_property_id": "rel_project",
          "synced_property_name": "Project"
        }
      }
    },
    "Open tasks": {
      "id": "roll_open_tasks",
      "name": "Open tasks",
      "type": "rollup",
      "rollup": {
        "relation_property_id": "rel_tasks",
        "relation_property_name": "Tasks",
        "rollup_property_id": "status",
        "rollup_property_name": "Status",
        "function": "count_values"
      }
    },
    "Health": {
      "id": "formula_health",
      "name": "Health",
      "type": "formula",
      "formula": {
        "expression": "if(prop(\"Open tasks\") > 10, \"At risk\", \"OK\")"
      }
    }
  }
}
```

The relation, rollup, status, and formula shapes reflect public API property schema patterns ([property object](https://developers.notion.com/reference/property-object)) and help docs for relation/rollup/formula semantics ([relations and rollups](https://www.notion.com/help/relations-and-rollups), [formula syntax](https://www.notion.com/help/formula-syntax)).

#### Data source query payload

```json
{
  "filter": {
    "and": [
      { "property": "Status", "status": { "equals": "In progress" } },
      {
        "or": [
          { "property": "Priority", "select": { "equals": "P0" } },
          { "property": "Due", "date": { "on_or_before": "today" } }
        ]
      }
    ]
  },
  "sorts": [
    { "property": "Priority", "direction": "ascending" },
    { "timestamp": "last_edited_time", "direction": "descending" }
  ],
  "page_size": 100,
  "start_cursor": null
}
```

This mirrors confirmed API filter/sort concepts: compound filters and ordered sorts over properties or timestamps ([query data source](https://developers.notion.com/reference/query-a-data-source), [filter data source entries](https://developers.notion.com/reference/filter-data-source-entries), [sort data source entries](https://developers.notion.com/reference/sort-data-source-entries)).

### Ordering strategies

#### Strategy A: Parent `content` array (Notion-confirmed mental model)

```json
{
  "id": "page-uuid",
  "type": "page",
  "content": ["block-a", "block-b", "block-c"]
}
```

- **Pros:** Simple, matches Notion's public explanation, easy to render whole small pages.
- **Cons:** Moving/inserting in a large parent rewrites the whole array; concurrent insertions require merge logic; pagination is awkward.
- **Use in clone:** Expose it in API responses and local snapshots, but not necessarily as the physical write model.

#### Strategy B: Fractional order keys in edge rows (recommended MVP)

```json
[
  { "parent_id": "page", "child_id": "block-a", "order_key": "a00000" },
  { "parent_id": "page", "child_id": "block-b", "order_key": "aU0000" },
  { "parent_id": "page", "child_id": "block-c", "order_key": "b00000" }
]
```

- Use a LexoRank/fractional-indexing key between neighboring keys for inserts.
- Periodically rebalance keys within one parent when keys grow too long.
- Multi-block drag/drop is one transaction with edge deletes/inserts and generated contiguous keys.
- Store `base_parent_version` to detect conflicting moves in the same parent.
- For collaboration/offline, either merge concurrent inserts by order key + actor ID tie-breaker or use a sequence CRDT for child lists.

#### Strategy C: CRDT list for child order (recommended offline phase)

- Use Yjs/Automerge-style sequence IDs for child edges.
- Server stores compact materialized order keys derived from CRDT sequence for query/pagination.
- Rich text and block-order CRDT can share the same transaction envelope but remain separate CRDT documents.
- Use tombstones/garbage collection for deleted child edges.

**Unknown:** Notion's internal concurrent block ordering algorithm is not public. The data model post only confirms ordered `content` arrays and transaction batching ([Notion data model](https://www.notion.com/blog/data-model-behind-notion)).

### Relation, rollup, and formula representation

#### Relations

Store relation property values as both JSON and queryable edges:

```json
{
  "property_id": "rel_tasks",
  "type": "relation",
  "relation": [
    { "id": "task-page-1" },
    { "id": "task-page-2" }
  ],
  "has_more": false
}
```

```sql
relation_edge(
  workspace_id uuid,
  from_page_id uuid,
  from_data_source_id uuid,
  from_property_id text,
  to_page_id uuid,
  to_data_source_id uuid,
  position_key text,
  primary key(from_page_id, from_property_id, to_page_id)
)
```

For dual relations, write both directions in the same transaction and include an invariant:

```text
if data_source_property.config.relation.dual_property exists:
  relation_edge(A.rel_tasks -> B) implies relation_edge(B.rel_project -> A)
```

**Confirmed basis:** Notion two-way relations mirror edits between databases ([relations and rollups](https://www.notion.com/help/relations-and-rollups)); API relation property config includes `data_source_id` and `dual_property` ([property object](https://developers.notion.com/reference/property-object)).

#### Rollups

Rollup config:

```json
{
  "type": "rollup",
  "relation_property_id": "rel_tasks",
  "rollup_property_id": "status",
  "function": "percent_checked"
}
```

Evaluation plan:

1. Resolve relation edges from the source page/property.
2. Read target property values on related pages.
3. Apply function (`sum`, `count`, `show_unique`, `earliest_date`, etc.).
4. Return typed result and dependency metadata.
5. Invalidate rollup when relation edges or target properties change.

Store cached results for queryable rollups:

```sql
computed_property_cache(
  page_id uuid,
  data_source_id uuid,
  property_id text,
  value jsonb,
  dependencies jsonb,
  computed_at timestamptz,
  stale boolean,
  primary key(page_id, data_source_id, property_id)
)
```

#### Formulas

Formula property config:

```json
{
  "type": "formula",
  "formula": {
    "expression": "if(and(now() > prop(\"Due\"), prop(\"Status\") != \"Done\"), style(\"Overdue\", \"red\", \"b\"), \"\")",
    "compiled": {
      "ast_version": 1,
      "dependencies": ["Due", "Status"],
      "volatile": true,
      "return_type": "text"
    }
  }
}
```

Recommendations:

- Store the original expression as source of truth.
- Compile to AST for safe evaluation and dependency extraction.
- Use static type inference before saving when possible.
- Track volatile functions (`now`, `today`) for scheduled invalidation.
- Support list/page/person/date primitives because Notion formulas operate over relations and people lists ([formula syntax](https://www.notion.com/help/formula-syntax)).
- Enforce a max dependency depth (Notion documents 15 layers for formulas/rollups) to prevent cycles and runaway recomputation ([common formula errors](https://www.notion.com/help/common-formula-errors)).

### Editor operations mapped to persistence operations

| User/editor action | Transaction operations | Records affected | Notes |
|---|---|---|---|
| Press `Enter` in paragraph | `split_rich_text`, `create_block`, `insert_child_edge`, `set_selection` | old block, new block, parent edge list | Notion confirms new blocks are created client-side with ID/type/properties then parent content is updated in same transaction ([Notion data model](https://www.notion.com/blog/data-model-behind-notion)). |
| Type text | `replace_rich_text_range` or CRDT text update | block properties / rich text doc | Debounce into transactions, but keep undo grouping by input event. |
| Toggle checkbox | `patch_block_property({checked:true})` | block | Use full-field replacement semantics in public API; internally can patch subfields ([update block](https://developers.notion.com/reference/update-a-block)). |
| Turn paragraph into heading | `set_block_type(heading_1)` | block | Preserve properties/content; renderer ignores unused fields. |
| Indent block | `move_block(child, new_parent=previous_sibling, order=end)` | child edge, permission parent if render parent changes | Structural nesting, confirmed by Notion. |
| Outdent block | `move_block(child, new_parent=grandparent, order=after_parent)` | edges, permission parent | Must preserve subtree. |
| Drag blocks | `move_blocks([...], target_parent, target_order_keys)` | multiple edges, perhaps permission closure | Validate all moved blocks and destination permissions. |
| Add relation | `add_relation_edge`, `add_dual_relation_edge?`, `invalidate_rollups` | relation values, computed caches | Dual relation writes should be atomic. |
| Edit formula schema | `update_data_source_property`, `compile_formula`, `invalidate_formula_dependents` | property schema, caches | Run type/dependency validation before commit. |
| Add comment | `create_discussion?`, `create_comment`, `notify_mentions` | discussion/comment | Public API allows page/block/existing discussion; inline new discussion creation may be UI-only in Notion API ([create comment](https://developers.notion.com/reference/create-a-comment)). |
| Share page | `upsert_acl_grant`, `recompute_permission_closure`, `emit_access_events` | ACL, closure, search visibility | Broadest-access-wins and inherited access. |
| Publish page | `set_public_url`, `upsert_public_acl`, `schedule_site_render` | page, ACL, cache | Publishing exposes subpages by default in Notion Sites ([public publishing](https://www.notion.com/help/public-pages-and-web-publishing)). |

---

## Editor architecture proposal

### Renderer/editor split

**Recommended for clone:** Build three layers.

1. **Schema layer:** Type definitions for blocks, rich text, properties, views, comments, operations, permissions, and API responses. No React/editor dependencies.
2. **Renderer layer:** Pure block-to-UI components. Inputs: normalized records, child iterators, view definitions, resolved permissions, and feature flags. Outputs: read-only DOM/Native views. This layer supports web publishing, exports, API previews, and tests.
3. **Editor layer:** Wraps renderer components with mutation affordances: cursor/text editing, block selection, drag handles, slash menus, inline menus, comment anchors, realtime presence, undo/redo, and transaction queue.

Why this matters:

- Notion has page rendering rules that differ by neighbor context, e.g. list adjacency spacing ([updating page design](https://www.notion.com/blog/updating-the-design-of-notion-pages)). A renderer should own those layout rules independently from editing.
- Public read-only pages, embeds, and exports should not load the full editor.
- Database views need a renderer for table/board/calendar and an editor controller for cell edits, drag between groups, and bulk selection.

### Rich text and block tree editing

**Known:** Notion has not publicly stated whether its editor is ProseMirror, Slate, Lexical, a custom editor, or something else. Do not treat third-party claims as confirmed.

**Recommended for clone options:**

- **MVP:** Use a proven rich-text toolkit (ProseMirror/Tiptap or Lexical) per text-bearing block, storing rich text as our own JSON. Keep block tree operations separate from rich text operations.
- **Collaboration/offline:** Use a CRDT-backed text representation (Yjs or Automerge) for each text block or page-level rich text fragments. Notion's offline post confirms a new CRDT data model for offline conflict resolution, but not the exact CRDT algorithm ([offline mode](https://www.notion.com/blog/how-we-made-notion-available-offline)).
- **Bridge format:** Convert editor-native doc state to stable `rich_text[]` segments for API/export. Preserve marks, links, mentions, and equations based on Notion-like rich text objects ([rich text](https://developers.notion.com/reference/rich-text)).

Recommended rich-text storage hybrid:

```text
block.properties.title_rich_text_json -- canonical API/read model
block_text_crdt(block_id, crdt_state, version) -- collaboration/offline model for active editable text
```

On save or snapshot, materialize CRDT state into `rich_text[]` for indexing/API.

### Transaction model

#### Client-side transaction lifecycle

```text
User input
  → editor command builds operations
  → local validator checks schema/permissions known locally
  → transaction is assigned idempotency key and base record versions
  → local store applies optimistic patch
  → undo manager records inverse operations or CRDT undo item
  → durable queue stores transaction
  → network worker sends transaction
  → server accepts/rejects/rebases
  → local queue marks committed or applies server correction
```

This follows Notion's confirmed pattern: optimistic local apply, RecordCache update, durable TransactionQueue, JSON POST to server, and server validation/commit/rejection ([Notion data model](https://www.notion.com/blog/data-model-behind-notion)).

#### Server transaction lifecycle

```text
POST /transactions
  1. authenticate actor and workspace
  2. load all referenced records and ancestors needed for ACL/invariants
  3. verify idempotency key
  4. construct before/after state in memory
  5. validate operation schemas, versions, permissions, data-source property constraints
  6. enforce invariants (no cycles, valid parent, one title property, relation target in DS)
  7. commit mutations and bump record versions in one DB transaction when possible
  8. write outbox events for realtime, indexing, webhooks, version history
  9. return accepted versions and any server-generated records
```

For large moves or cross-shard operations, use saga/outbox patterns. At MVP scale, keep all workspace data on one logical shard so multi-record transactions are ACID.

#### Operation envelope

```json
{
  "transaction_id": "f3757d3d-b5f5-488d-8782-e050e45e6fe5",
  "workspace_id": "workspace-uuid",
  "client_id": "desktop:abc123",
  "idempotency_key": "000001HS3...",
  "base_versions": {
    "block:page-uuid": 42,
    "block:block-a": 7
  },
  "operations": [
    {
      "op": "create_block",
      "block": {
        "id": "new-block-uuid",
        "type": "to_do",
        "properties": { "title": [], "checked": false }
      }
    },
    {
      "op": "insert_child",
      "parent_id": "page-uuid",
      "child_id": "new-block-uuid",
      "after": "block-a",
      "order_key": "aV0000"
    }
  ]
}
```

#### Conflict policy

- Rich text: CRDT merge for concurrent text edits.
- Block properties: last-writer-wins only for low-risk fields (color, collapsed state); compare-and-swap or semantic merge for title/rich text, checkbox, relation arrays.
- Child order: CRDT list or order-key merge with deterministic actor tie-breakers.
- Schema changes: optimistic lock on data source version; require rebase if a property was deleted/renamed.
- Permission changes: server authoritative; reject queued edits if actor lost permission before commit.

### Command and slash-command registry

Notion documents `/` menus with aliases such as `/text`, `/page`, `/bullet`, `/num`, `/todo`, `/toggle`, `/div`, `/quote`, `/h1`, `/h2`, `/h3`, `/link`, `/mention`, `/date`, `/equation`, `/image`, `/pdf`, `/book`, `/video`, `/audio`, `/code`, `/file`, `/embed`, `/duplicate`, `/moveto`, `/delete`, `/toc`, `/button`, `/template`, `/bread`, `/math`, `/latex` ([keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)).

**Recommended registry shape:**

```ts
type Command = {
  id: string;
  title: string;
  description?: string;
  aliases: string[];
  category: 'basic' | 'inline' | 'media' | 'database' | 'advanced' | 'ai';
  icon?: IconSpec;
  scopes: Array<'empty_block' | 'text_selection' | 'block_selection' | 'database_cell' | 'comment'>;
  isEnabled(ctx: EditorContext): boolean;
  preview?: (ctx: EditorContext) => PreviewSpec;
  run(ctx: EditorContext, args?: unknown): TransactionDraft | InlineMutation;
};
```

Examples:

```json
{
  "id": "block.todo",
  "title": "To-do list",
  "aliases": ["todo", "checkbox", "task"],
  "category": "basic",
  "scopes": ["empty_block", "block_selection"],
  "operation": { "op": "set_block_type", "type": "to_do", "defaults": { "checked": false } }
}
```

```json
{
  "id": "block.turn_into.heading_1",
  "title": "Heading 1",
  "aliases": ["h1", "#", "heading"],
  "category": "basic",
  "scopes": ["block_selection"],
  "operation": { "op": "set_block_type", "type": "heading_1" }
}
```

Registry requirements:

- One registry powers slash menu, command palette, block context menu, keyboard shortcuts, and API/import transformations.
- Commands should return transaction drafts, not mutate state directly.
- Commands declare required capabilities (`can_edit`, `can_comment`, `can_create_child_page`, etc.).
- Commands can be feature-flagged and localized.
- Slash menu search should rank exact aliases first, then fuzzy title matches, then recently used commands.
- For database commands, the same command framework can create data sources, views, properties, automations, and templates.

### Markdown input rules

**Confirmed UX to support:**

| Pattern | Trigger | Operation |
|---|---|---|
| `* `, `- `, `+ ` | start of block + space | turn current block into `bulleted_list_item` |
| `[] ` | start + space | turn into `to_do`, remove typed marker |
| `1. `, `a. `, `i. ` | start + space | turn into numbered list, set `list_format`/start if supported |
| `# ` | start + space | turn into `heading_1` |
| `## ` | start + space | turn into `heading_2` |
| `### ` | start + space | turn into `heading_3` |
| `> ` | start + space | turn into `toggle` per Notion docs |
| `" ` | start + space | turn into `quote` |
| `---` | exact block content | turn into `divider` |
| `**text**` | inline | apply bold mark |
| `*text*` | inline | apply italic mark |
| `` `text` `` | inline | apply inline code mark |
| `~text~` | inline | apply strikethrough mark |

Source: Notion's keyboard and markdown shortcut docs ([keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)).

Implementation details:

- Input rules should operate only in plain text contexts, not code blocks or equations.
- Rules should create undo boundaries so one undo returns the typed markdown marker.
- Input rules should preserve selected text when turning block type.
- Rules should respect IME composition and international keyboard input.
- Markdown import/export can be broader than live input rules; do not conflate them.

### Keyboard shortcuts and selection model

#### Selection state representation

```ts
type EditorSelection =
  | {
      mode: 'text';
      anchor: { blockId: string; path: RichTextPath; offset: number };
      focus: { blockId: string; path: RichTextPath; offset: number };
    }
  | {
      mode: 'blocks';
      anchorBlockId: string;
      focusBlockId: string;
      selectedBlockIds: string[];
    }
  | {
      mode: 'database_cells';
      dataSourceId: string;
      anchor: CellCoord;
      focus: CellCoord;
      selectedPageIds: string[];
      selectedPropertyIds: string[];
    };
```

Why explicit selection modes:

- Notion has both text selection and whole-block selection, with documented transitions via `esc`, `cmd/ctrl+a`, arrows, shift+arrows, shift+click, and block commands ([keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)).
- Drag/drop and bulk commands operate on block selections, not text ranges.
- Comments can anchor to text ranges, blocks, pages, database pages, or properties ([comments](https://www.notion.com/help/comments-mentions-and-reminders)).
- Database table selections need spreadsheet-like ranges and fill operations (`cmd/ctrl+R`, `cmd/ctrl+D` documented for tables) ([keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)).

#### Keyboard actions to implement early

- Navigation: `cmd/ctrl+p` / `cmd/ctrl+k` search, `cmd/ctrl+f` page search, back/forward, copy page URL.
- Text marks: bold, italic, underline, strikethrough, link, inline code, comment.
- Block transform shortcuts: text/H1/H2/H3/to-do/bullet/number/toggle/code/page using documented number shortcuts ([keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)).
- Block selection: `esc`, arrow movement, shift+up/down extend, shift+click range, delete, duplicate, `cmd/ctrl+/`, move up/down with `cmd/ctrl+shift+arrow`.
- Block-specific modify: `cmd/ctrl+enter` to check/uncheck to-do, open/close toggle, open page, full-screen media ([keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)).

### Drag/drop and structural ordering

Drag/drop should produce the same operations as keyboard move/indent/outdent.

Algorithm for dropping selected blocks:

1. Hit-test drop target: before/after block, inside block, inside page, database row/group, or external file drop.
2. Validate destination accepts children. Not all block types support children; public API lists child-capable block types ([block object](https://developers.notion.com/reference/block)).
3. Validate actor capability on source and destination.
4. Compute destination parent and order keys.
5. Generate `move_blocks` operation; preserve relative order of selected blocks.
6. If moving across permission boundaries, update `permission_parent_id` for root moved blocks and schedule permission-closure recompute for descendants.
7. Update local selection to moved blocks.
8. Emit transaction and optimistic patch.

Edge cases:

- Dragging parent into its descendant must be rejected.
- Dragging synced/transcluded block should ask whether to move instance, original, or create synced copy.
- Dragging database rows between board groups should update the grouping property and order key in one transaction.
- Holding option/alt while dragging duplicates selected blocks; Notion documents option/alt-drag duplicate behavior ([keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)).
- Dragging files into a page should create upload placeholder blocks and later replace with uploaded file metadata.

### Database view/query model

Public API filters and sorts map well to internal view definitions. Store views as composable presentation + query JSON.

```json
{
  "id": "view-roadmap-board",
  "name": "Roadmap board",
  "layout": "board",
  "data_sources": ["ds-projects"],
  "query": {
    "filter": {
      "and": [
        { "property": "Archived", "checkbox": { "equals": false } },
        { "property": "Status", "status": { "does_not_equal": "Done" } }
      ]
    },
    "sorts": [
      { "property": "Priority", "direction": "ascending" },
      { "timestamp": "last_edited_time", "direction": "descending" }
    ]
  },
  "layout_config": {
    "group_by": { "property": "Status", "hide_empty_groups": false },
    "subgroup_by": { "property": "Team" },
    "card_size": "medium",
    "shown_properties": ["Priority", "Owner", "Due"]
  },
  "open_pages_in": "side_peek"
}
```

Implementation implications:

- Query compiler converts filter JSON to SQL/typed-index queries.
- View renderer applies layout-specific grouping/presentation after query result retrieval.
- Formula/rollup properties can be expensive; query API docs explicitly recommend filtering returned properties and pruning complex formulas/rollups/relations for performance ([query data source](https://developers.notion.com/reference/query-a-data-source)). Clone should support property projection and lazy property fetching.
- Database search and workspace search are separate concepts: Notion help says database search looks at database page titles and properties, while workspace search searches page content, including database page content ([search help](https://www.notion.com/help/search)).

### Permissions and sharing model

#### Capabilities

Use ordered capabilities:

```text
none < view < comment < edit_content < edit < full_access
```

- `view`: read content.
- `comment`: add comments/reactions but not edit content.
- `edit_content`: edit database rows and property values, but not database schema/views.
- `edit`: edit content and structure.
- `full_access`: edit and share/manage permissions.

This tracks Notion's public access levels including database-specific `Can edit content` ([sharing and permissions](https://www.notion.com/help/sharing-and-permissions)).

#### Effective permission algorithm

```text
effective_permission(user, resource):
  candidates = grants directly on resource
             ∪ grants on permission ancestors
             ∪ workspace/teamspace/group grants
             ∪ page-level access rules from person/created_by properties
             ∪ public-link/web grants when applicable
  return max_capability(candidates)  // broadest access wins
```

Notion explicitly documents broadest-access-wins and inherited subpage permissions ([sharing and permissions](https://www.notion.com/help/sharing-and-permissions)).

#### Search/index ACL

Every indexed document should include one of:

- A compact ACL bitmap/list for small workspaces.
- A `permission_resource_id` plus query-time join to ACL service.
- A materialized `visible_to_user_ids` for small/private docs and `visible_to_group_ids` for group grants.

Notion's data lake post says permission data is expensive because permissions must be constructed by ancestor tree traversal for blocks, motivating denormalized views for AI/Search ([data lake](https://www.notion.com/blog/building-and-scaling-notions-data-lake)). Clone should not defer ACL indexing until scale; design it early.

### Comments model

Features to implement:

- Top-level page discussion.
- Inline text-range comment.
- Block comment.
- Database page comment.
- Database property comment.
- Resolve/reopen thread.
- Mention users/groups/pages/dates in comment rich text.
- Attachments with limits.
- Notification and inbox entries.
- Public API endpoints for page/block/existing-discussion comments; optionally mirror Notion's limitation that public API cannot create new inline comment threads ([create comment](https://developers.notion.com/reference/create-a-comment)).

Anchor representation:

```json
{
  "kind": "text_range",
  "block_id": "block-a",
  "range": {
    "anchor_path": [0],
    "anchor_offset": 5,
    "focus_path": [0],
    "focus_offset": 14
  },
  "quote": "selected text",
  "crdt_anchor": "optional-sticky-anchor-id"
}
```

For robust collaboration, use sticky CRDT anchors for text comments; keep quote fallback if anchor cannot be resolved after edits.

### Real-time collaboration and sync

#### Online realtime flow

```text
Client opens page
  → loadPageChunk(page_id)
  → render blocks
  → subscribe(record_ids, page_id)

Client A commits transaction
  → server bumps versions
  → outbox emits record.updated/page.updated
  → realtime gateway notifies subscribed clients with record ids + versions

Client B receives notification
  → compares local record versions
  → fetches changed records or applies operation patch
  → updates local store and re-renders
```

This intentionally resembles Notion's public MessageStore + `syncRecordValues` description ([Notion data model](https://www.notion.com/blog/data-model-behind-notion)).

#### Presence

Presence is not fully described in public engineering docs, but the sharing docs mention active avatars and jumping to where someone is reading/typing ([sharing and permissions](https://www.notion.com/help/sharing-and-permissions)). Recommended presence payload:

```json
{
  "user_id": "user-uuid",
  "page_id": "page-uuid",
  "selection": { "mode": "text", "block_id": "block-a", "offset": 42 },
  "viewport": { "top_block_id": "block-a", "bottom_block_id": "block-z" },
  "status": "editing",
  "updated_at": "2026-05-01T12:00:00Z"
}
```

Presence should be ephemeral, not persisted in the transaction log.

### Offline and latency model

**Confirmed constraints:** Notion offline mode only allows offline access to fully downloaded pages; pages available offline are tracked with reasons, and clients avoid showing partially missing pages while offline ([offline mode](https://www.notion.com/blog/how-we-made-notion-available-offline)).

Recommended clone design:

```sql
offline_page(
  page_id uuid primary key,
  workspace_id uuid not null,
  status text not null, -- downloading | available | stale | error
  last_downloaded_at timestamptz,
  last_server_updated_at timestamptz null
)

offline_action(
  id uuid primary key,
  origin_page_id uuid not null,
  from_page_id uuid null,
  impacted_page_id uuid not null,
  type text not null, -- toggled | favorite | recent | inherited_database_view | pinned
  metadata jsonb not null default '{}'
)
```

This mirrors Notion's published `offline_page` and `offline_action` concept ([offline mode](https://www.notion.com/blog/how-we-made-notion-available-offline)).

Offline dependency crawler should download:

- Page block and descendants in render tree.
- Mentioned pages needed for display titles? Cache title stubs even if not full content.
- Data-source schemas for inline/linked databases.
- A bounded result set for current database views, e.g. first N rows, matching Notion's public mention of downloading up to 50 pages in current database view for offline inheritance ([offline mode](https://www.notion.com/blog/how-we-made-notion-available-offline)).
- Property schemas and options.
- Comments if commenting offline is supported.
- Files if user requests “available offline with attachments.”

Reconnect logic:

1. Send queued local transactions in order.
2. Fetch server page/version metadata for offline pages using `lastDownloadedTimestamp` equivalent.
3. Download changed pages only.
4. Reconcile offline forest: insert/delete `offline_action` rows to reflect moved pages, changed database views, and removed inline databases.
5. Surface conflict UI only when semantic conflict cannot merge.

Latency goals:

- Text keystroke local apply under 16 ms.
- Block create under 50 ms optimistic visible.
- Transaction persisted locally before network send.
- Page open renders cached content immediately, then refreshes changed records.
- Database view shows skeleton/progressive rows and lazy-loads expensive formulas/rollups.

### Search and indexing

#### Index domains

1. **Workspace search:** page titles and page content blocks. Notion help says titles are weighted and page contents are searchable; comments/discussions and some mentions have limitations ([search help](https://www.notion.com/help/search)).
2. **Database search:** database page titles and property values, not body content ([search help](https://www.notion.com/help/search)).
3. **Mention/link picker:** pages/databases/users/dates; requires low latency and ACL filtering.
4. **Relation picker:** pages within target data source, searchable by title and shown properties.
5. **Public API search:** best for pages/databases by name, not exhaustive enumeration or database filtering, with indexing delays ([search API optimizations](https://developers.notion.com/reference/search-optimizations-and-limitations)).

#### Index document examples

```json
{
  "doc_id": "block:block-a",
  "workspace_id": "workspace-uuid",
  "page_id": "page-uuid",
  "block_id": "block-a",
  "kind": "block",
  "text": "Ship the first clone milestone",
  "block_type": "paragraph",
  "path": ["page-uuid", "block-a"],
  "last_edited_at": "2026-05-01T12:00:00Z",
  "permission_resource_id": "page-uuid"
}
```

```json
{
  "doc_id": "database_entry:task-page-1",
  "workspace_id": "workspace-uuid",
  "data_source_id": "ds-tasks",
  "page_id": "task-page-1",
  "title": "Fix drag drop",
  "properties_text": "In progress P0 Editor",
  "permission_resource_id": "task-page-1"
}
```

Index pipeline:

- Transaction commit writes `outbox_event(index.block)`.
- Indexer loads record + permission context + denormalized page title/path.
- Delete/trash writes tombstone to index.
- ACL changes trigger reindex or ACL metadata update.
- Search UI includes refresh affordance because public docs note indexing is not immediate ([search API optimizations](https://developers.notion.com/reference/search-optimizations-and-limitations)).

### Migrations and versioning

#### Record schema migrations

- Add `schema_version` per block/property/view.
- Store type-specific migrators from old to new shape.
- Migrate lazily on read for simple changes and backfill for query-critical changes.
- Keep operation handlers backward-compatible with at least one previous client version.
- Validate unknown fields are preserved where possible, especially block properties, to retain turn-into behavior.

#### API versioning

- Require `API-Version` date header like Notion's required `Notion-Version` header ([versioning](https://developers.notion.com/reference/versioning)).
- Release a new date version for breaking response or request changes.
- Treat additive fields and new enum values as non-breaking; ask clients to ignore unknown fields.
- Opaque cursors: document that cursors must not be parsed, matching Notion's guidance ([versioning](https://developers.notion.com/reference/versioning)).

#### Data migrations at scale

Notion's sharding post offers a template for major storage migrations: double-write, backfill, verification, and switchover; it also emphasizes workspace ID as a locality-preserving partition key and sharding related block-reachable tables together ([sharding Postgres](https://www.notion.com/blog/sharding-postgres-at-notion)). Recommended clone approach:

- Partition all workspace-owned records by `workspace_id` from day one, even on a single DB.
- Keep `workspace_id` in every primary/secondary table.
- Build an audit/outbox log before major migrations.
- Backfill with version comparison to avoid overwriting newer records.
- Dark-read old/new paths and log discrepancies before switchover.
- Implement verification separately from migration code.

### Public API design

Recommended REST resources:

```text
GET    /v1/blocks/{block_id}
PATCH  /v1/blocks/{block_id}
GET    /v1/blocks/{block_id}/children?page_size=&start_cursor=
PATCH  /v1/blocks/{block_id}/children   # append/insert/move? depending API version

POST   /v1/pages
GET    /v1/pages/{page_id}
PATCH  /v1/pages/{page_id}
GET    /v1/pages/{page_id}/properties/{property_id}

GET    /v1/databases/{database_id}
POST   /v1/databases
PATCH  /v1/databases/{database_id}

GET    /v1/data_sources/{data_source_id}
PATCH  /v1/data_sources/{data_source_id}
POST   /v1/data_sources/{data_source_id}/query

GET    /v1/comments?block_id=&page_id=&discussion_id=
POST   /v1/comments
PATCH  /v1/comments/{comment_id}

POST   /v1/search
POST   /v1/files
GET    /v1/users/{user_id}
GET    /v1/workspaces/{workspace_id}
POST   /v1/webhook_subscriptions
```

Design choices:

- Use stable UUIDs for records; allow short IDs for property schema IDs.
- Use cursor pagination; cursors are opaque.
- Support `filter_properties`/projection for data source queries, inspired by Notion's API performance guidance ([query data source](https://developers.notion.com/reference/query-a-data-source)).
- Expose rate limits and size limits. Notion's public API averages three requests/second per connection and caps payloads at 1000 block elements/500KB plus property-specific limits ([request limits](https://developers.notion.com/reference/request-limits)). A clone can choose different limits, but should publish them early.
- Provide webhooks as signals, not full content diffs. Notion webhook events indicate changes and consumers fetch latest state; events may be aggregated and out of order ([webhooks](https://developers.notion.com/reference/webhooks), [webhook event delivery](https://developers.notion.com/reference/webhooks-events-delivery)).
- Keep internal realtime collaboration separate from public webhooks. Webhooks are for integrations; editor sync needs lower latency and richer conflict semantics.

---

## DX/UX checklist

### Core authoring UX

- [ ] Page loads from local cache first, then refreshes.
- [ ] Empty page starts with text block and placeholder.
- [ ] `/` menu supports basic, inline, media, database, and advanced categories.
- [ ] Markdown input rules match Notion-like documented shortcuts.
- [ ] `@` mention picker supports users, groups, pages, dates, reminders.
- [ ] `[[` and `+` page creation/linking affordances are implemented.
- [ ] Block handles allow drag, duplicate, delete, move to, color, turn into, comment.
- [ ] `Turn into` preserves content and unused properties.
- [ ] Indent/outdent are structural tree operations.
- [ ] Multi-block selection, duplicate, delete, move, and comment work predictably.
- [ ] Undo/redo groups text input and block operations separately.
- [ ] Copy/paste preserves internal block JSON when pasting within app and degrades to HTML/Markdown externally.
- [ ] Accessibility: keyboard-only block movement, ARIA roles for menus, visible focus rings, screen-reader labels for drag handles.

### Database UX

- [ ] Rows are pages with body content and properties.
- [ ] Database can be inline or full-page.
- [ ] Database can hold multiple data sources or linked data sources.
- [ ] Views have independent layout/filter/sort/group/property visibility settings.
- [ ] Table/list/board/calendar views support property projection and lazy loading.
- [ ] Relation picker searches target data source and respects permissions.
- [ ] Rollup recalculates after relation/target property changes.
- [ ] Formula editor has type hints, function docs, preview, dependency validation, and cycle/depth errors.
- [ ] Database templates can prefill page properties and body content; recurring templates can be later.
- [ ] Automations are separated from core DB MVP but share formula/property infrastructure.

### Collaboration and comments

- [ ] Presence avatars and cursors show who is viewing/editing.
- [ ] Comments can attach to page, block, text range, database page, and database property.
- [ ] Mentions generate notifications only if mentioned user has access.
- [ ] Resolve/reopen flows preserve history.
- [ ] Suggested edits can be a later extension over comments + operations.
- [ ] Realtime notifications update record versions and fetch changed records.
- [ ] Conflict UI exists for rejected/rebased moves or permission changes.

### Offline and latency

- [ ] Local store is mandatory, not an afterthought.
- [ ] Durable transaction queue survives reloads/crashes.
- [ ] Offline availability tracks reasons, not a single boolean.
- [ ] Offline pages are complete or unavailable; never show a silently partial page.
- [ ] Reconnect only fetches changed offline pages via per-page timestamps/versions.
- [ ] Rich text supports CRDT merge before broad offline editing ships.
- [ ] Attachments have explicit offline download status.

### API/integration DX

- [ ] API has version header, stable object IDs, typed errors, request IDs, and pagination.
- [ ] API docs distinguish block/page/database/data-source and internal sync limitations.
- [ ] Webhooks are signed, retry with backoff, and include event timestamps but not full content.
- [ ] SDKs model discriminated unions for block types/property values.
- [ ] Import/export tools use same schema as public API.
- [ ] Rate/size limits are documented and test fixtures cover them.

---

## Open gaps, risks, and unknowns from public research

### CRDT/OT and collaboration internals

- **Unknown:** Notion's exact CRDT/OT algorithms, data structures, tombstone/GC strategy, and whether all pages or only offline-enabled pages use the new CRDT model. Public offline docs confirm a “new CRDT data model” for offline conflict resolution but do not reveal the internal algorithm ([offline mode](https://www.notion.com/blog/how-we-made-notion-available-offline)).
- **Risk for clone:** Rich text + block moves + comments anchored to ranges are difficult to merge correctly. A clone should avoid pretending last-writer-wins is enough once offline or true multiplayer editing is supported.
- **Mitigation:** Prototype CRDT text and CRDT child-order separately; define conflict policies before building lots of UI.

### Internal storage engine and exact schema

- **Known:** Notion stores block data in Postgres and sharded the `block` table and related tables by workspace ID ([sharding Postgres](https://www.notion.com/blog/sharding-postgres-at-notion)); native apps use SQLite for local storage ([faster page load navigation](https://www.notion.com/blog/faster-page-load-navigation)).
- **Unknown:** Exact table schemas, indexes, JSON shapes, row-level versioning, compression, and cache invalidation policies.
- **Risk for clone:** Overfitting to public API shapes may produce poor internal write performance.
- **Mitigation:** Use internal normalized tables with API materializers; benchmark large pages and databases early.

### View definition internals

- **Known:** Views have layout/filter/sort/group/property visibility and open-page settings; linked views can differ from original database views ([views, filters, and sorts](https://www.notion.com/help/views-filters-and-sorts), [data sources](https://www.notion.com/help/data-sources-and-linked-databases)).
- **Unknown:** Notion's internal view JSON, grouping algorithms, formula/rollup query pushdown, chart aggregation model, form schema, and multi-source view query planner.
- **Risk for clone:** Database views can become a second product as complex as the page editor.
- **Mitigation:** Treat views as saved query + layout config; build typed query compiler and projection support from the start.

### Formula engine details

- **Known:** Formula syntax supports functions, lists, relation page lists, people, dates, style/link, volatile functions, and a documented 15-layer formula/rollup limit ([formula syntax](https://www.notion.com/help/formula-syntax), [common formula errors](https://www.notion.com/help/common-formula-errors)).
- **Unknown:** Parser implementation, type inference details, evaluation caching, dependency invalidation, locale/timezone edge cases, security sandbox, and exact rollup/formula interaction.
- **Risk for clone:** Formula engines are easy to underbuild; users quickly expect spreadsheet-grade semantics.
- **Mitigation:** Use a real parser/AST, typed evaluator, dependency graph, and deterministic test corpus before exposing advanced functions.

### Access-control internals

- **Known:** Parent pointer is used for permissions; broadest access wins; page-level access rules can grant access based on person/created-by properties; public link and publishing have special semantics ([Notion data model](https://www.notion.com/blog/data-model-behind-notion), [sharing and permissions](https://www.notion.com/help/sharing-and-permissions)).
- **Unknown:** Exact ACL storage, closure caching, invalidation, public-page ACL handling, synced-block ACL resolution, and relation-induced exposure rules.
- **Risk for clone:** ACL bugs are severe security defects. Search, mentions, backlinks, comments, and relations all need ACL filtering.
- **Mitigation:** Centralize permission evaluation, materialize access paths, fuzz-test moves/shares, and perform negative-permission tests for every read API.

### Sync protocol and MessageStore details

- **Known:** Clients subscribe over WebSocket to records being rendered; version notifications lead clients to fetch outdated records via `syncRecordValues` ([Notion data model](https://www.notion.com/blog/data-model-behind-notion)).
- **Unknown:** Wire protocol, subscription granularity, batching, backpressure, disconnect recovery, ordering guarantees, and how operation patches vs full record fetches are chosen.
- **Risk for clone:** Naive “broadcast every operation” can overwhelm clients on large pages/databases.
- **Mitigation:** Start with version notifications + pull changed records; add patch streaming only where measured.

### Performance optimizations

- **Known:** Notion uses code splitting, client/server caching, SQLite, RecordCache, `loadPageChunk`, search indexing, workspace sharding, data lake denormalization, and query performance recommendations ([faster page load navigation](https://www.notion.com/blog/faster-page-load-navigation), [Notion data model](https://www.notion.com/blog/data-model-behind-notion), [data lake](https://www.notion.com/blog/building-and-scaling-notions-data-lake), [query data source](https://developers.notion.com/reference/query-a-data-source)).
- **Unknown:** Virtualization thresholds, database view query planner, cache key design, React rendering optimizations, block dependency expansion rules, relation/rollup indexing, and search ranking formula.
- **Risk for clone:** A block editor that feels fine at 100 blocks may fail at 10,000 blocks or 50,000 database rows.
- **Mitigation:** Build load tests with large nested pages, large databases, many properties, deep permission trees, and many comments.

### Editor toolkit and selection internals

- **Unknown:** Notion's internal editor toolkit and exact selection model are not public. The docs describe user-visible keyboard behavior but not implementation ([keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)).
- **Risk for clone:** Browser selection, IME, mobile, drag/drop, and nested editors are notoriously brittle.
- **Mitigation:** Choose an editor toolkit with proven IME/mobile behavior; encapsulate block selection outside text editor state; build a selection test harness.

---

## Recommended follow-up experiments

### 1. Block tree storage benchmark

Build three prototypes for 10,000-block pages:

1. Parent JSON `content` array.
2. `block_child_edge` table with fractional order keys.
3. CRDT list materialized to order keys.

Measure insert, move, indent, load children, paginate, and concurrent insertion merge. Use the results to choose MVP storage and offline path.

### 2. Transaction pipeline spike

Implement a minimal transaction API with:

- `create_block`, `update_block`, `insert_child`, `move_block`, `delete_block`, `set_block_type`.
- Local optimistic IndexedDB/SQLite store.
- Durable queue and idempotency key.
- Server before/after validation and version bump.
- WebSocket version notifications and client refetch.

Goal: validate Notion-like transaction architecture before building UI breadth.

### 3. Rich text CRDT proof of concept

Compare Yjs and Automerge for:

- Rich text marks, links, mentions, equations.
- Comment anchors through edits.
- Undo/redo semantics.
- Serialization to `rich_text[]`.
- Offline edits and reconnect.
- Memory usage for long pages.

Deliverable: decision memo and bridge format.

### 4. Slash command and input-rule harness

Create a command registry and test runner where text input sequences produce operations. Include all confirmed Notion-like markdown triggers and slash aliases from keyboard docs ([keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)).

Example test:

```text
Given empty paragraph
When user types "[] "
Then transaction = [set_block_type(to_do), replace_text_range(0..3, "")]
And selection remains in title at offset 0
```

### 5. Database query compiler

Implement property schemas and compile filter/sort JSON to SQL against side tables. Include formulas/rollups as cached computed properties and evaluate invalidation. Test with:

- 100k rows.
- 100 properties.
- Relations with >25 values.
- Rollups over relation lists.
- Compound nested filters.
- Projection of selected properties.

Use Notion API docs as compatibility inspiration, but design for our scale and product constraints ([query data source](https://developers.notion.com/reference/query-a-data-source), [request limits](https://developers.notion.com/reference/request-limits)).

### 6. Permission closure and search ACL test

Prototype inherited ACL with broadest-access-wins, page-level access rules, public links, and private pages. Generate randomized page trees and moves; assert every read path (page load, search, relation picker, comments, webhooks) respects effective permissions.

### 7. Offline forest prototype

Implement `offline_page` and `offline_action` tables following Notion's published model ([offline mode](https://www.notion.com/blog/how-we-made-notion-available-offline)). Simulate:

- Explicit offline toggle.
- Favorite/recent auto-download reason.
- Database view inheritance for first N rows.
- Moving pages in/out of offline roots.
- Removing inline databases.
- Reconnect with `lastDownloadedTimestamp`.

### 8. Renderer performance test

Build a read-only block renderer with adjacency spacing rules and virtualization. Test pages containing mixed paragraphs, lists, toggles, images, nested pages, comments, and database views. Validate:

- Initial render time.
- Scroll jank.
- Selection overlays alignment.
- List adjacency spacing.
- Toggle collapse rendering.

### 9. Public API compatibility design

Draft OpenAPI/JSON Schema for blocks, pages, data sources, queries, comments, search, and webhooks. Include version headers, request IDs, rate limits, idempotency, and webhook signatures. Verify SDK discriminated unions handle unknown block/property types.

### 10. Migration drill

Before production scale, perform a fake breaking migration:

- Add `workspace_id` to all core tables.
- Double-write old/new shape.
- Backfill with version comparison.
- Dark-read and verify.
- Switchover and rollback.

This directly rehearses the strategy Notion describes for sharding migrations ([sharding Postgres](https://www.notion.com/blog/sharding-postgres-at-notion)).
