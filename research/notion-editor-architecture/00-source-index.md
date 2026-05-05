# Notion editor architecture source index

Scope: authoritative and high-signal public sources for understanding Notion's editor architecture, block/data model, API representation, product UX, and developer ergonomics before designing a Notion-like clone. Official Notion sources are prioritized. Public sources are treated as evidence about observable behavior or disclosed implementation, not as complete internal specifications.

## Official Notion engineering / architecture sources

### [The data model behind Notion's flexibility](https://www.notion.com/blog/data-model-behind-notion)

- **Source type:** Official Notion engineering/product blog; primary source.
- **Relevant topics:** Block model, render tree, permissions, client transactions, local cache, real-time sync, page loading.
- **Key claims/details:**
  - “Everything you see in Notion is a block”: text, images, lists, database rows, and pages are all dynamic block records.
  - Blocks have an `id` (random UUID v4), `properties`, `type`, `content` (ordered child block IDs / “downward pointers”), and `parent` (an “upward pointer” used for permissions).
  - Block `type` controls rendering and interpretation; changing type does not erase unrelated properties, so data can survive transformations like to-do → heading → to-do.
  - `content` defines the render tree, but the tree is not a plain visual outline: list blocks render children indented, toggles hide/show children, pages render children behind a page navigation boundary.
  - Indentation is structural, not presentational: indenting moves a block into a sibling's content array where valid.
  - Permissions use parent pointers rather than scanning content arrays because content references were historically allowed from multiple places and because ancestor lookup must be efficient.
  - User edits are expressed as operations that create/update individual records, then batched into server-validated transactions.
  - The client applies transactions optimistically to local state; native apps cache records in an LRU `RecordCache` over SQLite or IndexedDB and persist unsaved transactions in `TransactionQueue`.
  - Server flow includes private/internal endpoints and services named `saveTransactions`, `MessageStore`, `syncRecordValues`, and `loadPageChunk`.
  - Real-time updates use long-lived WebSocket subscriptions to changed records; clients fetch newer record values after version notifications.
  - `loadPageChunk` descends the content tree and fetches dependent records needed to render a page; rendering uses React once records are in memory.
- **Reliability:** Highest-value source for internal architecture, but published in 2021 and simplified for a broad technical audience. Endpoint/service names describe internal systems that may have changed.
- **Helps answer:** What is a Notion block? How should a clone model nested blocks, transformations, permissions, optimistic updates, caching, and real-time sync?

### [How we made Notion available offline](https://www.notion.com/blog/how-we-made-notion-available-offline)

- **Source type:** Official Notion engineering blog; primary source.
- **Relevant topics:** Offline mode, local persistence, CRDT migration, dependency tracking, sync freshness.
- **Key claims/details:**
  - Existing SQLite cache was best-effort; offline mode required guarantees that a page has all records needed to render and edit without network access.
  - Offline pages are tracked explicitly and only fully available pages are accessible when offline to avoid partial rendering and unpredictable merges.
  - Offline-enabled pages are dynamically migrated to a new CRDT data model for rich-text conflict resolution.
  - Notion models offline availability as a forest of page trees, not a simple set. A page can have multiple independent reasons to be offline: user toggle, recent automatic download, favorite, inheritance, etc.
  - Disclosed local tables: `offline_page` records pages/databases available offline; `offline_action` records each reason, with `origin_page_id`, `from_page_id`, `impacted_page_id`, and `type`.
  - Invariant: every `offline_page` row must have at least one matching `offline_action` where it appears as `impacted_page_id`; remove only after the last reason disappears.
  - Marking a database offline can inherit offline status to up to 50 pages in the current view.
  - Freshness is push-based: server emits page-channel messages from an existing page version snapshot system; clients subscribe for offline pages and fetch latest changes.
  - Reconnect catch-up uses per-page `lastDownloadedTimestamp` compared with server `lastUpdatedTime` to avoid refetching unchanged pages.
  - Refetching an offline page reconciles `offline_action` with the latest hierarchy and database view, adding/removing inherited rows as descendants or visible database pages change.
- **Reliability:** High; current official architecture detail. It still omits CRDT algorithm, operation schema, merge strategy, and full record-dependency enumeration.
- **Helps answer:** How can a clone evolve from a cache to reliable offline mode? What metadata is needed to know why content is local and when it can be pruned?

### [Notion's page load and navigation times just got faster](https://www.notion.com/blog/faster-page-load-navigation)

