# Notion API Representation: Public API as a Content/Data Model Lens

## Scope

This document studies the Notion public REST API as a developer-facing representation of Notion's editor architecture and data model, with emphasis on what a future Notion-like clone can learn from the API surface. It covers the current API object model, content and data endpoints, files, comments, search, pagination, errors, versioning, capabilities/scopes, rate limits, webhooks, and documented limitations. The API is not a full dump of Notion's internal editor/runtime model; it is a stable integration contract that exposes selected persisted objects and hides real-time editing, transactions, and permission internals.

Primary sources are Notion's current developer docs and SDK repository. Notion's latest documented REST API version is `2026-03-11`, and every request must include a `Notion-Version` header [https://developers.notion.com/reference/versioning.md].

## Object model

### 1. Cross-cutting API conventions

The API is JSON-over-HTTPS at `https://api.notion.com`, uses REST-style `GET`, `POST`, `PATCH`, and `DELETE`, and requires bearer-token authentication plus a `Notion-Version` header [https://developers.notion.com/reference/intro.md][https://developers.notion.com/reference/authentication.md][https://developers.notion.com/reference/versioning.md]. A clone can treat this as a useful external-contract pattern: stable object envelopes, typed payloads, opaque cursors, and backward-compatible additive changes.

Important conventions:

- Top-level resources include an `object` discriminator such as `"page"`, `"block"`, `"database"`, `"data_source"`, `"user"`, `"comment"`, `"view"`, or `"file_upload"` [https://developers.notion.com/reference/intro.md].
- Addressable top-level resources have UUID identifiers; dashes can be omitted in API requests [https://developers.notion.com/reference/intro.md].
- Fields use `snake_case`; timestamps are ISO 8601 strings; empty strings are not accepted for string-like unset values, where explicit `null` is expected [https://developers.notion.com/reference/intro.md].
- Many resources use a type-discriminated nested object pattern: `type: "paragraph"` plus a `paragraph: {...}` field, or `type: "rich_text"` plus a `rich_text: ...` value [https://developers.notion.com/reference/block.md][https://developers.notion.com/reference/rich-text.md].
- Most list endpoints return a common list envelope: `object: "list"`, `results`, `has_more`, `next_cursor`, `type`, and a type-specific empty object or pagination metadata [https://developers.notion.com/reference/intro.md].

Architectural signal: Notion's public model is strongly discriminated and mostly denormalized at API boundaries. IDs are stable; cursors and ordering details are intentionally opaque [https://developers.notion.com/reference/versioning.md].

### 2. Users and bots

`user` objects represent people, guests, and connections/bots [https://developers.notion.com/reference/user.md]. User objects appear as `created_by` and `last_edited_by` on blocks, pages, databases, and data sources; in people properties; and as rich text user mentions [https://developers.notion.com/reference/user.md]. Every user contains at least `object: "user"` and `id`; fields such as `type`, `name`, `avatar_url`, and `person.email` depend on context and user-information capabilities [https://developers.notion.com/reference/user.md][https://developers.notion.com/reference/capabilities.md]. Bot users have `type: "bot"` and may include an owner, workspace name, workspace ID, and workspace limits such as `max_file_upload_size_in_bytes` [https://developers.notion.com/reference/user.md].

Clone implication: model actors as first-class identities, but separate stable actor IDs from displayable profile data. Profile fields should be permission/capability filtered, because the same reference may be full or partial depending on the caller.

### 3. Pages

A `page` is a hybrid object: it is both a document-like block container and a row-like record with properties. The page object includes `object`, `id`, `created_time`, `last_edited_time`, `created_by`, `last_edited_by`, `cover`, `icon`, `parent`, `in_trash`, `properties`, `url`, and `public_url` [https://developers.notion.com/reference/page.md]. Current OpenAPI schemas also expose `is_archived` and `is_locked` in page responses [https://developers.notion.com/reference/retrieve-a-page.md].

The key split is explicit in the docs: retrieving a page returns page properties, not page body content; body content is retrieved through block children using the page ID as a `block_id` [https://developers.notion.com/reference/retrieve-a-page.md][https://developers.notion.com/guides/data-apis/working-with-page-content.md]. A page outside a data source has only a title property; a page inside a data source has properties matching the parent data source schema [https://developers.notion.com/reference/page-property-values.md][https://developers.notion.com/reference/post-page.md].

Clone implication: pages should not be a monolithic document blob. Use a page metadata/property record plus a child-block tree. Treat page title as both a property and the display label used by page references.

### 4. Blocks

A `block` represents a piece of page content. Common fields include `object: "block"`, `id`, `parent`, `type`, `created_time`, `created_by`, `last_edited_time`, `last_edited_by`, `in_trash`, `archived` as a deprecated alias, `has_children`, and a nested type-specific object keyed by `type` [https://developers.notion.com/reference/block.md]. Supported block types include paragraphs, headings, list items, to-dos, toggles, callouts, quotes, tables, columns, child pages, child databases, synced blocks, equations, code, bookmarks, embeds, link previews, media blocks, table of contents, meeting notes/transcription, and `unsupported` [https://developers.notion.com/reference/block.md].

Not all blocks support children. The docs enumerate child-capable block types such as paragraphs, list items, toggles, callouts, columns, tables, templates, synced blocks, child pages/databases, and toggleable headings [https://developers.notion.com/reference/block.md]. `has_children` tells clients whether to recursively fetch nested blocks; list endpoints return only one level at a time [https://developers.notion.com/reference/get-block-children.md][https://developers.notion.com/guides/data-apis/working-with-page-content.md].

Architectural signals:

- A page is a special kind of block container: page IDs can be passed where a `block_id` is expected for child listing/appending [https://developers.notion.com/guides/data-apis/working-with-page-content.md].
- Notion's block tree is parent-linked and lazily traversed. `has_children` prevents clients from needing full child arrays in every object [https://developers.notion.com/reference/block.md].
- Unsupported blocks are preserved behind an `unsupported` type rather than forcing lossy conversion [https://developers.notion.com/reference/block.md][https://developers.notion.com/guides/data-apis/working-with-page-content.md].

Clone implication: implement block content as typed nodes in a tree, with per-type payloads and a generic envelope. Make unknown or future block types survivable.

### 5. Databases, data sources, rows, and views

The current API distinguishes a database container from its data sources. A `database` contains one or more `data_sources`; it owns sharing/permissions for its data source children, can be inline or full-page, and has metadata such as title, description, icon, cover, parent, `in_trash`, and `public_url` [https://developers.notion.com/reference/database.md]. A `data_source` is the table-like collection under a database. It contains its own `properties` schema, `parent` database, `database_parent` grandparent, timestamps, title, description, icon, and `in_trash` [https://developers.notion.com/reference/data-source.md].

As of API version `2025-09-03`, Notion introduced APIs for creating, retrieving, updating, and querying data sources [https://developers.notion.com/reference/data-source.md]. The changes-by-version page says `/v1/databases` was reorganized into `/v1/data_sources` for individual data-source management and `/v1/databases` for the database container; this supports multi-source databases [https://developers.notion.com/reference/changes-by-version.md]. Parent rules were updated so pages in tabular collections are parented by data sources, not directly by databases in the latest model [https://developers.notion.com/reference/parent-object.md].

Views are now first-class resources in current docs. A `view` defines how pages in a data source are filtered, sorted, and displayed inside a database. Supported view types include `table`, `board`, `calendar`, `timeline`, `gallery`, `list`, `form`, `chart`, `map`, and `dashboard` [https://developers.notion.com/reference/view.md]. View objects include `parent`, `data_source_id`, `name`, `type`, `filter`, `sorts`, `configuration`, timestamps, URL, and dashboard relationships [https://developers.notion.com/reference/view.md]. The Views API requires `2025-09-03` or later [https://developers.notion.com/guides/data-apis/working-with-views.md].

Clone implication: do not collapse "database" into "table." A robust clone can separate:

1. database/container/permission object,
2. data source/table/schema object,
3. page rows as records/documents,
4. views as saved presentation/query presets.

This separation is especially useful for linked views, dashboards, and future multi-source containers.

### 6. Properties, property schemas, and property items

Data source properties define schema. Each property object includes `id`, `name`, `description`, `type`, and a nested type-specific config object [https://developers.notion.com/reference/property-object.md]. Types include `checkbox`, `created_by`, `created_time`, `date`, `email`, `files`, `formula`, `last_edited_by`, `last_edited_time`, `multi_select`, `number`, `people`, `phone_number`, `place`, `relation`, `rollup`, `rich_text`, `select`, `status`, `title`, `unique_id`, and `url` [https://developers.notion.com/reference/property-object.md]. Some types are configuration-light (`checkbox`, `date`, `files`, `people`); others have schema-level details such as select options, number formats, formula expressions, relation settings, and rollup definitions [https://developers.notion.com/reference/property-object.md].

Page property values are values stored on individual pages/rows. They include `id`, `type`, and a nested type-specific value [https://developers.notion.com/reference/page-property-values.md]. Notion emphasizes that property IDs are stable across property renames and can be used in place of names when creating or updating pages [https://developers.notion.com/reference/page-property-values.md]. Property IDs are URL-encoded and newer ones may be short random strings rather than UUIDs [https://developers.notion.com/reference/page-property-values.md].

The `property_item` object is the endpoint-specific representation returned by `GET /v1/pages/{page_id}/properties/{property_id}`. It exposes `object: "property_item"`, `id`, `type`, and the type-specific value [https://developers.notion.com/reference/property-item-object.md]. For `title`, `rich_text`, `relation`, and `people`, the response can be a paginated list of property-item values with `next_url`; this is necessary because `Retrieve a page` truncates some properties after 25 references [https://developers.notion.com/reference/retrieve-a-page-property.md][https://developers.notion.com/reference/retrieve-a-page.md]. Rollups may require pagination before the final aggregation value is known, and some aggregations (`show_unique`, `unique`, `median`) are not computed by this endpoint [https://developers.notion.com/reference/retrieve-a-page-property.md].

Clone implication: model schema separately from values. Use stable property IDs as the primary key and human names as mutable labels. For large multi-valued properties, use separate relation/value tables and paginated property retrieval rather than embedding everything in page records.

### 7. Rich text, mentions, and equations

Rich text is a reusable inline-content model used by block payloads, page properties, comments, titles, descriptions, and captions [https://developers.notion.com/reference/rich-text.md]. A rich text object has `type` (`text`, `mention`, or `equation`), a type-specific object, `annotations`, `plain_text`, and optional `href` [https://developers.notion.com/reference/rich-text.md]. Annotations include bold, italic, strikethrough, underline, code, and color/background values [https://developers.notion.com/reference/rich-text.md].

`text` rich text has `content` and optional link URL. Inline `equation` rich text stores a LaTeX/KaTeX expression [https://developers.notion.com/reference/rich-text.md]. `mention` rich text can reference databases, dates, link previews, pages, template mentions, or users [https://developers.notion.com/reference/rich-text.md]. If a connection lacks access to a mentioned page or database, Notion may return only the ID with `plain_text` as `"Untitled"` and default annotations [https://developers.notion.com/reference/rich-text.md].

Clone implication: inline content is not just text-plus-marks. Mentions are typed references with permission-filtered rendering, and equations are inline semantic nodes. Store rich text as a list of typed spans, not a single HTML string, if you want reliable transformations and API compatibility.

### 8. Files and file uploads

Notion represents media assets with `file` objects. The three current file object types are:

- `file`: Notion-hosted UI uploads, returned with a temporary URL and `expiry_time`; docs say these URLs are valid for one hour and should not be cached as stable references [https://developers.notion.com/reference/file-object.md].
- `file_upload`: files uploaded through the Notion API; after upload, reference the upload ID inside a file object to attach it to blocks, pages, databases, or comments [https://developers.notion.com/reference/file-object.md][https://developers.notion.com/reference/file-upload.md].
- `external`: externally hosted public HTTPS URL returned as-is [https://developers.notion.com/reference/file-object.md].

The File Upload object tracks upload lifecycle with `object: "file_upload"`, `id`, timestamps, `expiry_time`, `status` (`pending`, `uploaded`, `expired`, `failed`), filename, content type, content length, and upload/complete URLs where relevant [https://developers.notion.com/reference/file-upload.md]. File upload creation supports `single_part`, `multi_part`, and `external_url`; multi-part is recommended for files larger than 20 MB, and `external_url` imports a publicly accessible file into the workspace [https://developers.notion.com/reference/create-file.md]. Sending file content uses multipart form data at `/v1/file_uploads/{file_upload_id}/send`; multi-part uploads include `part_number` and may send parts concurrently within normal rate limits before completion [https://developers.notion.com/reference/upload-file.md]. File uploads can also be listed by status for the current bot connection [https://developers.notion.com/reference/list-file-uploads.md].

Clone implication: separate asset metadata from attachment references. Use expiring access URLs for hosted private files, stable upload IDs for attachment, and distinguish imported external files from external links.

### 9. Comments

A `comment` has `object`, `id`, `parent`, `discussion_id`, timestamps, `created_by`, `rich_text`, optional `attachments`, and `display_name` [https://developers.notion.com/reference/comment-object.md]. Comments can be parented by pages or blocks [https://developers.notion.com/reference/comment-object.md]. Listing comments returns unresolved comments for a page or block, sorted ascending chronologically and paginated [https://developers.notion.com/reference/comment-object.md][https://developers.notion.com/reference/list-comments.md]. Creating comments supports three locations: a page, a block, or an existing discussion thread; inline comments cannot start a new discussion thread through the public API [https://developers.notion.com/reference/create-a-comment.md]. Comment bodies can be rich text or Markdown, but exactly one must be supplied [https://developers.notion.com/reference/create-a-comment.md]. Comments can include up to three file-upload attachments in the create-comment request [https://developers.notion.com/reference/create-a-comment.md].

Clone implication: comments should be a separate discussion layer over pages/blocks, not embedded directly in document content. Discussion-thread IDs allow replies and mutation independently of block content.

### 10. Parent objects and hierarchy

Parent objects provide a common location model across pages, databases, data sources, comments, and blocks [https://developers.notion.com/reference/parent-object.md]. Current documented parent types include:

- `database_id`: most common as a data source's parent database [https://developers.notion.com/reference/parent-object.md].
- `data_source_id`: most common as a page's parent in current API versions; includes the parent database ID for convenience [https://developers.notion.com/reference/parent-object.md].
- `page_id`: page parent [https://developers.notion.com/reference/parent-object.md].
- `workspace`: top-level workspace parent for pages/databases [https://developers.notion.com/reference/parent-object.md].
- `block_id`: parent block [https://developers.notion.com/reference/parent-object.md].

The docs note exceptions: creating resources through the public REST API may have stricter parent rules than retrieval, and linked/external data sources are not thoroughly supported [https://developers.notion.com/reference/parent-object.md].

Clone implication: maintain a generic parent edge table with typed parent references. But apply command-specific validation; the set of possible persisted parents can be broader than the set of parents accepted by create/update APIs.

### 11. Search

Search is title-oriented and permission-scoped. `POST /v1/search` searches pages and data sources shared with a connection; it can filter by object (`page` or `data_source`), sort by `last_edited_time`, and paginate [https://developers.notion.com/reference/post-search.md]. Notion explicitly warns that searching a specific data source should be done through `Query a data source`, not global search [https://developers.notion.com/reference/post-search.md]. Search is optimized for pages/databases by name, not exhaustive workspace enumeration, not within-database filtering, and not immediate/complete indexing [https://developers.notion.com/reference/search-optimizations-and-limitations.md].

Clone implication: global search should be eventually consistent and explicitly separate from structured data-source queries. If a clone needs audit-grade sync, search is the wrong primitive.

### 12. Pagination

Paginated endpoints use `start_cursor` and `page_size`, with default/max page sizes documented in the intro. The common response includes `has_more` and `next_cursor`; clients must treat cursors as opaque [https://developers.notion.com/reference/intro.md][https://developers.notion.com/reference/versioning.md]. The SDK exposes `iteratePaginatedAPI` and `collectPaginatedAPI` helpers [https://raw.githubusercontent.com/makenotion/notion-sdk-js/main/README.md]. Data source queries can paginate up to 10,000 results per query; Notion recommends filters and webhooks for incremental sync of large sources [https://developers.notion.com/reference/query-a-data-source.md].

Clone implication: pagination is not only an API ergonomic feature; it reflects storage/query boundaries. Design cursor semantics as opaque contracts and expose incremental-sync alternatives for large datasets.

### 13. Errors

Error responses use HTTP status plus JSON `code` and `message`; some include `additional_data` [https://developers.notion.com/reference/status-codes.md]. Stable codes include `invalid_json`, `invalid_request_url`, `invalid_request`, `validation_error`, `missing_version`, `unauthorized`, `restricted_resource`, `object_not_found`, `conflict_error`, `rate_limited`, `internal_server_error`, `bad_gateway`, `service_unavailable`, `database_connection_unavailable`, and `gateway_timeout` [https://developers.notion.com/reference/status-codes.md]. `object_not_found` can mean either the object does not exist or it is not shared with the connection [https://developers.notion.com/reference/status-codes.md]. Data source query can return `503` with `additional_data` retry guidance, such as exponential backoff, reducing `page_size`, or narrowing filters/sorts [https://developers.notion.com/reference/query-a-data-source.md].

Clone implication: keep machine-readable error codes stable even if human messages change. Avoid leaking authorization state by returning the same not-found shape for absent and inaccessible resources.

### 14. Versioning, capabilities/scopes, and rate limits

The API is date-versioned; backwards-incompatible changes require new versions, while additive fields/endpoints do not [https://developers.notion.com/reference/versioning.md]. `2026-03-11` replaced the append-block `after` parameter with `position`, removed `archived` in favor of `in_trash`, and renamed the `transcription` block type to `meeting_notes` [https://developers.notion.com/reference/changes-by-version.md]. `2025-09-03` reorganized databases/data sources and introduced data source IDs [https://developers.notion.com/reference/changes-by-version.md]. The versioning docs instruct clients to handle additive changes, opaque identifier/cursor format changes, reworded messages, rate-limit changes, and performance/ordering improvements without breaking [https://developers.notion.com/reference/versioning.md].

Authorization comes in two broad modes: internal connections use a static installation access token; public connections use OAuth 2.0 [https://developers.notion.com/guides/get-started/authorization.md]. Public OAuth tokens can be introspected for `active`, `scope`, and issue time (`iat`) [https://developers.notion.com/reference/introspect-token.md]. Separately, Notion exposes connection capabilities: read/update/insert content, read/insert comments, and levels of user information including no user info, user info without email, and user info with email [https://developers.notion.com/reference/capabilities.md]. Capabilities cannot exceed the sharing/permissions of the authorizing user or shared page; a page/database must be shared with the connection for access [https://developers.notion.com/guides/get-started/authorization.md][https://developers.notion.com/reference/capabilities.md].

Rate limits are per connection, averaging three requests per second, with some bursts allowed. `429 rate_limited` responses include a `Retry-After` header in seconds, and Notion warns limits may change [https://developers.notion.com/reference/request-limits.md]. Request size limits include 1000 block elements and 500 KB overall, rich text text/link limits of 2000 characters, equation expressions of 1000 characters, arrays of block/rich text values of 100 elements, URLs of 2000 characters, emails/phones of 200 characters, multi-select of 100 options, relation of 100 related pages, and people of 100 users [https://developers.notion.com/reference/request-limits.md].

Clone implication: date-version public APIs are easier for integrations than semantic endpoint version paths. Capabilities should be product-level grants layered with object sharing and user access. Rate limits should be documented as adaptive rather than hard-coded forever.

### 15. Webhooks

Notion now documents connection webhooks. A webhook subscription is configured in connection settings, verified by a `verification_token`, and can validate payloads with an `X-Notion-Signature` HMAC-SHA256 signature over the request body using the verification token [https://developers.notion.com/reference/webhooks.md]. Webhooks send events for workspace activity instead of requiring polling [https://developers.notion.com/reference/webhooks.md].

Event payloads share fields such as `id`, `timestamp`, `workspace_id`, `subscription_id`, `integration_id`, `type`, `authors`, `accessible_by` for public connections, `attempt_number`, `entity`, and event-specific `data` [https://developers.notion.com/reference/webhooks-events-delivery.md]. Supported event types include page events (`page.content_updated`, `page.created`, `page.deleted`, `page.locked`, `page.moved`, `page.properties_updated`, `page.undeleted`, `page.unlocked`), database events, data source events introduced in `2025-09-03`, and comment events (`comment.created`, `comment.deleted`, `comment.updated`) [https://developers.notion.com/reference/webhooks-events-delivery.md]. Many page/database/data-source events are aggregated; delivery is usually within a minute and should be within five minutes, ordering is not guaranteed, and events are signals rather than full-content deltas [https://developers.notion.com/reference/webhooks-events-delivery.md]. Notion says to fetch the latest data from the API after receiving an event [https://developers.notion.com/reference/webhooks-events-delivery.md].

Clone implication: webhooks should be invalidation/sync signals, not a public CRDT/changefeed unless the product explicitly exposes operation-level deltas.

## Endpoint semantics and editor-operation mapping

### Block/content operations

- **Retrieve a block**: `GET /v1/blocks/{block_id}` returns a block by ID. If `has_children` is true, use `GET /children` to list them. A page ID can be used as a block ID when reading page content [https://developers.notion.com/reference/retrieve-a-block.md][https://developers.notion.com/guides/data-apis/working-with-page-content.md].
- **List block children**: `GET /v1/blocks/{block_id}/children` returns only the first level of child blocks, paginated. Full page export requires recursive traversal of children with `has_children: true` [https://developers.notion.com/reference/get-block-children.md].
- **Append block children**: `PATCH /v1/blocks/{block_id}/children` creates new child blocks under a block/page/database. It returns a paginated list of newly created first-level children. Existing blocks cannot be moved with this endpoint, and once a block is appended it cannot be moved elsewhere via the API. A single request can append at most 100 block children and can nest up to two levels for child-supporting blocks [https://developers.notion.com/reference/patch-block-children.md]. Current versions use a `position` object (`end`, `start`, or `after_block`) instead of deprecated `after` [https://developers.notion.com/reference/patch-block-children.md][https://developers.notion.com/reference/changes-by-version.md].
- **Update a block**: `PATCH /v1/blocks/{block_id}` updates fields supported by the block type. Omitted fields are left unchanged, but any provided field replaces the entire value for that field. Children cannot be directly updated here; use append for adding children. `child_page` and `child_database` display text is updated through page/database update endpoints [https://developers.notion.com/reference/update-a-block.md].
- **Delete a block**: `DELETE /v1/blocks/{block_id}` sets `in_trash: true`, moving the block to Trash. Restore uses update-block or update-page depending on resource type [https://developers.notion.com/reference/delete-a-block.md].

What this maps to in editor terms: the public API supports reading a block tree, appending new nodes, replacing editable fields on a node, soft-deleting/restoring nodes, and inserting new nodes at coarse positions. It does not expose arbitrary move, reparent, multi-block transactions, fine-grained text edits, selection/cursor operations, or collaborative operation logs.

### Page operations

- **Create page**: `POST /v1/pages` creates a page under a page, data source, or, for public connection bots, workspace-level private context. Pages under a page only accept title properties; pages under a data source must match the data source schema. The endpoint can also accept initial block `children`, a `template`, or current enhanced `markdown` content depending on mode [https://developers.notion.com/reference/post-page.md][https://developers.notion.com/guides/data-apis/working-with-markdown-content.md].
- **Retrieve page**: `GET /v1/pages/{page_id}` returns metadata and page properties, not page body blocks. It can filter returned properties. It truncates some reference-heavy properties after 25 references, so complete values require page-property retrieval [https://developers.notion.com/reference/retrieve-a-page.md].
- **Update page**: `PATCH /v1/pages/{page_id}` modifies properties, icon, cover, `in_trash`, `is_locked`, or applies a template. It can erase content, but adding content is through append-block-children. Rollup property values cannot be directly updated, and a page's parent cannot be changed through this endpoint [https://developers.notion.com/reference/patch-page.md].
- **Move page**: the docs index includes `Move a page`, indicating current API support for moving pages to a new parent [https://developers.notion.com/llms.txt]. This is notable because block move remains explicitly unavailable through append-block-children [https://developers.notion.com/reference/patch-block-children.md].
- **Markdown content endpoints**: `GET /v1/pages/{page_id}/markdown` retrieves full content as enhanced Markdown, and `PATCH /v1/pages/{page_id}/markdown` can update content using search-and-replace or replace-all commands. These endpoints target agentic/developer workflows and include `truncated` and `unknown_block_ids` for large or inaccessible content [https://developers.notion.com/reference/retrieve-page-markdown.md][https://developers.notion.com/reference/update-page-markdown.md][https://developers.notion.com/guides/data-apis/working-with-markdown-content.md].

What this maps to in editor terms: page metadata/properties are separate from page content. Public APIs can create/update row metadata and append/replace content, but page content editing is not exposed as the same low-level operational transform/CRDT stream used by the live editor.

### Database/data-source/query/view operations

- **Retrieve database** returns the database container, including the list of child data sources by ID/name [https://developers.notion.com/reference/database.md].
- **Retrieve data source** returns the data source schema and metadata [https://developers.notion.com/reference/data-source.md].
- **Query a data source**: `POST /v1/data_sources/{data_source_id}/query` returns pages (and for wikis, data sources) filtered and sorted by data-source properties or timestamps. Filters compose with `and`/`or`; sorts are ordered by precedence. `filter_properties` can shrink returned page schemas for performance [https://developers.notion.com/reference/query-a-data-source.md].
- **Update data source properties** updates schema columns, while update-page changes row values [https://developers.notion.com/reference/update-data-source-properties.md][https://developers.notion.com/reference/patch-page.md].
- **Views**: list/retrieve/create/update/delete view endpoints expose saved view presets and query-through-view APIs. Current view docs include filters, sorts, quick filters, and layout configuration [https://developers.notion.com/reference/view.md][https://developers.notion.com/guides/data-apis/working-with-views.md].

What this maps to in editor terms: Notion's databases are not merely tables in the page tree. They are schema-bound page collections, with views as derived presentation/query state. The API exposes filters/sorts/schemas but not all internal indexing, formula evaluation details, or UI runtime behavior.

### Property pagination

- `Retrieve a page` is convenient but bounded; it returns at most 25 references for people, relation, rich_text/title inline mentions, and may show incomplete or placeholder values [https://developers.notion.com/reference/retrieve-a-page.md].
- `Retrieve a page property item` is the accuracy path for large properties and certain computed properties; it returns either a single `property_item` or a paginated list for title/rich_text/relation/people [https://developers.notion.com/reference/retrieve-a-page-property.md][https://developers.notion.com/reference/property-item-object.md].
- For large rollups, interim pages of results may include aggregation values computed only for the subset traversed so far; the final value is reliable when `has_more` is false [https://developers.notion.com/reference/retrieve-a-page-property.md].

Clone operation mapping: expose fast page summary retrieval separately from complete property-value retrieval. This lets common views stay cheap while long relations/mentions remain accessible.

### Comments

- **List comments**: `GET /v1/comments?block_id=...` retrieves unresolved comments for a page/block with pagination and requires read-comment capabilities [https://developers.notion.com/reference/list-comments.md].
- **Create comment**: `POST /v1/comments` creates a page/block comment or replies to an existing discussion thread. It supports rich text or Markdown bodies, file upload attachments, and display-name options; starting inline comment threads via the public API is not supported [https://developers.notion.com/reference/create-a-comment.md].
- Current docs also include retrieve/update/delete comment endpoints [https://developers.notion.com/llms.txt].

Clone operation mapping: comments are addressable collaboration artifacts linked to page/block parents, not block-tree children. This is a clean design for moderation, notifications, and separate permissions/capabilities.

### Files and hosted media

- **Create file upload**: `POST /v1/file_uploads` creates a pending file upload in `single_part`, `multi_part`, or `external_url` mode [https://developers.notion.com/reference/create-file.md].
- **Send file upload**: `POST /v1/file_uploads/{file_upload_id}/send` uploads bytes as multipart form data. Multi-part sends use `part_number` [https://developers.notion.com/reference/upload-file.md].
- **Complete file upload** finalizes multi-part uploads; the docs index includes this endpoint [https://developers.notion.com/llms.txt].
- **Attach file**: once status is `uploaded`, clients reference the file upload ID inside a `file_upload` file object on a block, page icon/cover, database property, or comment attachment [https://developers.notion.com/reference/file-upload.md][https://developers.notion.com/reference/file-object.md].
- **Retrieve existing hosted files**: existing UI-hosted files return expiring URLs; clients must re-fetch to refresh [https://developers.notion.com/reference/file-object.md].

Clone operation mapping: file upload is a lifecycle separate from content mutation. A clone should avoid accepting raw bytes inside generic block/page updates; instead use an upload session and attach by ID.

## What the API reveals about architecture

1. **Everything important has an object discriminator and ID.** Blocks, pages, databases, data sources, views, comments, users, and file uploads are addressable or referential objects with type-discriminated payloads [https://developers.notion.com/reference/intro.md].
2. **The document model is a typed tree.** Blocks have parents, `has_children`, and type-specific payloads; page content is fetched as child blocks and recursively traversed [https://developers.notion.com/reference/block.md][https://developers.notion.com/reference/get-block-children.md].
3. **Pages are both documents and records.** A page owns content blocks but also participates as a row in a data source with schema-constrained properties [https://developers.notion.com/reference/page.md][https://developers.notion.com/reference/page-property-values.md].
4. **Schemas and values are separate.** Data source properties define schema; page properties/property items store row values [https://developers.notion.com/reference/property-object.md][https://developers.notion.com/reference/page-property-values.md].
5. **Databases are containers; data sources are collections.** Current docs split database-level permission/container metadata from data-source schemas and rows [https://developers.notion.com/reference/database.md][https://developers.notion.com/reference/data-source.md].
6. **View state is separate from data.** View objects store filters, sorts, display types, and configuration [https://developers.notion.com/reference/view.md].
7. **Soft deletion is first-class.** `in_trash` appears across blocks, pages, databases, and data sources; `archived` is deprecated/removed in current versioning [https://developers.notion.com/reference/block.md][https://developers.notion.com/reference/changes-by-version.md].
8. **Timestamps and actor references are persisted metadata.** Common resources track creation/edit times and actors [https://developers.notion.com/reference/page.md][https://developers.notion.com/reference/block.md][https://developers.notion.com/reference/data-source.md].
9. **Permissions shape responses.** Full versus partial user/page/block/data-source responses, inaccessible mentions returning `Untitled`, and 404 for inaccessible resources all reveal response filtering [https://developers.notion.com/reference/user.md][https://developers.notion.com/reference/rich-text.md][https://developers.notion.com/reference/status-codes.md].
10. **Large values are not always embedded.** Property item pagination, block-child pagination, data source query pagination, and markdown `unknown_block_ids` reveal deliberate bounded read surfaces [https://developers.notion.com/reference/retrieve-a-page-property.md][https://developers.notion.com/reference/retrieve-page-markdown.md].
11. **Public sync is pull-after-signal.** Webhooks notify that something changed but do not contain full content deltas; clients fetch latest state via REST [https://developers.notion.com/reference/webhooks-events-delivery.md].

## What the API hides

1. **Ordering internals.** The API lets clients list children and, for append, choose start/end/after-block positions, but it does not reveal the ordering key or sequence CRDT structure used internally [https://developers.notion.com/reference/patch-block-children.md].
2. **Arbitrary block moves/reparenting.** Existing blocks cannot be moved through append-block-children, and block child arrays cannot be directly updated with update-block [https://developers.notion.com/reference/patch-block-children.md][https://developers.notion.com/reference/update-a-block.md].
3. **Transactions and atomic multi-object mutations.** The API exposes single-resource operations and returns `409 conflict_error` for data collisions, but not transaction boundaries, revision IDs, compare-and-swap fields, or rollback semantics [https://developers.notion.com/reference/status-codes.md].
4. **Real-time sync/collaboration model.** No public operation log, CRDT, OT, presence, selection, cursor, or live merge model is exposed. Webhooks are aggregated signals with non-guaranteed ordering and are not full deltas [https://developers.notion.com/reference/webhooks-events-delivery.md].
5. **Permission internals.** The API exposes capabilities and filtered errors/responses but not ACL inheritance graphs, group membership internals, policy evaluation, or why an object is inaccessible [https://developers.notion.com/reference/capabilities.md][https://developers.notion.com/reference/status-codes.md].
6. **Formula/rollup engine internals.** Formula expressions and rollup values/configs are exposed, but computation details and some aggregations/large multi-relation results are limited [https://developers.notion.com/reference/property-object.md][https://developers.notion.com/reference/retrieve-a-page-property.md].
7. **Full editor UI state.** Current view APIs expose much more than older API versions, but editor-specific UI states such as user cursor, unsaved edits, panel state, drag/drop state, and possibly some custom app-level presentation details remain outside the REST contract [https://developers.notion.com/reference/view.md].
8. **Search indexing internals.** Search is title-optimized, eventually indexed, and not guaranteed exhaustive; index freshness and ranking internals are hidden [https://developers.notion.com/reference/search-optimizations-and-limitations.md].
9. **Hosted file storage details.** Hosted file URLs are temporary; underlying storage/provider details are abstracted behind file objects and upload sessions [https://developers.notion.com/reference/file-object.md][https://developers.notion.com/reference/file-upload.md].
10. **Unsupported/future block fidelity.** `unsupported` preserves that a block exists but does not expose all internal fields until API support lands [https://developers.notion.com/reference/block.md].

## DX implications

### SDK patterns

The JavaScript SDK (`@notionhq/client`) initializes a `Client` with `auth`, groups all endpoint parameters into one object, and returns Promises [https://raw.githubusercontent.com/makenotion/notion-sdk-js/main/README.md]. Methods mirror API groups such as `notion.blocks.children.list`, `notion.blocks.children.append`, `notion.pages.retrieve`, `notion.dataSources.query`, `notion.comments.create`, `notion.fileUploads.create`, and `notion.views.create` based on examples in docs and SDK README [https://developers.notion.com/reference/get-block-children.md][https://developers.notion.com/reference/patch-block-children.md][https://developers.notion.com/reference/post-search.md][https://raw.githubusercontent.com/makenotion/notion-sdk-js/main/README.md].

The SDK adds developer ergonomics that a clone should copy:

- `baseUrl` is configurable, making mock servers/testing easier [https://raw.githubusercontent.com/makenotion/notion-sdk-js/main/README.md].
- Error handling exposes `APIResponseError`, `APIErrorCode`, `ClientErrorCode`, and `isNotionClientError` for typed handling [https://raw.githubusercontent.com/makenotion/notion-sdk-js/main/README.md].
- Automatic retries cover `rate_limited` and transient server errors, respecting `Retry-After` and using exponential backoff with jitter [https://raw.githubusercontent.com/makenotion/notion-sdk-js/main/README.md].
- Pagination helpers (`iteratePaginatedAPI`, `collectPaginatedAPI`) turn cursor pagination into async iterators or arrays [https://raw.githubusercontent.com/makenotion/notion-sdk-js/main/README.md].
- Type guards distinguish full and partial responses, including full pages, blocks, data sources, users, and comments [https://raw.githubusercontent.com/makenotion/notion-sdk-js/main/README.md].
- A generic `request()` method allows calling newly released endpoints before dedicated SDK methods exist [https://raw.githubusercontent.com/makenotion/notion-sdk-js/main/README.md].

### API versioning ergonomics

Date-versioning is explicit and mandatory. This is good for reproducibility but requires clients to pin and upgrade. The docs warn that additive fields/endpoints can appear without a version bump and clients must be tolerant of new fields, new optional parameters, cursor format changes, error-message text changes, and ordering/performance improvements [https://developers.notion.com/reference/versioning.md].

Clone lesson: provide strict request validation for known fields, but encourage clients to ignore unknown response fields. In generated SDKs, use discriminated unions but keep unknown/future type escapes.

### Pagination ergonomics

Notion's cursor pagination is consistent but labor-intensive when reconstructing full page trees or large property values. Developers must recursively fetch blocks, page through property items, and handle 10,000-result query ceilings [https://developers.notion.com/reference/get-block-children.md][https://developers.notion.com/reference/retrieve-a-page-property.md][https://developers.notion.com/reference/query-a-data-source.md]. The Markdown endpoints are a DX concession for agentic systems, offering a more compact read/update model with `truncated` and `unknown_block_ids` for fallbacks [https://developers.notion.com/guides/data-apis/working-with-markdown-content.md].

Clone lesson: expose both structured block APIs and document-level import/export APIs. Structured APIs preserve fidelity; Markdown APIs improve automation and agent workflows.

### Schema drift

Schema drift is an expected state: users can rename properties, change select/status options, add/delete columns, modify formulas/rollups, and alter view filters/sorts. Stable property IDs reduce rename breakage, but property names are still accepted for convenience [https://developers.notion.com/reference/page-property-values.md][https://developers.notion.com/reference/property-object.md]. Public API version migrations can also rename concepts (`database` rows to `data_source` parents, `transcription` to `meeting_notes`) [https://developers.notion.com/reference/changes-by-version.md].

Clone lesson: integration clients should store property IDs and periodically refresh schema. Tests should include renamed properties, deleted properties, changed select options, large relation sets, and stale local schemas.

### Error handling

Clients should branch on stable error `code`, not message text, because Notion states message wording can change without a version bump [https://developers.notion.com/reference/versioning.md]. `object_not_found` must be treated as either missing or inaccessible [https://developers.notion.com/reference/status-codes.md]. `429` must respect `Retry-After`; `503` for data source query may include endpoint-specific retry guidance [https://developers.notion.com/reference/request-limits.md][https://developers.notion.com/reference/query-a-data-source.md].

Clone lesson: design error objects with stable codes, optional structured `additional_data`, and intentional ambiguity for inaccessible resources.

### Testing and mocking implications for a clone

A credible clone API test suite should include:

- fixtures for full and partial objects (`page`, `block`, `data_source`, `user`, `comment`) to mirror capability/permission filtering;
- recursive block-tree reads with nested child blocks, unsupported blocks, and large paginated pages;
- property pagination for `title`, `rich_text`, `relation`, and `people`, including `next_url` and incomplete rollups;
- schema drift scenarios where property name changes but ID remains stable;
- rate-limit and retry tests for `429` with `Retry-After`, transient `500/503`, and conflict `409`;
- webhook delivery tests with out-of-order, duplicate-ish semantic signals, aggregation delay, failed-attempt retries, and fetch-after-event logic;
- file upload lifecycle tests (`pending`, `uploaded`, `expired`, `failed`), expiring hosted-file URLs, and attachment-by-upload-ID;
- permission tests where inaccessible resources return `object_not_found` and inaccessible mentions degrade to IDs/`Untitled`;
- version-compatibility tests for renamed fields/types such as `archived`/`in_trash` and old database/data-source semantics.

## Clone API design implications

1. **Use typed envelopes everywhere.** A consistent `object`, `id`, `type`, and type-specific nested payload pattern makes clients easier to generate and validate.
2. **Split block content from page properties.** Pages need document content and structured row data; separate endpoints keep both domains clear.
3. **Separate database, data source, and view.** This supports multi-source databases, linked views, dashboards, independent schemas, and permission management.
4. **Make parentage generic but commands specific.** Persist parent edges flexibly, but validate each create/update operation against product rules.
5. **Prefer stable IDs over labels.** Property IDs, view IDs, data source IDs, and block IDs should survive renames and UI changes.
6. **Represent rich text as semantic spans.** Inline mentions/equations/links/annotations should be native typed nodes, not incidental HTML.
7. **Use soft delete with explicit restore paths.** `in_trash`-style semantics help with undo/trash UX and integration safety.
8. **Expose bounded reads plus completeness APIs.** Fast page retrieval can be partial; complete property/block reads need pagination and accurate flags.
9. **Design for future unknowns.** Unknown block types, additive fields, and opaque cursors should not break clients.
10. **Provide both REST state APIs and sync signals.** Webhooks should tell clients what to refetch; do not promise operation-level deltas unless your internal architecture can support it.
11. **Make file upload a first-class lifecycle.** Avoid embedding binaries in content mutations; attach uploaded assets by stable IDs.
12. **Offer SDK affordances early.** Pagination helpers, typed errors, retry controls, configurable base URL, type guards, and generic request support materially improve developer experience.
13. **Document limitations honestly.** Notion's docs call out truncation, unsupported block types, query limits, search inconsistency, and aggregation behavior. A clone should do the same.

## Gaps and limitations to account for

- **No public low-level collaboration model.** The API does not reveal Notion's real-time synchronization algorithm, transaction log, CRDT/OT structures, cursor/presence state, or conflict resolution internals [https://developers.notion.com/reference/webhooks-events-delivery.md].
- **No complete arbitrary editor mutation surface.** You can append and update blocks, but not move existing blocks or directly replace child arrays via update-block [https://developers.notion.com/reference/patch-block-children.md][https://developers.notion.com/reference/update-a-block.md].
- **No guaranteed exhaustive search.** Search is not suitable for complete workspace enumeration or within-database filtering [https://developers.notion.com/reference/search-optimizations-and-limitations.md].
- **Partial reads are common.** Retrieve-page truncates reference-heavy properties, property item rollups can require paging to be final, and markdown output can be truncated or contain unknown blocks [https://developers.notion.com/reference/retrieve-a-page.md][https://developers.notion.com/reference/retrieve-a-page-property.md][https://developers.notion.com/reference/retrieve-page-markdown.md].
- **Permissions are filtered, not fully explained.** Connections see only shared resources and capability-allowed fields; `object_not_found` can hide whether an object exists [https://developers.notion.com/reference/status-codes.md][https://developers.notion.com/reference/capabilities.md].
- **Some resources are version-sensitive.** Data sources and views require understanding post-`2025-09-03` semantics; `2026-03-11` changes block positioning and trash/archive naming [https://developers.notion.com/reference/changes-by-version.md].
- **Ordering and view internals are abstractions.** Views expose filters/sorts/configuration, but internal indexing, layout rendering details, and default ordering when unsorted are not guaranteed [https://developers.notion.com/reference/query-a-data-source.md][https://developers.notion.com/reference/view.md].
- **Rate limits and size limits constrain clone-compatible clients.** Average three requests/second and payload/property limits push clients toward batching, queues, async jobs, and webhooks [https://developers.notion.com/reference/request-limits.md].
- **Webhook events are not state.** Events may aggregate, arrive out of order, be delayed, and require REST refetch for latest content [https://developers.notion.com/reference/webhooks-events-delivery.md].

The strongest architectural takeaway is that Notion's public API exposes a durable object graph and typed content/schema model, not the live editor engine. A clone can emulate the public API with typed resources, parent-child hierarchy, schema/value separation, cursor pagination, capabilities, webhooks, and file-upload lifecycles while independently choosing its internal storage, ordering, transaction, and collaboration mechanisms.