- **Source type:** Official Notion engineering/performance blog; primary source.
- **Relevant topics:** Client caching, SQLite, performance, IndexedDB limitations.
- **Key claims/details:**
  - Adding SQLite support to dedicated apps made initial page loads and page-to-page navigation roughly 50% faster for most users.
  - Improvements also included JS code splitting and client/server cache improvements.
  - Desktop apps moved from IndexedDB due to storage quotas, bugs, and Windows performance concerns.
  - SQLite gave Notion a better-controlled local storage layer, laying groundwork for more client-side data retrieval and future performance/offline work.
- **Reliability:** High official performance source; does not expose storage schema or cache invalidation internals.
- **Helps answer:** Why should a clone consider a durable local record cache instead of relying only on browser storage APIs or server fetches?

### [How we sped up Notion in the browser with WASM SQLite](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite)

- **Source type:** Official Notion engineering blog; primary source.
- **Relevant topics:** Browser local storage, WebAssembly SQLite, multi-tab concurrency, worker architecture.
- **Key claims/details:**
  - Notion brought SQLite caching to browsers via the official WASM sqlite3 implementation, improving page navigation times by ~20% across modern browsers and more in slow-network regions.
  - Uses OPFS for persistence and Web Workers for WASM SQLite execution; Notion uses Webpack for worker loading and Comlink for main-thread/worker messaging.
  - Final architecture uses a SharedWorker to route all tab queries to the active tab's dedicated worker, so only one tab writes to SQLite at a time while all tabs benefit from cache.
  - Web Locks are used to detect tab lifetime and hand off active-tab ownership.
  - Earlier one-worker-per-tab attempts caused SQLite corruption because OPFS concurrency handling was insufficient for simultaneous writes.
  - Chose OPFS SyncAccessHandle Pool VFS because it avoided cross-origin isolation and corruption problems.
  - WASM library loading is asynchronous to avoid slowing initial page load; Notion races cache reads against API responses on slow devices because disk cache is not always faster.
- **Reliability:** High; concrete implementation decisions, constraints, and metrics. Still specific to Notion's browser app and cache workload.
- **Helps answer:** How should a clone safely use SQLite/OPFS in multi-tab browsers, and when should it fall back to network reads?

### [Herding elephants: Lessons learned from sharding Postgres at Notion](https://www.notion.com/blog/sharding-postgres-at-notion)

- **Source type:** Official Notion infrastructure blog; primary source.
- **Relevant topics:** Production storage model, sharding, Postgres scaling, migration strategy.
- **Key claims/details:**
  - By mid-2020, product usage produced billions of new blocks/files/spaces; Postgres VACUUM stalls and TXID wraparound risk forced sharding.
  - Notion implemented application-level sharding rather than packaged Citus/Vitess-like sharding for control over data distribution.
  - Sharded all tables reachable from `block` via foreign-key-like relationships to preserve consistency for block-related records such as spaces, discussions, and comments.
  - Partition key is workspace ID because each block belongs to exactly one workspace and users usually query within one workspace, avoiding most cross-shard joins.
  - Initial sharded architecture: 480 logical shards distributed across 32 physical databases; each logical shard is a Postgres schema containing separate tables such as `schema001.block`.
  - Logical shard count was chosen for many factors/divisors, enabling future physical-host remapping.
  - Migration pattern: double-write via audit log, backfill, verify, dark reads, switch-over; backfill skipped rows with newer versions.
  - Lessons include shard earlier, aim for zero downtime, and consider composite keys rather than passing `space_id` throughout app code.
- **Reliability:** High official source. It describes infrastructure, not editor code, but grounds the scale and storage constraints of the block model.
- **Helps answer:** How should workspace locality, transactions, and foreign-key reachability shape a clone's durable data model?

### [The Great Re-shard: adding Postgres capacity (again) with zero downtime](https://www.notion.com/blog/the-great-re-shard)

- **Source type:** Official Notion infrastructure blog; primary source.
- **Relevant topics:** Current-ish database fleet shape, workspace sharding, PgBouncer, live migration.
- **Key claims/details:**
  - Notion's “space shards” store all workspace-generated content, including blocks, comments, and collections (Notion databases). Data is partitioned by workspace ID.
  - Before re-shard, the cluster had 32 databases, each workspace assigned to one shard for speed/locality.
  - Capacity issues included >90% CPU at peak, IOPS pressure, and PgBouncer connection limits.
  - Re-shard tripled physical databases from 32 to 96 while keeping 480 logical schema partitions, moving from 15 schemas per physical DB to 5.
  - Used Terraform provisioning, Postgres logical replication publications/subscriptions, index rebuilds after copy to reduce sync time, dark reads for equivalence, and staged PgBouncer sharding.
  - Failover sequence: pause traffic in PgBouncer, verify replication caught up, update shard mapping/reload PgBouncer/revoke old app login/flip reverse replication, resume traffic.
  - Claimed no observed user downtime; worst case was around a second of “saving” spinner.
- **Reliability:** High official source; operational rather than product-level. Useful for scale planning, not required for an early clone.
- **Helps answer:** How might a block workspace store evolve once a clone reaches large multi-tenant scale?

### [Building and scaling Notion's data lake](https://www.notion.com/blog/building-and-scaling-notions-data-lake)

- **Source type:** Official Notion data infrastructure blog; primary source.
- **Relevant topics:** Analytical copies of block data, denormalization, permission traversal, AI/search workloads.
- **Key claims/details:**
  - Everything users see is modeled as a `block` entity in the backend and stored in Postgres with consistent structure/schema/metadata.
  - Block rows grew from 20B+ in early 2021 to 200B+ by 2024, with data doubling every 6-12 months.
  - Sharded production Postgres evolved from 32 physical instances/480 logical shards to 96 physical instances/480 logical shards.
  - Notion's block workload is update-heavy: 90% of upserts are updates, making typical warehouse ingestion inefficient.
  - Offline/product use cases need denormalized block views; permission data is not statically stored and requires ancestor-tree traversal up to workspace root.
  - Data lake design: Debezium CDC from Postgres to Kafka, Apache Hudi to S3, Spark for transformation/denormalization/enrichment, then downstream stores for analytics, AI, Search, etc.
  - The data lake is not for online low-latency serving; target latency ranges from minutes to hours.
- **Reliability:** High for data infrastructure. It reveals useful implications of permissions and block graph scale but not online editor internals.
- **Helps answer:** What derived data/search/index pipelines may be needed beyond the primary editor database?

## Official Notion API / developer representation sources

### [Notion API reference introduction](https://developers.notion.com/reference/intro), [capabilities](https://developers.notion.com/reference/capabilities), and [request limits](https://developers.notion.com/reference/request-limits)

- **Source type:** Official API documentation; primary representation of public API contracts.
- **Relevant topics:** REST conventions, IDs, pagination, rate limits, permission/capability ergonomics.
- **Key claims/details:**
  - API base URL is `https://api.notion.com`; bodies are JSON; resources have an `object` discriminator and UUIDv4 `id`.
  - API uses `snake_case`, ISO 8601 dates, and explicit `null` rather than empty strings.
  - List endpoints are cursor-paginated with `has_more`, `next_cursor`, `results`, `type`; `page_size` max is 100.
  - Capabilities are scoped: read/update/insert content, read/insert comments, and user-info levels. Capabilities never supersede a user's own access.
  - Rate limit is an average of three incoming requests per second per connection, with HTTP 429 and `Retry-After`.
  - Payload limits include 1000 block elements, 500KB overall, 100 array elements for block/rich-text arrays, 2000 characters for rich text content/link URLs, and caps such as 100 relations/people.
- **Reliability:** High for public integrations; not a direct internal API specification.
- **Helps answer:** What constraints should a clone's external API expose to keep integrations predictable and scalable?

### [Block object](https://developers.notion.com/reference/block), [Working with page content](https://developers.notion.com/docs/working-with-page-content), [Retrieve block children](https://developers.notion.com/reference/get-block-children), and [Append block children](https://developers.notion.com/reference/patch-block-children)

- **Source type:** Official API documentation; public serialization of page content.
- **Relevant topics:** Block fields, block type taxonomy, child traversal, page content vs page properties.
- **Key claims/details:**
  - Public block fields include `object`, `id`, `parent`, `type`, `created_time`, `created_by`, `last_edited_time`, `last_edited_by`, `archived`/`in_trash`, `has_children`, and a type-specific object keyed by `type`.
  - Public block types include paragraphs, headings, list items, to-dos, toggles, columns, tables, child pages/databases, media, embeds, synced blocks, meeting notes, etc.
  - Only some block types support children; API responses use `has_children` and type-specific nested `children` where applicable.
  - Page content is a list of child block objects; page properties are separate structured metadata.
  - Retrieving block children returns only one level and is paginated, so full page reconstruction requires recursive child fetching and async/rate-limited processing for large pages.
  - Creating pages can include initial child blocks; appending block children adds content to existing blocks. The page-content guide says the append endpoint supports a `position` body parameter (`after_block`, `start`, `end`) for placement; verify against the live endpoint reference and API version during implementation because older community guidance often said append-only.
- **Reliability:** High for public API behavior. Treat as a projection of internal model; it omits internal operation/transaction format and may lag new product-only block types.
- **Helps answer:** How should a clone serialize blocks, expose recursive content reads, handle block placement, and separate content blocks from structured page fields?

### [Page object](https://developers.notion.com/reference/page), [Page property values](https://developers.notion.com/reference/property-value-object), and [Rich text object](https://developers.notion.com/reference/rich-text)

- **Source type:** Official API documentation; public page/property/rich-text contracts.
- **Relevant topics:** Page metadata, database rows as pages, rich text spans, mentions, property value typing.
- **Key claims/details:**
  - Page objects include metadata (`created_time`, `last_edited_time`, `created_by`, `last_edited_by`), visual fields (`cover`, `icon`), `parent`, `in_trash`, `properties`, `url`, and `public_url`.
  - Pages in databases carry property values keyed by property name/ID; the title property is represented by rich text under a `title` type.
  - Page property values have stable `id`s, a `type`, and a type-specific value object. Property IDs remain constant when names change.
  - Formula and rollup page-property values are computed/read-only from API writes; relation/people/title/rich_text can require paginated property-item retrieval to avoid truncation.
  - Rich text objects are discriminated by `type`: `text`, `mention`, or `equation`. They carry `annotations`, `plain_text`, and optional `href`.
  - Mentions can reference pages, databases, users, dates, link previews, or template placeholders. Access limitations can return only IDs/Untitled placeholders.
- **Reliability:** High for API representation. Internal editor rich-text storage may differ, especially after offline CRDT migration.
- **Helps answer:** How should a clone separate document content from structured metadata and design stable property IDs, rich text spans, mentions, and computed values?

### [Database object](https://developers.notion.com/reference/database), [Data source object](https://developers.notion.com/reference/data-source), [Working with databases](https://developers.notion.com/docs/working-with-databases), [Property object](https://developers.notion.com/reference/property-object), and [2025-09-03 upgrade guide](https://developers.notion.com/docs/upgrade-guide-2025-09-03)

- **Source type:** Official API documentation; primary public model for databases after the multi-source update.
- **Relevant topics:** Databases, data sources, schema/property objects, relations, database API evolution.
- **Key claims/details:**
  - A database is an object containing one or more data sources; it can render inline or as a full page and owns permissions for data source children.
  - A data source is an individual table of data under a database. Pages are the items/rows in a data source, and page property values must conform to the parent data source's property schema.
  - The 2025-09-03 API introduces first-class multi-source database support and is not backward-compatible for many integrations: most old `database_id` operations migrate to `data_source_id` operations.
  - Database creation still creates a database, initial data source, and default view; adding another source uses data source APIs.
  - Property objects define the data source schema and render as columns in Notion UI. Each property has `id`, `name`, `description`, `type`, and a type-specific configuration object.
  - The `title` property is special: every database/data source has exactly one title-type property for page titles.
  - Public property types include checkbox, date, email, files, formula, multi_select, number, people, relation, rich_text, rollup, select, status, title, unique_id, URL, and more.
  - Relations now point to a `data_source_id`; dual relations include synced property metadata. Rollups and formulas are computed.
- **Reliability:** High for current developer surface. It intentionally abstracts away internal storage/indexing/query execution.
- **Helps answer:** How should a clone model tables as pages with schemas, keep stable property IDs, support multiple data sources per database, and migrate external API semantics over time?

### [View object](https://developers.notion.com/reference/view) and [Working with views](https://developers.notion.com/guides/data-apis/working-with-views)

- **Source type:** Official API documentation; public view model.
- **Relevant topics:** Database views, filters, sorts, linked views, view configuration.
- **Key claims/details:**
  - Views define how pages in a data source are filtered, sorted, and displayed in a database.
  - Supported layouts include table, board, calendar, timeline, gallery, list, form, chart, map, and dashboard.
  - A view is scoped to one `data_source_id`; dashboard views can contain widget views and have `data_source_id: null`.
  - Important fields include `filter`, `sorts`, `quick_filters`, and type-specific `configuration`.
  - Creating a database through the API automatically provisions one data source and one table “Default view.”
  - Linked database views can reference an existing data source from another page without creating a new schema.
  - View configuration covers presentation details such as table frozen columns/wrapping, board grouping/cards/covers, calendar date property, timeline range/dependency arrows, gallery cover, form/chart/dashboard settings.
- **Reliability:** High for public API. It reveals UX configuration concepts but not internal query/index planner details.
- **Helps answer:** How should a clone separate data storage from saved view presets and implement “same data, many workflows” ergonomics?

### [Webhooks](https://developers.notion.com/reference/webhooks) and [Event types & delivery](https://developers.notion.com/reference/webhooks-events-delivery)

- **Source type:** Official API documentation; public integration events.
- **Relevant topics:** Change notification, event aggregation, webhook security, integration ergonomics.
- **Key claims/details:**
  - Webhooks notify integrations about workspace changes without polling, but events do not include full changed content; integrations must follow up with API reads.
  - Webhook setup includes endpoint verification with a `verification_token` and optional/recommended HMAC-SHA256 request validation via `X-Notion-Signature`.
  - Event envelope includes `id`, `timestamp`, `workspace_id`, `subscription_id`, `integration_id`, `type`, `authors`, `entity`, and event-specific `data`.
  - Supported events include page content/properties lifecycle events, database lifecycle/schema events, data_source lifecycle/schema/content events, and comment events.
  - Frequent events such as `page.content_updated` are aggregated; most events should deliver within one minute and all within five minutes, but ordering is not guaranteed.
  - Delivery is at-most-once with up to eight retry attempts over roughly 24 hours if the endpoint does not acknowledge.
- **Reliability:** High for public integrations. This is not Notion's internal real-time collaboration protocol.
- **Helps answer:** How should a clone design webhooks as coarse change signals distinct from low-latency collaborative sync?

## Official Notion product UX / Help Center sources

### [What is a block?](https://www.notion.com/help/what-is-a-block), [Block basics](https://www.notion.com/help/guides/block-basics-build-the-foundation-for-your-teams-pages), and [Writing and editing basics](https://www.notion.com/help/writing-and-editing-basics)

- **Source type:** Official Help Center/product documentation; primary UX behavior source.
- **Relevant topics:** User-facing block concept, editor controls, block types, drag/drop, page blocks.
- **Key claims/details:**
  - Notion describes itself as a bottomless bin of building blocks; every piece of page content is a block and pages are stacks/compositions of blocks.
  - Blocks can be turned into other block types and moved/reordered via the `⋮⋮` drag handle.
  - Core editor controls: `+` menu to add content, `⋮⋮` menu for block actions, and `/` commands for adding blocks or applying actions/colors.
  - Basic block types include text, page/subpage, to-do, headings, table, lists, toggle, quote, divider, link-to-page, callout.
  - Database blocks can be inline in a page; media/embed/advanced blocks include image, video, audio, file, code, bookmark, equations, buttons, breadcrumb, table of contents.
  - Inline options include person/page/date/reminder/emoji mentions.
  - Desktop supports hover handles, partial text selection across blocks, block selection with `Esc`, and drag/drop in page and sidebar; mobile replaces hover/slash affordances with an editing toolbar.
- **Reliability:** High for product behavior. Help docs intentionally avoid internal data structures except user-facing language.
- **Helps answer:** What interaction affordances and block taxonomy should a clone reproduce before deep backend parity?

### [Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts) and [Using slash commands](https://www.notion.com/help/guides/using-slash-commands)

- **Source type:** Official Help Center/product documentation; high-signal UX reference.
- **Relevant topics:** Command model, keyboard-driven editing, block selection/movement, mentions.
- **Key claims/details:**
  - `/` opens a full menu of insertable content blocks and actions; users can type command names to filter.
  - Slash commands create basic blocks (`/text`, `/page`, `/bullet`, `/todo`, `/toggle`, `/h1`), inline entities (`/mention`, `/date`, `/equation`, `/emoji`), media (`/image`, `/pdf`, `/video`, `/code`, `/embed`), and advanced actions (`/duplicate`, `/moveto`, `/delete`, `/toc`, `/button`, `/bread`, `/math`).
  - Markdown-like line-start shortcuts convert typed prefixes into blocks (`[]`, `#`, `##`, `>`, `---`, etc.).
  - `Tab` indents and nests content; `Shift+Tab` un-nests. The shortcut docs explicitly say nesting a block under the block above causes selecting the parent to select nested content too.
  - Block selection shortcuts include `Esc`, `cmd/ctrl+a`, arrow-key navigation, shift-click range selection, duplicate/delete/move selected blocks, and `cmd/ctrl+/` to change selected blocks.
  - Page linking/creation affordances include `@`, `[[`, and `+` with different dropdown priorities for linking vs creating.
- **Reliability:** High for UX surface and keyboard grammar. It does not explain implementation of selections, transactions, or input method edge cases.
- **Helps answer:** What command palette grammar, shortcut semantics, and block-selection model should be specified for a clone?

### [Intro to databases](https://www.notion.com/help/intro-to-databases) and [Database properties](https://www.notion.com/help/database-properties)

- **Source type:** Official Help Center/product documentation; product semantics.
- **Relevant topics:** Database rows-as-pages, properties, inline/full-page databases, database item pages.
- **Key claims/details:**
  - Notion databases are collections of pages; every item/row/card is its own Notion page that can contain regular blocks below its properties.
  - Databases are unique because every item is a page, properties contextualize/label/augment pages, and the same data can be visualized as different view layouts.
  - Databases can be full-page or inline. Inline databases appear as subpages in sidebar and can be expanded/converted.
  - Opening a database item shows properties at the top and free page space below for arbitrary content blocks, subpages, or inline databases.
  - Dragging ordinary blocks into a database can turn them into pages.
  - Database property types include text, number, select, status, multi-select, date, formula, relation, rollup, person, file, checkbox, URL, email, phone, created/edited timestamps/users, button, ID, and place.
  - Each database can have up to 500 properties for performance/reliability.
  - Values have type-specific editing behavior; select/multi-select options, date ranges/reminders, file uploads, person tags, and auto-generated created/edited fields are all first-class UX concepts.
  - Property-level comments are supported only in table view or open database pages and not for some computed/identity properties.
- **Reliability:** High for user-facing database semantics. Does not reveal physical storage or query execution.
- **Helps answer:** How should a clone merge documents and tables without treating them as separate products?

### [Data sources and linked databases](https://www.notion.com/help/data-sources-and-linked-databases) and [Views, filters & sorts](https://www.notion.com/help/views-filters-and-sorts)

- **Source type:** Official Help Center/product documentation; product semantics.
- **Relevant topics:** Multi-source databases, linked views, view state, filters/sorts/grouping.
- **Key claims/details:**
  - Every database has at least one data source: a set of pages in a database.
  - Users can create databases with a new data source, link an existing data source, or add/link more sources to an existing database.
  - Linked data sources respect the access level of the original database; users cannot set different access per source in a database.
  - Views, filters, sorts, and groups created against a linked data source do not affect original views, but edits to the data source's title/properties/pages reflect in the original.
  - View layouts include table, board, timeline, calendar, list, gallery, chart, and forms.
  - Each database view has its own settings; settings do not automatically apply to other views.
  - Page open behavior is configurable per view: side peek, center peek, or full page.
  - Filters can be simple or advanced with nested `AND`/`OR` groups up to three layers deep; filters/sorts can be saved for everyone or kept personal.
  - Database search looks at page titles and properties.
- **Reliability:** High for product behavior and the new multi-source model. Does not reveal how filters/sorts are planned or indexed.
- **Helps answer:** How should a clone separate source data, linked render locations, saved views, and personal/shared view settings?

### [Relations and rollups](https://www.notion.com/help/relations-and-rollups) and [Formulas](https://www.notion.com/help/formulas)

- **Source type:** Official Help Center/product documentation; product semantics.
- **Relevant topics:** Cross-database references, computed properties, formula language.
- **Key claims/details:**
  - Relation properties connect database pages to pages in another database/data source; Notion frames this as “adding Notion pages stored in one database into the property field of another.”
  - Relations are one-way by default but can add a corresponding two-way relation in the destination database; edits work both ways for two-way relations.
  - Relations can be limited to one page or have no limit; self-relations are supported, with guidance to avoid duplicate two-way properties when relating a database to itself.
  - Relation display can show selected properties from related pages.
  - Rollups aggregate values over relation properties using functions such as count, unique, sum, average, median, min/max, date range, percent empty/not empty, etc.
  - Rollups can only be sorted when output is numeric; rollup-of-rollup is not supported to avoid loops.
  - Formula properties compute values from existing properties, built-ins/operators, and functions. Formula editor exposes available properties/functions, type expectations, live preview, and AI assistance.
  - Formula examples show formulas can access relation/list properties (`Tasks.length()`, `Parent Task.Sub-item.every(...)`) and be used inside database automations.
- **Reliability:** High for product semantics; formula runtime and dependency graph internals are not public.
- **Helps answer:** What relational/computed-data behavior should a clone support beyond simple table columns?

### [Sharing and permissions](https://www.notion.com/help/sharing-and-permissions)

- **Source type:** Official Help Center/product documentation; product/security semantics.
- **Relevant topics:** Permissions, inheritance, database content editing, page-level access rules.
- **Key claims/details:**
  - Page sharing supports invited users/groups/teamspaces, workspace-wide access, web links, guests, and publish-to-web.
  - Permission levels include `Full access`, `Can edit`, `Can edit content`, `Can comment`, and `Can view`.
  - `Can edit content` is specific to database pages: users can create/edit/delete pages and property values, but cannot modify database properties/views/sorts/filters or lock state.
  - Database page-level access can grant permissions based on person or created-by properties; rules apply across views and linked views.
  - If a user does not have access to the database but gets access to a page via page-level rule, they can access that page through notification or a linked view but cannot create new pages.
  - Notion respects the broadest level of access given through any route.
  - Subpages inherit parent-page permissions by default; teamspaces can define default permissions for new content.
- **Reliability:** High for product behavior. Internal ACL storage, caching, evaluation, and edge-case conflict resolution remain unpublished.
- **Helps answer:** How should a clone combine page-tree inheritance, database-specific roles, row/page-level rules, and “broadest access wins” behavior?

## Credible third-party / interview sources

### [How Notion Runs PostgreSQL at Scale on Amazon RDS with pganalyze](https://pganalyze.com/blog/how-notion-runs-postgres-at-scale)

- **Source type:** Vendor case study/interview with Notion engineers; secondary but high-signal.
- **Relevant topics:** Postgres operations, observability, query/index tuning, production scaling practices.
- **Key claims/details:**
  - Notion used a single large PostgreSQL database on Amazon RDS from 2015-2020, then sharded core data in early 2021.
  - Quotes Notion engineering manager Arka Ganguli and engineer Ben Hughes on visibility gaps, vacuum/debugging issues, query spikes, and pganalyze as first-line DB diagnosis.
  - Describes a GIN index optimization on `space_id`/`permission` JSON filtering using `jsonb_path_ops`, improving one query from ~5000ms to ~600ms.
  - Describes limiting query clause counts to avoid full table scans on a 1TB table during pre-production testing.
  - Notes pganalyze was used during the 32-to-96 database migration to compare query behavior across shards.
- **Reliability:** Medium-high. It contains named Notion engineer quotes and aligns with official sharding posts, but is a vendor marketing case study and should be cross-checked for exact architecture claims.
- **Helps answer:** What operational tooling and query/index discipline are needed once a clone's flexible schema hits large Postgres scale?

### [First Block: Interview with Ivan Zhao and Simon Last, Co-Founders of Notion](https://www.youtube.com/watch?v=ZMrjvxCIPpY)

- **Source type:** Public founder interview/talk; primary for product philosophy, not implementation.
- **Relevant topics:** Origin story, product philosophy, “building blocks” framing, user empowerment.
- **Key claims/details:**
  - Use as context for why Notion prioritizes composable building blocks and end-user customization.
  - Public video pages are harder to use as engineering evidence without a transcript; extract exact quotes separately before relying on them.
- **Reliability:** Medium for product intent; low for internal architecture unless exact transcript/quotes are verified.
- **Helps answer:** What user-centered philosophy should guide tradeoffs when cloning Notion-like primitives?

### [Ivan Zhao on Notion and AI as a New Material | Reid Hoffman](https://www.youtube.com/watch?v=duivtwy0TS0)

- **Source type:** Public interview/talk; primary for product/AI philosophy, not editor implementation.
- **Relevant topics:** Product direction, AI as a material in workspace tools, flexible workflows.
- **Key claims/details:**
  - Useful for understanding where Notion's block/data model is headed as AI agents and generated workflows become part of the workspace.
  - Do not infer low-level editor or storage implementation from this source without corroborating official engineering docs.
- **Reliability:** Medium for strategy and vision; low for architecture.
- **Helps answer:** How might a clone's model need to support AI-generated pages, automations, and agent workflows later?

## Sources intentionally not treated as authoritative

Several search results surfaced system-design blogs, AI-generated “how Notion was built” articles, and generic tech-stack pages. These can be useful as prompts for follow-up questions, but they often speculate about React/Redux/Node/Redis/CRDT/OT details without citations. This index avoids using them as evidence unless their claims are independently supported by official Notion docs/blogs or named Notion engineer interviews.

## Open questions / gaps

- **Internal editor framework is not public.** Official sources say pages render with React, but do not disclose whether the editor core uses a custom engine, ProseMirror/Lexical/Slate-like abstractions, a custom selection model, or how IME, clipboard, undo/redo, drag/drop, and cross-block selections are implemented.
- **CRDT details are missing.** Offline mode discloses dynamic migration to a CRDT data model for offline pages, but not the CRDT library/algorithm, operation format, rich-text span representation, merge semantics, tombstone/compaction strategy, or interaction with legacy transaction records.
- **Public API is a projection, not the internal schema.** The 2021 blog describes internal `properties.title`, `content` arrays, `saveTransactions`, `loadPageChunk`, `syncRecordValues`, and `MessageStore`; the public API exposes type-specific block objects, rich text arrays, databases/data sources/views, and webhooks. The mapping is incomplete and version-dependent.
- **Terminology changed over time.** Official engineering posts use “collections” and the 2021 block model; current API/help docs use databases, data sources, views, and `2025-09-03` multi-source semantics. A clone design must choose a clean internal model and provide migration/versioning boundaries.
- **Permissions are only partially specified.** Public docs reveal parent-pointer permission inheritance, broadest-access behavior, database-specific `Can edit content`, and page-level rules via person properties, but not the exact ACL graph, caching strategy, evaluation order, or how permission snapshots are denormalized for search/AI.
- **Database internals are not public.** Sources describe pages-as-rows, schemas/properties, relations, rollups, formulas, filters, sorts, and views, but not storage layout for property values, indexing strategy per property type, formula dependency graph, rollup recomputation, query planner, or consistency guarantees.
- **Real-time protocol details are insufficient.** MessageStore/WebSocket/version notifications are disclosed at a conceptual level, but not message formats, subscription granularity, ordering/idempotency guarantees, presence/cursor handling, conflict resolution for concurrent online edits, or backpressure behavior.
- **Offline dependency closure is not fully specified.** The offline blog discloses `offline_page`/`offline_action` concepts, but not the full algorithm for discovering “all records required to render,” handling embeds/files/relations/rollups/formulas, or bounding storage for very large workspaces.
- **Search and AI-serving architecture is only indirectly revealed.** Data-lake docs explain offline denormalization and permission traversal, but not the online Quick Find/indexing architecture, vector database details, freshness SLAs, or how search results remain permission-safe.
- **Page export/import and interoperability need more research.** Public API docs do not cover all Notion export formats, Markdown/HTML import behavior, copy-paste fidelity, synced blocks, templates/buttons/automations, or unsupported product-only blocks in enough depth for clone parity.
- **API docs can shift quickly.** Current docs mention API versions through `2026-03-11` and new data-source/view/webhook features. Any implementation work should pin the API version used for tests and archive observed schemas.

## Research directions for follow-up

1. **Build a behavior matrix from live product experiments.** Create pages with every block type, nesting pattern, database view, relation, rollup, formula, permission rule, and offline setting; record observable UX and public API/export output.
2. **Prototype a minimal block store.** Model blocks with `id`, `type`, type-independent properties, ordered child pointers, and separate parent/permission pointers; test structural indentation, transform-preserve-properties, and page-as-block navigation.
3. **Design transaction and sync semantics explicitly.** Compare Notion's disclosed optimistic transaction queue with Yjs/Automerge/Peritext and editor libraries such as ProseMirror, Lexical, and Slate; decide where CRDTs apply (rich text only vs all block operations).
4. **Define a local-first storage layer.** Evaluate SQLite on native, OPFS/WASM SQLite in browser, SharedWorker/Web Worker routing, cache-vs-network racing, and durable offline metadata similar to `offline_page`/`offline_action`.
5. **Specify database-as-pages architecture.** Model data sources, schemas/properties, page property values, views, filters/sorts/groups, linked views, formulas, rollups, and relations as first-class records rather than bolting tables onto documents.
6. **Develop a permission model early.** Implement page-tree inheritance, database role variants, page-level rules, broadest-access resolution, and denormalized permission snapshots for search/indexing; test with linked data sources and subpages.
7. **Separate collaboration sync from integration webhooks.** Use low-latency editor subscriptions for live collaboration and coarse, at-most-once webhooks for external integrations, mirroring the difference between MessageStore-style sync and public webhook events.
8. **Create an API compatibility dossier.** Capture canonical JSON for blocks, pages, rich text, data sources, properties, views, and webhooks; note limits, pagination behavior, unsupported fields, and version-specific differences.
9. **Inventory editor UX commands.** Turn shortcut/slash/help docs into executable acceptance tests for command palette entries, Markdown conversions, block selection/movement, mentions, page linking/creation, mobile editing, and drag/drop.
10. **Plan scale boundaries.** Early clones do not need 480 shards, but should preserve workspace locality and avoid cross-workspace transactions so later Postgres sharding/data-lake/search denormalization remains possible.
