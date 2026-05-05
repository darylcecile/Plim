# Notion Next block catalog specification

## 1. Scope and conformance

This document is a normative, browser-only TypeScript specification for the block catalog of a Notion-compatible editor. It targets client-side editing, rendering, import/export, drag/drop, accessibility, and local serialization for web apps. It does not design backend services, storage engines, upload infrastructure, or realtime protocols, though it names object references that a client may persist or sync through an application-defined adapter.

The implementation described here is intentionally complete for the public Notion-style authoring surface, not a minimum viable subset. When Notion public API or product behavior leaves internals unknown, this spec defines compatible behavior and labels implementation freedom.

Normative keywords have their RFC-style meanings: **MUST** is required, **SHOULD** is recommended unless a documented product constraint prevents it, and **MAY** is optional.

A conforming implementation MUST:

- Represent page content as a typed tree of addressable blocks with stable IDs, ordered child positions, and type-specific payloads.
- Preserve unknown block types and unknown fields through load/save, copy/paste, undo/redo, and block type transforms whenever possible.
- Use structured rich text for inline text, links, mentions, dates, equations, and annotations; it MUST NOT store editable content only as HTML.
- Validate every editor transaction against the allowed-child table in this document.
- Expose equivalent functionality through keyboard, slash commands, block handles, context menus, and touch-friendly controls where the platform lacks hover.
- Treat database/data-source views as collection widgets over pages/rows, not as simple rich-text tables.

## 2. Compatibility baseline from public Notion behavior

Public Notion docs establish the following compatibility points that this spec adopts:

- Blocks are the atomic content unit. Notion represents paragraphs, images, lists, database rows, and pages as blocks with an ID, type, properties, child content, and parent reference.
- Public Notion API block objects use a common envelope plus `type` and a nested object keyed by that type. Blocks expose `parent`, timestamps, actor metadata, `has_children`, and `in_trash`.
- Public API text-bearing blocks use rich text arrays; rich text supports `text`, `mention`, and `equation` objects, annotations, optional links, and permission-filtered references.
- Public API child retrieval is one level at a time; `has_children` indicates recursion is needed. Existing public APIs expose append/update/trash but not arbitrary low-level editor operations.
- Public API data collections are separated into databases, data sources, pages/rows, properties, and views. Current Notion API versions separate database containers from data-source schemas and view resources.
- Public API exposes or documents these relevant block families: paragraphs, headings, bulleted/numbered lists, to-dos, toggles, quote, callout, divider, child page, child database/database view, columns, simple tables, code, equation, image, video, audio, file, PDF, bookmark, embed, link preview, synced block, template, table of contents, breadcrumb, link to page, and unsupported blocks. Product help also exposes buttons.

Compatibility notes in this spec use `snake_case` Notion-like type names for interoperability. A client MAY keep additional camelCase runtime fields in memory, but serialized interchange SHOULD stay close to the Notion API shape unless the field is explicitly client-only.

## 3. Common block model

### 3.1 TypeScript discriminated union

```ts
export type BlockId = string;
export type PageId = string;
export type DatabaseId = string;
export type DataSourceId = string;
export type ViewId = string;
export type UserId = string;

export type ParentRef =
  | { type: 'page_id'; page_id: PageId }
  | { type: 'block_id'; block_id: BlockId }
  | { type: 'database_id'; database_id: DatabaseId }
  | { type: 'data_source_id'; data_source_id: DataSourceId; database_id?: DatabaseId }
  | { type: 'workspace'; workspace: true };

export type Color =
  | 'default'
  | 'gray' | 'brown' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'red'
  | 'gray_background' | 'brown_background' | 'orange_background' | 'yellow_background'
  | 'green_background' | 'blue_background' | 'purple_background' | 'pink_background' | 'red_background';

export type IconSpec =
  | { type: 'emoji'; emoji: string }
  | { type: 'external'; external: { url: string } }
  | { type: 'file'; file: { asset_id: string; url?: string; expiry_time?: string } };

export type FileRef =
  | { type: 'external'; external: { url: string } }
  | { type: 'file'; file: { asset_id: string; url?: string; expiry_time?: string } }
  | { type: 'file_upload'; file_upload: { id: string; status?: 'pending' | 'uploaded' | 'failed' | 'expired' } };

export type RichText = Array<RichTextSpan>;

export type RichTextSpan =
  | {
      type: 'text';
      text: { content: string; link?: { url: string } | null };
      annotations?: TextAnnotations;
      plain_text?: string;
      href?: string | null;
    }
  | {
      type: 'mention';
      mention:
        | { type: 'user'; user: { id: UserId; name?: string } }
        | { type: 'page'; page: { id: PageId; title?: string } }
        | { type: 'database'; database: { id: DatabaseId; title?: string } }
        | { type: 'data_source'; data_source: { id: DataSourceId; title?: string } }
        | { type: 'date'; date: { start: string; end?: string | null; time_zone?: string | null; reminder?: DateReminder | null } }
        | { type: 'link_preview'; link_preview: { url: string; provider?: string; title?: string } }
        | { type: 'template_mention'; template_mention: { template_mention_date?: 'today' | 'now'; template_mention_user?: 'me' } };
      annotations?: TextAnnotations;
      plain_text?: string;
      href?: string | null;
    }
  | {
      type: 'equation';
      equation: { expression: string };
      annotations?: TextAnnotations;
      plain_text?: string;
      href?: string | null;
    };

export type DateReminder =
  | { unit: 'minute' | 'hour' | 'day' | 'week'; value: number; before_start: true }
  | { at_time: string };

export type TextAnnotations = {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  code?: boolean;
  color?: Color;
};

export type BaseBlock<TType extends string, TPayload extends object> = {
  object: 'block';
  id: BlockId;
  type: TType;
  parent: ParentRef;
  created_time?: string;
  created_by?: { id: UserId };
  last_edited_time?: string;
  last_edited_by?: { id: UserId };
  in_trash?: boolean;
  has_children?: boolean;
  children?: BlockId[];
  order_key?: string;
  client?: {
    local_revision?: number;
    collapsed?: boolean;
    selected?: boolean;
    pending_upload?: boolean;
    error?: string;
  };
} & Record<TType, TPayload>;

export type NotionNextBlock =
  | ParagraphBlock
  | HeadingBlock
  | BulletedListItemBlock
  | NumberedListItemBlock
  | ToDoBlock
  | ToggleBlock
  | QuoteBlock
  | CalloutBlock
  | DividerBlock
  | ChildPageBlock
  | ChildDatabaseBlock
  | LinkToPageBlock
  | BreadcrumbBlock
  | TableOfContentsBlock
  | ColumnListBlock
  | ColumnBlock
  | TableBlock
  | TableRowBlock
  | CodeBlock
  | EquationBlock
  | ImageBlock
  | VideoBlock
  | AudioBlock
  | FileBlock
  | PdfBlock
  | BookmarkBlock
  | EmbedBlock
  | LinkPreviewBlock
  | SyncedBlock
  | TemplateBlock
  | ButtonBlock
  | DatabaseViewBlock
  | UnsupportedBlock;
```

### 3.2 Shared requirements

Every block MUST have a stable `id`, `type`, `parent`, and type-keyed payload. Serialized blocks SHOULD include `has_children` when child data is omitted and MAY include `children` when the client stores local tree order inline. Clients MUST treat `children` as ordered block IDs, not embedded HTML.

Text-bearing block payloads MUST use `rich_text: RichText`. Empty rich text MUST be `[]`, not `null`. A block MAY preserve Notion-like `color` even if the editor theme maps colors differently. Color rendering MUST satisfy contrast requirements and MUST NOT be the only cue for state.

A block type transform MUST preserve child blocks when the destination type allows them. It SHOULD preserve unused payload fields in an extension bag or transaction history so turning a block back can recover prior fields where practical.

Unknown fields from imports MUST be stored under an `extensions` or `unknown` key and re-emitted during serialization unless the user explicitly strips compatibility metadata.

### 3.3 Common editing behavior

All editable blocks MUST support:

- Block selection, copy, cut, paste, duplicate, trash/restore, move up/down, indent/outdent where schema-valid, and move-to-page where permissions allow.
- Drag handles on pointer/hover devices and keyboard/touch alternatives on all devices.
- Undo/redo boundaries for type transforms, markdown input rules, block splits/merges, drag/drop, and slash command execution.
- Block comments and copied block links if the host app implements comments/linking.

`Enter` in a rich-text block MUST split at the caret into a sibling block unless the block's type-specific behavior overrides it. `Shift+Enter` SHOULD insert a line break inside the same rich-text block. `Backspace` at the start of an empty block SHOULD merge/delete according to Notion-like expectations while preserving child blocks through a valid reparenting rule.

### 3.4 Common slash and markdown behavior

Typing `/` in a text-editing context MUST open an accessible command menu unless escaped or inside code/equation contexts. The command registry SHOULD include aliases used by Notion help such as `/text`, `/page`, `/bullet`, `/num`, `/todo`, `/toggle`, `/quote`, `/h1`, `/h2`, `/h3`, `/link`, `/mention`, `/date`, `/image`, `/pdf`, `/book`, `/video`, `/audio`, `/code`, `/file`, `/embed`, `/duplicate`, `/moveto`, `/delete`, `/toc`, `/button`, `/template`, `/bread`, `/math`, and `/latex`.

Line-start markdown input rules MUST be IME-safe and undoable. The editor MUST NOT run these rules inside code blocks, equations, or URL entry fields.

## 4. Inline interactions

Inline interactions are not standalone blocks, but every text-bearing block MUST support them unless explicitly disabled.

### 4.1 Text annotations and links

Purpose: annotate rich text with bold, italic, underline, strikethrough, inline code, color, and hyperlinks.

Schema fields: each rich-text span MAY include `annotations` and a text span MAY include `text.link.url`. `href` SHOULD be derived from the link or mention target for display compatibility.

Rendering: inline code MUST use a code style without breaking text flow. Links MUST be keyboard-focusable when read-only and editable through a link popover when the caret is inside the span.

Editing: `Mod+B/I/U`, `Mod+Shift+S`, `Mod+E`, and `Mod+K` SHOULD toggle annotations/link. Pasting a URL over selected text SHOULD create a link.

Accessibility: links MUST expose the target URL or page title to assistive technology. Color annotations MUST keep sufficient contrast.

Serialization example:

```json
{
  "type": "text",
  "text": { "content": "Notion API", "link": { "url": "https://developers.notion.com" } },
  "annotations": { "bold": true, "color": "default" },
  "plain_text": "Notion API",
  "href": "https://developers.notion.com"
}
```

Edge cases: empty links MUST be rejected; adjacent spans with identical annotations/link SHOULD be merged; literal markdown characters MUST be preserved when the user escapes or undoes an input rule.

### 4.2 Mentions, dates, reminders, and page links

Purpose: represent semantic references to users, pages, databases, data sources, dates/reminders, link previews, and template placeholders.

Schema fields: `mention.type` MUST discriminate the reference kind. Date mentions MUST support at least start date/time, optional end, optional time zone, and optional reminder metadata. Page/database/data-source mentions SHOULD store the stable target ID and MAY cache a title for offline display.

Rendering: mentions MUST render as inline chips or links with permission-aware fallbacks. Inaccessible page/database mentions SHOULD show a safe placeholder such as `Untitled` or `Private` without revealing restricted titles.

Editing: `@` MUST open a mention picker. `[[` SHOULD prioritize linking to an existing page. `+` SHOULD prioritize creating or linking a page. `/mention` and `/date` SHOULD invoke the same pickers. `@remind` SHOULD create a date mention with reminder metadata if reminders are implemented.

Drag/drop: inline mentions are text spans; dragging selected rich text MUST preserve their structured targets.

Accessibility: mention chips MUST expose their type and label, e.g. `Page mention: Roadmap` or `Date reminder: Tomorrow at 9 AM`.

Serialization example:

```json
{
  "type": "mention",
  "mention": { "type": "date", "date": { "start": "2026-03-11", "reminder": { "unit": "day", "value": 1, "before_start": true } } },
  "plain_text": "Mar 11, 2026",
  "href": null
}
```

Edge cases: deleted or inaccessible targets MUST remain as broken references until the user resolves them; title changes SHOULD update cached display text; template mentions MUST resolve when a template/button duplicates content.

### 4.3 Inline equations

Purpose: render mathematical notation inside rich text.

Schema fields: `type: "equation"` with `equation.expression` containing TeX/KaTeX-compatible source.

Rendering: the expression SHOULD render with a math engine and MUST fall back to readable source text on parse failure.

Editing: `/math` or `/equation` inside text SHOULD insert an inline equation. Backticks MUST NOT create inline code inside an equation editor.

Accessibility: rendered equations SHOULD include an accessible text alternative equal to the source expression unless an enriched MathML/ARIA label is available.

Serialization example:

```json
{ "type": "equation", "equation": { "expression": "E = mc^2" }, "plain_text": "E = mc^2" }
```

Edge cases: very long expressions SHOULD be capped or virtualized according to host limits; invalid expressions MUST NOT corrupt surrounding rich text.

## 5. Support matrix and allowed child constraints

`Allowed children` describes direct children. Rich-text inline content is separate. `Text` means the block has `rich_text`. `Container` means it may have block children. `Generated` means rendered from other state.

| Block type | Family | Text | Allowed children | API compatibility | Primary slash/markdown |
|---|---:|---:|---|---|---|
| `paragraph` | text | yes | Any block except structural-only invalid children (`column`, `table_row`) | Public API `paragraph` with `rich_text`, `color`, children | `/text` |
| `heading_1` | text/outline | yes | If `is_toggleable`, same as `toggle`; otherwise none | Public API `heading_1.rich_text`, `color`, `is_toggleable` | `/h1`, `# ` |
| `heading_2` | text/outline | yes | If `is_toggleable`, same as `toggle`; otherwise none | Public API `heading_2` | `/h2`, `## ` |
| `heading_3` | text/outline | yes | If `is_toggleable`, same as `toggle`; otherwise none | Public API `heading_3` | `/h3`, `### ` |
| `bulleted_list_item` | list | yes | Any block except `column`, `table_row`; nested list items SHOULD be common | Public API | `/bullet`, `* `, `- `, `+ ` |
| `numbered_list_item` | list | yes | Any block except `column`, `table_row`; nested list items SHOULD be common | Public API | `/num`, `1. `, `a. `, `i. ` |
| `to_do` | list/task | yes | Any block except `column`, `table_row` | Public API `checked` | `/todo`, `[] ` |
| `toggle` | disclosure | yes | Any block except `column`, `table_row` | Public API | `/toggle`, `> ` |
| `quote` | text/container | yes | Any block except `column`, `table_row` | Public API supports children | `/quote`, `" ` |
| `callout` | text/container | yes | Any block except `column`, `table_row` | Public API `icon`, `color`, children | `/callout` |
| `divider` | separator | no | none | Public API empty payload | `/div`, `---` |
| `child_page` | page | title | Page body blocks are children of the page/root | Public API `child_page.title`; page object has metadata | `/page` |
| `child_database` | collection/page | title | Rows are pages under data sources; no arbitrary block children | Public API `child_database`; map to database/data-source/view resources | `/database`, `/table` database variant |
| `link_to_page` | page link | title derived | none | Public API `link_to_page` | `/link` |
| `breadcrumb` | navigation | no | none | Public API `breadcrumb` | `/bread` |
| `table_of_contents` | generated | no | none | Public API `table_of_contents.color` | `/toc` |
| `column_list` | layout | no | Only `column`; at least two for creation | Public API `column_list` | drag side-by-side, `/columns` if implemented |
| `column` | layout | no | Any block except `column` as direct child and `table_row` | Public API `column.width_ratio` | created by column operations |
| `table` | simple table | no | Only `table_row`; row count >= 1 | Public API `table_width`, headers | `/table` |
| `table_row` | simple table | cells | none | Public API `table_row.cells` | table editor only |
| `code` | code | code text | none | Public API `code.rich_text`, `language`, caption | `/code`, shortcut block 8 |
| `equation` | math block | expression | none | Public API `equation.expression` | `/math`, `/latex` |
| `image` | media | caption | none | Public API `image` file object and caption | `/image`, paste/drop image |
| `video` | media | caption | none | Public API `video` | `/video`, paste/drop video |
| `audio` | media | caption | none | Public API `audio` | `/audio`, paste/drop audio |
| `file` | attachment | caption/name | none | Public API `file` | `/file`, drop file |
| `pdf` | document media | caption | none | Public API `pdf` | `/pdf`, drop PDF |
| `bookmark` | web link | caption/display | none | Public API `bookmark.url`, caption | `/book`, paste URL as bookmark |
| `embed` | external embed | caption/display | none | Public API `embed.url`, caption | `/embed`, paste URL as embed |
| `link_preview` | authenticated preview | display | none | Public API/link preview integrations where available | paste URL as preview |
| `synced_block` | transclusion | no direct text | Source has children; copy renders source children | Public API `synced_from` | `/synced`, turn into synced block |
| `template` | duplication | rich text label | Template content children | Public API `template.rich_text`, children | `/template` |
| `button` | action | label | Optional hidden/template children depending action | Product documented; API support may be unavailable/client-only | `/button` |
| `database_view` | collection | title/display | Rows are pages, not block children; optional view header children disallowed | Maps to database/data_source/view objects; legacy API may expose `child_database` | `/database`, `/table`, `/board`, linked database commands |
| `unsupported` | compatibility | unknown | MAY preserve opaque children if known | Public API `unsupported` | none |

A normalizer MUST reject a `column` outside a `column_list`, a `table_row` outside a `table`, a `column_list` with fewer than two columns at creation time, and table rows whose cell count differs from `table.table_width`. It MUST reject cycles, including moving a parent inside its descendant and synced-block source loops.

## 6. Block catalog

Each catalog entry below is normative. Compact JSON examples omit timestamps and actor metadata for readability but are valid serialized block shapes under this spec.

### 6.1 Paragraph / text block (`paragraph`)

Purpose: general prose, empty insertion point, and default block type.

Schema fields:

```ts
export type ParagraphBlock = BaseBlock<'paragraph', {
  rich_text: RichText;
  color?: Color;
}>;
```

Allowed children: MAY contain arbitrary content blocks except structural-only children (`column`, `table_row`). Children represent indented content beneath the paragraph.

Rendering behavior: render as a text block with placeholder text when empty and focused. The renderer SHOULD collapse empty paragraphs only in read-only/export modes when they are not meaningful spacers.

Editing behavior: `Enter` splits into another paragraph; `Backspace` at start merges with the previous compatible rich-text block or deletes the empty block; `Tab` nests under the previous block if valid. It MUST support all inline interactions.

Keyboard/markdown/slash: `/text` creates or turns into a paragraph. `Mod+Alt/Shift+0` SHOULD create/turn into text where platform shortcuts match Notion. Line-start markdown triggers may transform it into lists, headings, quote, toggle, or divider.

Drag/drop: paragraph can be reordered, nested under containers, moved into columns, duplicated with option/alt-drag, and used as a source for creating columns by dragging side-by-side.

Accessibility: expose role `document`/`textbox` in edit mode and announce block type as `Text` when selected as a block. Placeholder MUST not be treated as submitted content.

Serialization example:

```json
{
  "object": "block",
  "id": "blk_text_1",
  "type": "paragraph",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "paragraph": {
    "rich_text": [{ "type": "text", "text": { "content": "Ship the editor" }, "plain_text": "Ship the editor" }],
    "color": "default"
  },
  "has_children": false
}
```

Edge cases: empty paragraphs inside columns/toggles MUST preserve their block identity while editing; paste of multiple paragraphs SHOULD create multiple paragraph blocks; imported paragraphs with unsupported payload fields MUST preserve them.

### 6.2 Heading blocks (`heading_1`, `heading_2`, `heading_3`)

Purpose: outline structure, navigation anchors, and optional collapsible sections through toggle headings.

Schema fields:

```ts
export type HeadingLevel = 1 | 2 | 3;
export type HeadingBlock =
  | BaseBlock<'heading_1', { rich_text: RichText; color?: Color; is_toggleable?: boolean }>
  | BaseBlock<'heading_2', { rich_text: RichText; color?: Color; is_toggleable?: boolean }>
  | BaseBlock<'heading_3', { rich_text: RichText; color?: Color; is_toggleable?: boolean }>;
```

Allowed children: non-toggle headings MUST NOT have children. Toggle headings (`is_toggleable: true`) MAY contain the same children as `toggle` and MUST render collapsed/expanded state. If converting a child-bearing heading to non-toggle, children MUST be moved to valid siblings or the conversion MUST be rejected.

Rendering behavior: render semantic `h1`, `h2`, or `h3` equivalents within the page content hierarchy. Toggle headings show a disclosure affordance and hide descendants when collapsed. Table of contents MUST derive entries from non-indented heading blocks and SHOULD include toggle headings.

Editing behavior: rich text editing matches paragraphs. `Enter` at end creates a paragraph after the heading or after the collapsed subtree for toggle headings. `Enter` in an empty heading SHOULD turn it into a paragraph or create a new paragraph based on platform convention. Toggle disclosure is toggled by clicking the caret or `Mod/Ctrl+Enter` when selected/focused.

Keyboard/markdown/slash: `/h1`, `/h2`, `/h3`, `# `, `## `, `### ` create levels 1-3. Shortcuts for heading levels SHOULD follow Notion where possible. Slash commands SHOULD expose both normal heading and toggle heading variants.

Drag/drop: headings move with their explicit children when toggleable. Dragging following sibling content visually under a toggle heading MUST create real child relationships only when the drop target is inside the heading.

Accessibility: headings MUST expose the correct heading level. Toggle headings MUST expose `aria-expanded`, a keyboard-operable disclosure control, and a label that includes the heading text.

Serialization examples:

```json
{
  "object": "block",
  "id": "blk_h1",
  "type": "heading_1",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "heading_1": {
    "rich_text": [{ "type": "text", "text": { "content": "Architecture" }, "plain_text": "Architecture" }],
    "color": "default",
    "is_toggleable": false
  },
  "has_children": false
}
```

```json
{
  "object": "block",
  "id": "blk_toggle_h2",
  "type": "heading_2",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "heading_2": {
    "rich_text": [{ "type": "text", "text": { "content": "Details" }, "plain_text": "Details" }],
    "color": "default",
    "is_toggleable": true
  },
  "has_children": true,
  "children": ["blk_child_1"]
}
```

Edge cases: nested headings are omitted from Notion-style ToC; clients SHOULD define whether headings nested under toggles count when expanded. Empty toggle headings with children MUST remain selectable. Heading level transforms MUST preserve anchors and comments.

### 6.3 Bulleted list item (`bulleted_list_item`)

Purpose: unordered list item with optional nested content.

Schema fields:

```ts
export type BulletedListItemBlock = BaseBlock<'bulleted_list_item', {
  rich_text: RichText;
  color?: Color;
}>;
```

Allowed children: MAY contain arbitrary valid content except structural-only `column` and `table_row`. Nested list items SHOULD be rendered as nested lists when contiguous.

Rendering behavior: contiguous sibling bullet items MUST render as one logical list for accessibility and copy/export, while retaining individual block identity. Nested children render under the item, indented.

Editing behavior: `Enter` splits into a new bullet. `Enter` on an empty bullet SHOULD outdent or turn into a paragraph depending on nesting depth. `Tab`/`Shift+Tab` nest/outdent items.

Keyboard/markdown/slash: `/bullet`, `/bulleted list`, `* `, `- `, and `+ ` at line start create bullets.

Drag/drop: items can reorder within a list, nest under list items/toggles, or be moved as independent blocks. Multi-item drags MUST preserve relative order.

Accessibility: render list semantics with `ul`/`li` or equivalent ARIA, including accurate nesting levels.

Serialization example:

```json
{
  "object": "block",
  "id": "blk_bullet_1",
  "type": "bulleted_list_item",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "bulleted_list_item": {
    "rich_text": [{ "type": "text", "text": { "content": "Fast" }, "plain_text": "Fast" }],
    "color": "default"
  },
  "has_children": false
}
```

Edge cases: pasted Markdown lists SHOULD preserve nesting; mixed bullets separated by non-list blocks MUST be separate lists; empty bullet deletion MUST not orphan children.

### 6.4 Numbered list item (`numbered_list_item`)

Purpose: ordered list item with optional nested content.

Schema fields:

```ts
export type NumberedListItemBlock = BaseBlock<'numbered_list_item', {
  rich_text: RichText;
  color?: Color;
  list_format?: 'decimal' | 'lower_alpha' | 'lower_roman';
  start?: number;
}>;
```

Allowed children: same as bulleted list item.

Rendering behavior: contiguous numbered items MUST render as one ordered list. The renderer SHOULD compute visible numbering from sibling order and nesting; `list_format` and `start` are client-only fields for compatibility with `a.` and `i.` triggers where supported.

Editing behavior: `Enter`, `Tab`, and `Shift+Tab` follow bullet behavior. Reordering MUST recalculate visual numbers without mutating text.

Keyboard/markdown/slash: `/num`, `/numbered list`, `1. `, `a. `, and `i. ` at line start create numbered list items.

Drag/drop: moving items updates order and, if grouped/sorted in a database view, MUST distinguish block tree movement from row ordering.

Accessibility: render `ol`/`li` semantics with correct nesting and ordinal announcements.

Serialization example:

```json
{
  "object": "block",
  "id": "blk_num_1",
  "type": "numbered_list_item",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "numbered_list_item": {
    "rich_text": [{ "type": "text", "text": { "content": "Install" }, "plain_text": "Install" }],
    "color": "default",
    "list_format": "decimal"
  }
}
```

Edge cases: `1.` pasted as literal text MUST be possible via undo/escape; mixing decimal/alpha/roman in one contiguous list is implementation-defined but SHOULD preserve imported metadata.

### 6.5 To-do list item (`to_do`)

Purpose: checklist task with checked/unchecked state and optional nested content.

Schema fields:

```ts
export type ToDoBlock = BaseBlock<'to_do', {
  rich_text: RichText;
  checked: boolean;
  color?: Color;
}>;
```

Allowed children: same as bulleted list item.

Rendering behavior: render checkbox plus rich text. Checked items SHOULD visually mark completion, but strikethrough MUST NOT be the only accessible indication.

Editing behavior: clicking checkbox or pressing `Mod/Ctrl+Enter` when focused/selected toggles `checked`. `Enter` creates a new unchecked to-do. Toggle state changes MUST be undoable.

Keyboard/markdown/slash: `/todo`, `/checkbox`, and `[] ` at line start create to-do. Importers MAY treat `[ ] ` and `[x] ` as unchecked/checked.

Drag/drop: behaves as a list item; dragging by checkbox SHOULD not accidentally toggle.

Accessibility: checkbox MUST be a keyboard-operable control with accessible checked state and label from the item text.

Serialization example:

```json
{
  "object": "block",
  "id": "blk_todo_1",
  "type": "to_do",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "to_do": {
    "rich_text": [{ "type": "text", "text": { "content": "Write tests" }, "plain_text": "Write tests" }],
    "checked": false,
    "color": "default"
  },
  "has_children": false
}
```

Edge cases: toggling a parent to-do MUST NOT implicitly toggle child to-dos unless the user chooses a bulk command. Empty checked to-dos MUST remain valid.

### 6.6 Toggle list item (`toggle`)

Purpose: collapsible disclosure block that can hide/show child blocks.

Schema fields:

```ts
export type ToggleBlock = BaseBlock<'toggle', {
  rich_text: RichText;
  color?: Color;
}>;
```

Allowed children: MAY contain arbitrary valid content except structural-only children.

Rendering behavior: render a disclosure triangle plus rich text. Collapsed toggles MUST hide descendants visually but preserve them in the document tree, serialization, search policy, and copy behavior as configured by the host app.

Editing behavior: click disclosure or `Mod/Ctrl+Enter` toggles expanded state. `Enter` in the title line creates a sibling, not a hidden child, unless the selection is inside the child area.

Keyboard/markdown/slash: `/toggle` and `> ` at line start create a toggle list item. A global expand/collapse-all toggles command SHOULD exist.

Drag/drop: dropping inside a toggle appends/nests children. Dragging a collapsed toggle MUST move the whole subtree.

Accessibility: use disclosure button semantics with `aria-expanded`; hidden content MUST be inaccessible to tab order when collapsed.

Serialization example:

```json
{
  "object": "block",
  "id": "blk_toggle_1",
  "type": "toggle",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "toggle": {
    "rich_text": [{ "type": "text", "text": { "content": "More" }, "plain_text": "More" }],
    "color": "default"
  },
  "has_children": true,
  "children": ["blk_nested_1"],
  "client": { "collapsed": true }
}
```

Edge cases: collapsed state is client/UI state and MAY be per-user; moving children out of a collapsed toggle SHOULD be possible from a block tree/sidebar/keyboard command.

### 6.7 Quote (`quote`)

Purpose: visually set off quoted or emphasized content.

Schema fields:

```ts
export type QuoteBlock = BaseBlock<'quote', {
  rich_text: RichText;
  color?: Color;
}>;
```

Allowed children: MAY contain arbitrary valid child blocks except structural-only children.

Rendering behavior: render with quote styling such as a left border. Children render indented below the quote text and remain part of the quote block's subtree.

Editing behavior: behaves like a paragraph with container support. Empty quote may turn into paragraph on repeated `Enter` or `Backspace` according to editor conventions.

Keyboard/markdown/slash: `/quote` and `" ` at line start create a quote.

Drag/drop: quote moves with descendants. Dropping into the quote creates nested content; dropping adjacent creates siblings.

Accessibility: SHOULD use `blockquote` semantics when read-only and editable text semantics in edit mode.

Serialization example:

```json
{
  "object": "block",
  "id": "blk_quote_1",
  "type": "quote",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "quote": {
    "rich_text": [{ "type": "text", "text": { "content": "Make tools that feel like thought." }, "plain_text": "Make tools that feel like thought." }],
    "color": "default"
  }
}
```

Edge cases: nested quotes SHOULD remain readable; quote children exported to Markdown SHOULD be prefixed consistently or represented as nested blocks.

### 6.8 Callout (`callout`)

Purpose: highlighted note with icon, color/background, rich text, and optional nested content.

Schema fields:

```ts
export type CalloutBlock = BaseBlock<'callout', {
  rich_text: RichText;
  icon?: IconSpec | null;
  color?: Color;
}>;
```

Allowed children: MAY contain arbitrary valid child blocks except structural-only children.

Rendering behavior: render an icon area and content area. If `icon` is absent, the editor MAY provide a default lightbulb-like icon. Background color SHOULD derive from `color` when a background color is selected.

Editing behavior: icon picker, color menu, and rich text editing MUST be undoable. Children are edited below the callout body.

Keyboard/markdown/slash: `/callout` creates the block. No required markdown trigger.

Drag/drop: callout can receive drops into its child area and moves as a subtree.

Accessibility: icon-only meaning MUST have a text label or be decorative. Color contrast MUST be checked for both icon and text.

Serialization example:

```json
{
  "object": "block",
  "id": "blk_callout_1",
  "type": "callout",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "callout": {
    "rich_text": [{ "type": "text", "text": { "content": "Remember edge cases" }, "plain_text": "Remember edge cases" }],
    "icon": { "type": "emoji", "emoji": "💡" },
    "color": "yellow_background"
  },
  "has_children": true,
  "children": ["blk_detail_1"]
}
```

Edge cases: converting from callout to paragraph SHOULD preserve icon in unknown fields; empty callouts with children MUST remain valid.

### 6.9 Divider (`divider`)

Purpose: visual horizontal separation.

Schema fields:

```ts
export type DividerBlock = BaseBlock<'divider', Record<string, never>>;
```

Allowed children: none.

Rendering behavior: render a horizontal rule. It MUST be selectable as a block even though it has no text.

Editing behavior: `Enter` before/after selected divider creates a paragraph. Delete removes it. It has no inline caret.

Keyboard/markdown/slash: `/div`, `/divider`, or `---` as exact line content creates a divider.

Drag/drop: draggable as a standalone block. It MUST NOT accept inside drops.

Accessibility: expose as separator with `role="separator"` or semantic `hr`.

Serialization example:

```json
{
  "object": "block",
  "id": "blk_divider_1",
  "type": "divider",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "divider": {}
}
```

Edge cases: three hyphens inside code or after other text MUST remain literal; adjacent dividers MAY be allowed but SHOULD not collapse unless the user chooses cleanup.

### 6.10 Child page (`child_page`)

Purpose: create or display a page nested under the current page.

Schema fields:

```ts
export type ChildPageBlock = BaseBlock<'child_page', {
  title: string;
  icon?: IconSpec | null;
  cover?: FileRef | null;
  page_id?: PageId;
}>;
```

Allowed children: the page's body blocks are conceptually children of the page object/root. A serialized `child_page` MAY expose `children` for local convenience, but public API page body retrieval is done by requesting children of the page ID.

Rendering behavior: render as a page row/link with icon and title. Opening it navigates into the child page. In a page tree/sidebar, it appears as nested page content.

Editing behavior: title is editable inline where the product allows. `Enter` on selected child page opens it; `Mod/Ctrl+Enter` SHOULD open. Creating a child page inserts a page object and a corresponding child-page block/reference.

Keyboard/markdown/slash: `/page` creates a new child page; shortcut block 9 SHOULD create/turn current line into page. `[[` and `+` flows MAY create subpages but inline page mentions are not child-page blocks.

Drag/drop: child pages can be reordered in page content and sidebar. Moving to another page changes the page parent; moving only a link-to-page MUST NOT reparent the target.

Accessibility: expose as a link or tree item with title and page icon text alternative.

Serialization example:

```json
{
  "object": "block",
  "id": "page_child_1",
  "type": "child_page",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "child_page": { "title": "Project brief", "page_id": "page_child_1", "icon": { "type": "emoji", "emoji": "📄" } },
  "has_children": true
}
```

Edge cases: title can be empty during creation but SHOULD show `Untitled`; inaccessible child pages MUST show a permission-safe placeholder; deleting a child page block may trash the page, not just remove a link, depending on host policy.

### 6.11 Link to page (`link_to_page`)

Purpose: display a page/database reference as a block without making it a subpage of the current page.

Schema fields:

```ts
export type LinkToPageBlock = BaseBlock<'link_to_page', {
  target: { type: 'page_id'; page_id: PageId } | { type: 'database_id'; database_id: DatabaseId } | { type: 'data_source_id'; data_source_id: DataSourceId };
  cached_title?: string;
  icon?: IconSpec | null;
}>;
```

Allowed children: none.

Rendering behavior: render like a page row/link. It SHOULD update display title when the target title changes. Unlike `child_page`, it MUST NOT alter sidebar/page hierarchy.

Editing behavior: target can be chosen through a page picker. Renaming the visual label SHOULD rename the target only if the editor clearly indicates that behavior; otherwise label is derived/read-only.

Keyboard/markdown/slash: `/link` inserts link-to-page. `[[` and `+` may offer a block insertion option, but default inline behavior is a mention.

Drag/drop: moving the block moves only the reference. Dragging a page from search/sidebar into content MAY create link-to-page or child page depending on modifier/intent.

Accessibility: expose as a link with target type and title.

Serialization example:

```json
{
  "object": "block",
  "id": "blk_link_page_1",
  "type": "link_to_page",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "link_to_page": { "target": { "type": "page_id", "page_id": "page_roadmap" }, "cached_title": "Roadmap" }
}
```

Edge cases: target deletion/inaccessibility MUST not delete the block automatically; it should render as broken/private. API-compatible serialization may need Notion's nested `page_id`/`database_id` shape rather than this normalized `target` shape.

### 6.12 Breadcrumb (`breadcrumb`)

Purpose: show page ancestry and navigation context.

Schema fields:

```ts
export type BreadcrumbBlock = BaseBlock<'breadcrumb', {
  root?: PageId | 'current';
  include_current?: boolean;
}>;
```

Allowed children: none.

Rendering behavior: generated from the current page's parent chain. It MUST NOT duplicate ancestry text into persisted rich text. If embedded on a page, it updates when the page moves or ancestors are renamed.

Editing behavior: block is selectable/deletable/movable but generated content is not edited directly. Configuration MAY allow hiding current page or choosing a root.

Keyboard/markdown/slash: `/bread` or `/breadcrumb` inserts it.

Drag/drop: standalone block; cannot receive children.

Accessibility: render as navigation landmark or ordered breadcrumb list with links.

Serialization example:

```json
{
  "object": "block",
  "id": "blk_breadcrumb_1",
  "type": "breadcrumb",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "breadcrumb": { "root": "current", "include_current": true }
}
```

Edge cases: private ancestors SHOULD render as private/ellipsis without leaking titles; cyclic parent data MUST be rejected by the page graph before rendering.

### 6.13 Table of contents (`table_of_contents`)

Purpose: generated in-page outline from headings.

Schema fields:

```ts
export type TableOfContentsBlock = BaseBlock<'table_of_contents', {
  color?: Color;
  include_toggle_headings?: boolean;
}>;
```

Allowed children: none.

Rendering behavior: derive links from heading 1-3 blocks in the current page. H2/H3 entries SHOULD be indented beneath higher levels. Notion-style compatibility SHOULD omit headings nested under other blocks; if including nested headings, label that as implementation-defined.

Editing behavior: users edit source heading blocks, not ToC rows. The block itself supports selection, move, color, duplicate, and delete.

Keyboard/markdown/slash: `/toc` or `/table of contents` inserts it.

Drag/drop: standalone block; cannot receive children.

Accessibility: render as navigation with a label such as `Table of contents`; each entry is a link to a heading anchor.

Serialization example:

```json
{
  "object": "block",
  "id": "blk_toc_1",
  "type": "table_of_contents",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "table_of_contents": { "color": "default", "include_toggle_headings": true }
}
```

Edge cases: duplicate heading text requires unique anchors; hidden/collapsed headings SHOULD still appear if they are real headings; headings inside synced blocks MAY be included or omitted by host policy, but behavior MUST be deterministic.

### 6.14 Columns (`column_list` and `column`)

Purpose: multi-column page layout.

Schema fields:

```ts
export type ColumnListBlock = BaseBlock<'column_list', Record<string, never>>;
export type ColumnBlock = BaseBlock<'column', {
  width_ratio?: number;
}>;
```

Allowed children: `column_list` MUST contain only `column` children. A newly created column list MUST contain at least two columns, and each created column SHOULD contain at least one child block. `column` MAY contain arbitrary valid content except direct `column` and `table_row` children. Nested `column_list` inside a column MAY be disallowed for Notion compatibility; if allowed, it is implementation freedom and MUST serialize safely.

Rendering behavior: `column_list` renders a horizontal flex/grid layout on desktop/tablet. `column.width_ratio` SHOULD control relative widths and ratios SHOULD sum to 1 after normalization. On narrow/mobile screens, columns MUST collapse deterministically from left to right/top to bottom.

Editing behavior: columns are primarily created by dragging blocks side-by-side or a layout command. Users can resize vertical guides, add/remove columns, and drag content out. Empty columns SHOULD be removed automatically when safe or show a placeholder while editing.

Keyboard/markdown/slash: no required markdown trigger. A slash command MAY offer `/columns` or layout presets, but Notion-compatible creation by drag side-by-side MUST be supported on pointer devices.

Drag/drop: side-by-side drop creates or updates a `column_list`. Dropping into a column appends/moves into that column. Dragging a column reorders columns; dragging a column list moves the whole layout.

Accessibility: keyboard users MUST be able to move blocks into/out of columns and reorder columns. Column groups SHOULD have labels such as `Column 1 of 3`.

Serialization example:

```json
[
  {
    "object": "block",
    "id": "blk_cols_1",
    "type": "column_list",
    "parent": { "type": "page_id", "page_id": "page_1" },
    "column_list": {},
    "has_children": true,
    "children": ["blk_col_a", "blk_col_b"]
  },
  {
    "object": "block",
    "id": "blk_col_a",
    "type": "column",
    "parent": { "type": "block_id", "block_id": "blk_cols_1" },
    "column": { "width_ratio": 0.5 },
    "has_children": true,
    "children": ["blk_text_a"]
  }
]
```

Edge cases: dragging a parent into its own column descendant MUST be rejected; deleting one of two columns SHOULD unwrap remaining content rather than leaving an invalid one-column list; width ratios from imports that do not sum to 1 SHOULD be normalized without losing original values if round-tripping.

### 6.15 Simple table (`table` and `table_row`)

Purpose: non-database grid of rich-text cells.

Schema fields:

```ts
export type TableBlock = BaseBlock<'table', {
  table_width: number;
  has_column_header?: boolean;
  has_row_header?: boolean;
  column_widths?: number[];
}>;

export type TableRowBlock = BaseBlock<'table_row', {
  cells: RichText[];
}>;
```

Allowed children: `table` MUST contain only `table_row` children. `table_row` MUST NOT contain block children. Each row's `cells.length` MUST equal `table.table_width` after normalization.

Rendering behavior: render an editable grid. Header row/column styles derive from table flags. Cell rich text supports inline interactions but not arbitrary block children. Column widths are client-only unless exported to a compatible API.

Editing behavior: users can add/remove rows and columns, resize columns, toggle header row/column, color cells, clear cells, fit table to page, and convert to database where implemented. Multi-cell paste MAY be unsupported for Notion parity, but if implemented it MUST validate dimensions and undo atomically.

Keyboard/markdown/slash: `/table` creates a simple table. `Tab`, `Shift+Tab`, arrow keys, and `Enter` SHOULD navigate cells according to grid editing conventions, without conflicting with page-level indentation.

Drag/drop: table rows may be reordered within the table. The table block moves as a whole in the page. Dropping arbitrary blocks into cells is not allowed; dropping text/CSV MAY fill cells.

Accessibility: render as a table/grid with row/column counts, headers, keyboard cell navigation, and announced selection ranges.

Serialization example:

```json
[
  {
    "object": "block",
    "id": "blk_table_1",
    "type": "table",
    "parent": { "type": "page_id", "page_id": "page_1" },
    "table": { "table_width": 2, "has_column_header": true, "has_row_header": false },
    "children": ["blk_row_1"]
  },
  {
    "object": "block",
    "id": "blk_row_1",
    "type": "table_row",
    "parent": { "type": "block_id", "block_id": "blk_table_1" },
    "table_row": {
      "cells": [
        [{ "type": "text", "text": { "content": "Name" }, "plain_text": "Name" }],
        [{ "type": "text", "text": { "content": "Owner" }, "plain_text": "Owner" }]
      ]
    }
  }
]
```

Edge cases: changing table width MUST update all rows consistently; empty trailing rows/columns SHOULD remain user-visible while editing; imported rows with wrong width MUST be padded/truncated only through an explicit normalizer that records repair.

### 6.16 Code block (`code`)

Purpose: display and edit preformatted code with language metadata and optional caption.

Schema fields:

```ts
export type CodeBlock = BaseBlock<'code', {
  rich_text: RichText;
  language?: string;
  caption?: RichText;
}>;
```

Allowed children: none.

Rendering behavior: render a code editor/viewer with monospace text, preserved whitespace, optional syntax highlighting, language label, copy button, and caption. Rich text SHOULD be restricted to plain text content; annotations MAY be ignored for code source.

Editing behavior: `Enter` inserts a newline within the code block. `Tab` SHOULD insert indentation or move focus based on accessibility settings. Markdown/slash/mention input rules MUST be disabled inside code content.

Keyboard/markdown/slash: `/code` creates a code block. The Notion block transform shortcut for code SHOULD be supported where platform-compatible. Triple-backtick Markdown import/export SHOULD map to code blocks; live input MAY support ``` at line start if implemented.

Drag/drop: standalone block; dragged files SHOULD not drop inside the code editor unless the editor intentionally inserts text.

Accessibility: code editor MUST have an accessible label, language announcement, keyboard escape path, and copy button label.

Serialization example:

```json
{
  "object": "block",
  "id": "blk_code_1",
  "type": "code",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "code": {
    "rich_text": [{ "type": "text", "text": { "content": "console.log('hi')" }, "plain_text": "console.log('hi')" }],
    "language": "typescript",
    "caption": []
  }
}
```

Edge cases: very large code blocks SHOULD virtualize rendering; invalid/unknown languages MUST fall back to plain text; rich text mentions pasted into code MUST become literal text.

### 6.17 Block equation (`equation`)

Purpose: standalone mathematical expression.

Schema fields:

```ts
export type EquationBlock = BaseBlock<'equation', {
  expression: string;
}>;
```

Allowed children: none.

Rendering behavior: render centered or block-level math from TeX/KaTeX-compatible source with fallback text on parse failure.

Editing behavior: focus opens an equation editor. `Enter` inside the editor MAY commit or insert a newline according to math editor behavior; outside it creates a new paragraph.

Keyboard/markdown/slash: `/math`, `/latex`, or `/equation` creates it. Inline `$...$` conversion MAY be implemented as import-only unless explicitly enabled.

Drag/drop: standalone block; cannot receive children.

Accessibility: expose source expression or generated MathML. Parse errors MUST be announced to screen readers if shown visually.

Serialization example:

```json
{
  "object": "block",
  "id": "blk_eq_1",
  "type": "equation",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "equation": { "expression": "\\int_0^1 x^2 dx = \\frac{1}{3}" }
}
```

Edge cases: malicious TeX commands MUST be sanitized by the math renderer; expressions exceeding configured length MUST be rejected gracefully.

### 6.18 Image (`image`)

Purpose: display image assets or external images with caption.

Schema fields:

```ts
export type ImageBlock = BaseBlock<'image', {
  source: FileRef;
  caption?: RichText;
  alt?: string;
  size?: { width?: number; height?: number; aspect_ratio?: number };
}>;
```

Allowed children: none.

Rendering behavior: render image with loading, error, and permission states; support resize, full-screen/open original, and caption. External images SHOULD be loaded securely and may be proxied by the host app.

Editing behavior: users can upload, paste, drag/drop, replace source, edit caption/alt text, resize, align, and delete. Uploads should show placeholders using client fields until a `FileRef` is ready.

Keyboard/markdown/slash: `/image` creates chooser. Pasting/dropping image files creates image blocks. Markdown image import `![alt](url)` maps to image.

Drag/drop: can move in page/columns; external image files dropped onto the page create image blocks. Dropping onto an existing image MAY replace it with confirmation.

Accessibility: `alt` text SHOULD be required or promptable for meaningful images; decorative images MAY have empty alt. Caption is not a substitute for alt in all contexts.

Serialization example:

```json
{
  "object": "block",
  "id": "blk_image_1",
  "type": "image",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "image": {
    "source": { "type": "external", "external": { "url": "https://example.com/diagram.png" } },
    "caption": [{ "type": "text", "text": { "content": "System diagram" }, "plain_text": "System diagram" }],
    "alt": "System diagram"
  }
}
```

Edge cases: expired hosted file URLs MUST be refreshed by the asset adapter; broken images MUST remain selectable; SVG content MUST be sanitized if embedded inline.

### 6.19 Video (`video`)

Purpose: embed playable video files or external video URLs.

Schema fields:

```ts
export type VideoBlock = BaseBlock<'video', {
  source: FileRef;
  caption?: RichText;
  poster?: FileRef | null;
}>;
```

Allowed children: none.

Rendering behavior: render native video player for supported files or provider embed when source is external and embeddable. Provide loading/error/auth states and optional caption.

Editing behavior: upload, paste URL, replace, caption, resize, and full-screen controls. Autoplay SHOULD be off by default.

Keyboard/markdown/slash: `/video` creates it; dropping video files creates blocks; URL paste may offer embed/bookmark/video choices.

Drag/drop: standalone media block; option/alt-drag duplicates the reference, not necessarily the binary.

Accessibility: video controls MUST be keyboard accessible; captions/subtitles SHOULD be supported when available.

Serialization example:

```json
{
  "object": "block",
  "id": "blk_video_1",
  "type": "video",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "video": {
    "source": { "type": "external", "external": { "url": "https://example.com/demo.mp4" } },
    "caption": []
  }
}
```

Edge cases: providers that block framing MUST fall back to link/bookmark; large videos require upload progress and cancellation; full-screen shortcuts MUST not conflict with block selection.

### 6.20 Audio (`audio`)

Purpose: embed playable audio files or external audio URLs.

Schema fields:

```ts
export type AudioBlock = BaseBlock<'audio', {
  source: FileRef;
  caption?: RichText;
  title?: string;
}>;
```

Allowed children: none.

Rendering behavior: render audio player with title/caption and loading/error states.

Editing behavior: upload/drop/paste audio, replace source, edit caption/title, delete.

Keyboard/markdown/slash: `/audio` creates chooser; audio file drop creates block.

Drag/drop: standalone media block.

Accessibility: controls MUST be keyboard accessible and labeled; transcript support SHOULD be offered for spoken audio if available.

Serialization example:

```json
{
  "object": "block",
  "id": "blk_audio_1",
  "type": "audio",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "audio": {
    "source": { "type": "file_upload", "file_upload": { "id": "upl_audio_1", "status": "uploaded" } },
    "caption": [{ "type": "text", "text": { "content": "Interview clip" }, "plain_text": "Interview clip" }]
  }
}
```

Edge cases: browser codec support differs; unsupported sources MUST provide download/open fallback.

### 6.21 File attachment (`file`)

Purpose: attach a downloadable file that is not rendered by a specialized block.

Schema fields:

```ts
export type FileBlock = BaseBlock<'file', {
  source: FileRef;
  name?: string;
  caption?: RichText;
  size_bytes?: number;
  mime_type?: string;
}>;
```

Allowed children: none.

Rendering behavior: render file icon, name, size/type metadata, caption, and open/download controls. If the host can preview the type, it MAY offer preview without changing block type.

Editing behavior: upload/drop file, rename display name, replace, caption, delete.

Keyboard/markdown/slash: `/file` creates upload/attach flow. Dropping unsupported files creates file blocks.

Drag/drop: file blocks move as normal blocks; dropping external files onto page creates upload placeholders.

Accessibility: file name, type, size, and action buttons MUST be announced.

Serialization example:

```json
{
  "object": "block",
  "id": "blk_file_1",
  "type": "file",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "file": {
    "source": { "type": "file_upload", "file_upload": { "id": "upl_file_1", "status": "uploaded" } },
    "name": "requirements.txt",
    "caption": []
  }
}
```

Edge cases: expired/private download URLs MUST refresh; missing files MUST not remove captions; malware scanning state MAY be represented in client-only fields.

### 6.22 PDF (`pdf`)

Purpose: display an embedded PDF document with caption and download/open controls.

Schema fields:

```ts
export type PdfBlock = BaseBlock<'pdf', {
  source: FileRef;
  caption?: RichText;
  page?: number;
}>;
```

Allowed children: none.

Rendering behavior: render browser PDF viewer or controlled preview with pagination, zoom, download/open, loading, and error states. If preview unavailable, render as file attachment fallback.

Editing behavior: upload/drop/paste PDF, replace, caption, resize preview height, optionally set initial page.

Keyboard/markdown/slash: `/pdf` creates chooser; dropping a PDF creates a PDF block.

Drag/drop: standalone media block.

Accessibility: viewer controls MUST be keyboard accessible; provide file name and open/download fallback for screen readers.

Serialization example:

```json
{
  "object": "block",
  "id": "blk_pdf_1",
  "type": "pdf",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "pdf": {
    "source": { "type": "external", "external": { "url": "https://example.com/spec.pdf" } },
    "caption": []
  }
}
```

Edge cases: cross-origin PDFs may not preview; very large PDFs SHOULD lazy-load pages; annotations inside PDFs are outside this block spec unless the host adds extension fields.

### 6.23 Bookmark (`bookmark`)

Purpose: rich web link card with title, description, URL, favicon/image, and caption.

Schema fields:

```ts
export type BookmarkBlock = BaseBlock<'bookmark', {
  url: string;
  caption?: RichText;
  metadata?: { title?: string; description?: string; icon_url?: string; image_url?: string; provider?: string; fetched_at?: string };
}>;
```

Allowed children: none.

Rendering behavior: render URL preview card. Metadata is display cache; canonical source is `url`. Loading/error states MUST be shown while unfurling.

Editing behavior: paste URL as bookmark, edit URL, refresh metadata, caption, delete. Client-only unfurling MAY be limited by CORS; the host MAY require an adapter but this spec does not define backend services.

Keyboard/markdown/slash: `/book`, `/bookmark`, or paste URL and choose `Paste as bookmark`.

Drag/drop: standalone block; dragging URL into page MAY create bookmark.

Accessibility: card MUST expose title and URL; image thumbnails need alt text or decorative treatment.

Serialization example:

```json
{
  "object": "block",
  "id": "blk_bookmark_1",
  "type": "bookmark",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "bookmark": {
    "url": "https://www.notion.com/help/what-is-a-block",
    "caption": [],
    "metadata": { "title": "What is a block?", "provider": "Notion" }
  }
}
```

Edge cases: private pages may not unfurl; metadata refresh failure MUST not lose the URL; duplicate pasted URL choices SHOULD let users choose plain link/bookmark/embed/preview.

### 6.24 Embed (`embed`)

Purpose: embedded external content, usually iframe/provider content.

Schema fields:

```ts
export type EmbedBlock = BaseBlock<'embed', {
  url: string;
  caption?: RichText;
  provider?: string;
  aspect_ratio?: number;
  height?: number;
  allow?: string;
}>;
```

Allowed children: none.

Rendering behavior: render provider iframe or embed player if allowed; otherwise show blocked/fallback card. Embeds SHOULD be sandboxed and loaded lazily.

Editing behavior: paste URL as embed, edit URL, resize, caption, reload. Authentication-required embeds MUST show clear error/fallback.

Keyboard/markdown/slash: `/embed`; URL paste may offer `Paste as embed`.

Drag/drop: standalone block and can be placed in columns.

Accessibility: embed container MUST have a title. If iframe content is inaccessible, provide an open-in-new link.

Serialization example:

```json
{
  "object": "block",
  "id": "blk_embed_1",
  "type": "embed",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "embed": { "url": "https://www.figma.com/file/example", "caption": [], "provider": "figma" }
}
```

Edge cases: websites may deny framing; CORS/auth/cookie restrictions differ by browser; never execute untrusted embed scripts outside sandbox.

### 6.25 Link preview (`link_preview`)

Purpose: live/authenticated preview of supported external resources, distinct from generic bookmark/embed.

Schema fields:

```ts
export type LinkPreviewBlock = BaseBlock<'link_preview', {
  url: string;
  provider?: string;
  title?: string;
  attributes?: Record<string, unknown>;
  auth_state?: 'not_required' | 'needs_auth' | 'authorized' | 'access_denied' | 'error';
  last_synced_time?: string;
}>;
```

Allowed children: none.

Rendering behavior: render provider-controlled preview attributes and update status. It MUST always expose canonical URL. If authentication/access fails, render a safe fallback without leaking private data.

Editing behavior: paste supported URL and choose `Paste as preview`; users MAY connect accounts, refresh, disconnect, or convert to bookmark/link.

Keyboard/markdown/slash: no required slash command, but `/embed` or paste menu MAY include link preview choices.

Drag/drop: standalone block.

Accessibility: preview fields MUST have labels; dynamic updates SHOULD announce politely when user-initiated.

Serialization example:

```json
{
  "object": "block",
  "id": "blk_preview_1",
  "type": "link_preview",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "link_preview": {
    "url": "https://github.com/org/repo/pull/42",
    "provider": "github",
    "title": "Add editor block catalog",
    "auth_state": "authorized",
    "attributes": { "state": "open", "number": 42 }
  }
}
```

Edge cases: link previews in Notion are not the same as embeds and may require provider OAuth; users who can view the page may see preview data, so insertion SHOULD warn when data comes from a private provider.

### 6.26 Synced block (`synced_block`)

Purpose: transclude one canonical block subtree into multiple locations.

Schema fields:

```ts
export type SyncedBlock = BaseBlock<'synced_block', {
  synced_from: null | { type: 'block_id'; block_id: BlockId };
  copy_count?: number;
}>;
```

Allowed children: an original/source synced block (`synced_from: null`) MAY own child blocks. A copy (`synced_from.block_id`) SHOULD NOT own independent child blocks; it renders the source's children. If imported data includes children on a copy, the implementation MUST either ignore them for rendering while preserving them or materialize them on unsync.

Rendering behavior: render a bordered synced region with an indicator and source/copy status. Copies render source content and update when source changes. Inaccessible sources render request-access/private state.

Editing behavior: editing any instance MUST route mutations to the source if permissions allow. `Unsync this` materializes independent children at the copy location. `Unsync all` breaks all copies from the source. Deleting the source MUST warn and define cascade/recovery behavior.

Keyboard/markdown/slash: command to `Turn into synced block`; paste a synced block copy SHOULD create another copy by default, with an option to paste unsynced.

Drag/drop: moving a synced copy moves only its instance. Dragging source/copy SHOULD clearly state whether the action moves the instance, creates a copy, or materializes content.

Accessibility: region label MUST indicate synced status and whether content is editable. Source navigation controls MUST be keyboard accessible.

Serialization example:

```json
{
  "object": "block",
  "id": "blk_sync_copy_1",
  "type": "synced_block",
  "parent": { "type": "page_id", "page_id": "page_2" },
  "synced_block": { "synced_from": { "type": "block_id", "block_id": "blk_sync_source_1" } },
  "has_children": false
}
```

Edge cases: prevent source cycles; source deletion with many copies is risky in Notion and this spec REQUIRES confirmation plus undo/recovery where feasible; source permissions may differ from containing page permissions.

### 6.27 Template block (`template`)

Purpose: legacy/template-button style block that duplicates predefined child content with variable resolution.

Schema fields:

```ts
export type TemplateBlock = BaseBlock<'template', {
  rich_text: RichText;
  template_children?: BlockId[];
}>;
```

Allowed children: MAY contain the blocks to duplicate when invoked. Child blocks are template content, not normal visible page content unless the editor chooses to show an editable template body.

Rendering behavior: render a button-like template control with label from `rich_text`; optionally show/edit template contents in configuration mode.

Editing behavior: clicking/activating duplicates template children at a defined insertion point. Template mentions such as `today`, `now`, and `me` MUST resolve during duplication. Large template application MAY be asynchronous in the host app but the client transaction MUST expose pending/completed/error state.

Keyboard/markdown/slash: `/template` inserts it. Product also uses buttons for modern workflows; implementations SHOULD support both legacy template and modern button semantics.

Drag/drop: template block moves as a block. Template child content may be rearranged only in configuration mode.

Accessibility: activation control MUST be a button with label. Configuration controls MUST distinguish editing the label from invoking the template.

Serialization example:

```json
{
  "object": "block",
  "id": "blk_template_1",
  "type": "template",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "template": {
    "rich_text": [{ "type": "text", "text": { "content": "New meeting notes" }, "plain_text": "New meeting notes" }],
    "template_children": ["blk_template_child_1"]
  },
  "has_children": true,
  "children": ["blk_template_child_1"]
}
```

Edge cases: invoking a template inside its own template subtree MUST be prevented; variable resolution requires timezone/user context; applying templates to database pages may interact with database templates, which are separate page-level blueprints.

### 6.28 Button (`button`)

Purpose: modern action block that executes one or more configured actions such as inserting blocks, adding/editing database pages, opening URLs/pages, notifications, webhooks, or other host-defined actions.

Schema fields:

```ts
export type ButtonBlock = BaseBlock<'button', {
  label: RichText;
  icon?: IconSpec | null;
  actions: ButtonAction[];
  confirmation?: { title?: string; message?: RichText };
  variables?: Array<{ id: string; name: string; expression?: string }>;
}>;

export type ButtonAction =
  | { type: 'insert_blocks'; position: 'above' | 'below' | 'top' | 'bottom'; blocks: NotionNextBlock[] }
  | { type: 'add_page_to_data_source'; data_source_id: DataSourceId; properties?: Record<string, unknown>; template_id?: string }
  | { type: 'edit_pages'; target: { data_source_id: DataSourceId; filter?: unknown }; properties: Record<string, unknown> }
  | { type: 'open_page'; page_id: PageId }
  | { type: 'open_url'; url: string }
  | { type: 'notify'; recipients: Array<{ type: 'user'; id: UserId }>; message: RichText }
  | { type: 'webhook'; url_ref: string; payload?: unknown }
  | { type: 'custom'; action_id: string; config: unknown };
```

Allowed children: none in normal rendering. `insert_blocks.actions.blocks` are nested serialized templates, not live document children. An implementation MAY store action block templates in hidden child records, but they MUST NOT render as normal children.

Rendering behavior: render as a button with label/icon and optional disabled/loading/error states. The client MUST validate action configuration before enabling execution.

Editing behavior: edit label/icon and action list through a structured configuration UI. Execution MUST be transactional from the client perspective: either all local mutations apply or a recoverable error is shown. Dangerous actions SHOULD require confirmation.

Keyboard/markdown/slash: `/button` inserts it. Button activation by keyboard (`Enter`/`Space`) MUST run the button only when the button control, not its label editor, is focused.

Drag/drop: button block moves as a standalone block. Blocks dragged into a button configuration MAY become insertion templates only in configuration mode.

Accessibility: native button semantics, disabled state, progress state, and confirmation dialogs MUST be accessible.

Serialization example:

```json
{
  "object": "block",
  "id": "blk_button_1",
  "type": "button",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "button": {
    "label": [{ "type": "text", "text": { "content": "Add task" }, "plain_text": "Add task" }],
    "icon": { "type": "emoji", "emoji": "➕" },
    "actions": [
      { "type": "add_page_to_data_source", "data_source_id": "ds_tasks", "properties": { "Status": { "status": "Not started" } } }
    ],
    "confirmation": { "title": "Create task?" }
  }
}
```

Compatibility notes: Notion product documents buttons. Public API support for reading/writing modern button blocks may be unavailable or version-dependent; a client SHOULD preserve unknown API button payloads and MAY serialize this shape as client-only.

Edge cases: partial failure, lost third-party auth, missing target database/property, or insufficient permissions MUST produce an error state and not silently drop actions. Buttons MUST NOT execute merely because their block is pasted or imported.


### 6.29 Child database compatibility block (`child_database`)

Purpose: represent a Notion public-API child database block or inline/full-page database placeholder. This is the compatibility bridge between old block-shaped database surfaces and the richer `database_view` model below.

Schema fields:

```ts
export type ChildDatabaseBlock = BaseBlock<'child_database', {
  title: string;
  database_id?: DatabaseId;
  data_source_ids?: DataSourceId[];
  default_view_id?: ViewId;
  is_inline?: boolean;
}>;
```

Allowed children: arbitrary page blocks MUST NOT be direct children of `child_database`. Rows are pages under data sources; row page bodies are separate page/block trees. If an import exposes child blocks here, the importer MUST map them to database/data-source/page resources or preserve them as unsupported raw data.

Rendering behavior: render as an inline database surface or database page link depending on `is_inline` and host navigation context. When richer view state is available, the renderer SHOULD delegate to a `database_view` block or equivalent database view component.

Editing behavior: users can rename the database title, open the database, manage data sources/views, and add pages/rows when permissions allow. Schema/property editing MUST happen through database/data-source operations, not through generic block child editing.

Keyboard/markdown/slash: `/database`, `/table` in the database category, and linked database commands MAY create this block for public-API compatibility; new client-native documents SHOULD prefer `database_view` when view identity/configuration matters.

Drag/drop: moving the block changes where the database is displayed. Dragging rows/cards inside the rendered database follows database view semantics, not block-tree child movement.

Accessibility: expose a labeled collection region with the database title, layout, row count if known, and keyboard access to rows/views/properties.

Serialization example:

```json
{
  "object": "block",
  "id": "blk_child_db_1",
  "type": "child_database",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "child_database": {
    "title": "Tasks",
    "database_id": "db_tasks",
    "data_source_ids": ["ds_tasks"],
    "default_view_id": "view_tasks_table",
    "is_inline": true
  }
}
```

Compatibility notes: Notion public API exposes `child_database` blocks and separate database/data-source/view resources. An implementation MUST preserve `child_database` during import/export and MAY normalize it internally to `database_view` plus resource records.

Edge cases: linked databases, multi-source databases, and dashboards may not round-trip through a single `child_database` block; preserve view/resource IDs when known and fall back to `unsupported` metadata when the API shape is insufficient.

### 6.30 Database/data-source view block (`database_view` / API `child_database` compatibility)

Purpose: embed an inline or linked database/data-source view in a page. It displays pages/rows through table, board, gallery, list, calendar, timeline, chart, form, map, dashboard, or host-defined view layouts.

Schema fields:

```ts
export type DatabaseViewBlock = BaseBlock<'database_view', {
  database_id: DatabaseId;
  data_source_id?: DataSourceId;
  view_id?: ViewId;
  title?: RichText;
  is_inline?: boolean;
  linked?: boolean;
  source_mode?: 'database' | 'data_source' | 'view';
  layout?: 'table' | 'board' | 'calendar' | 'timeline' | 'gallery' | 'list' | 'form' | 'chart' | 'map' | 'dashboard';
  filter?: unknown;
  sorts?: unknown[];
  grouping?: unknown;
  visible_property_ids?: string[];
  configuration?: Record<string, unknown>;
}>;
```

Allowed children: database rows are pages under a data source, not direct block children. The block MUST NOT accept arbitrary child blocks. Page bodies for row pages are separate block trees under those page IDs. Legacy API `child_database` may appear as a block; clients SHOULD map it to `database_view` plus a database/data-source object when possible.

Rendering behavior: render an inline collection widget with view tabs, property columns/cards, filters, sorts, grouping, new-row controls, and open-page behavior for rows/cards. Full-page databases are page-level renderings of the same database object. Linked views MUST reflect source schema/data while preserving local view configuration.

Editing behavior: users can add rows/pages, edit properties, create/edit views, filter/sort/group, reorder columns/cards where the layout permits, open row pages, and convert inline/full-page display if the host supports it. Property edits MUST use schema-aware editors. Formula/rollup values are computed and MUST NOT be directly edited.

Keyboard/markdown/slash: `/database`, `/table` (when database category), `/board`, `/calendar`, `/gallery`, `/list`, and linked database commands SHOULD be supported. The simple table `/table` command MUST be distinguishable from database table creation.

Drag/drop: database view block moves as a block. Rows/cards inside the view have separate drag semantics: reorder within manual order, change grouping property when dragged between board groups, or reject under active sort/filter when semantic mutation is unclear. Dropping blocks into a row page should target that page body, not the view block.

Accessibility: database views MUST expose grid/list/board semantics appropriate to layout. Cell editors need labels from property names. Keyboard users MUST be able to navigate rows/cards/cells, edit properties, open pages, and add rows.

Serialization example:

```json
{
  "object": "block",
  "id": "blk_db_view_1",
  "type": "database_view",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "database_view": {
    "database_id": "db_projects",
    "data_source_id": "ds_projects",
    "view_id": "view_active_projects",
    "title": [{ "type": "text", "text": { "content": "Projects" }, "plain_text": "Projects" }],
    "is_inline": true,
    "linked": false,
    "layout": "table",
    "visible_property_ids": ["title", "status", "owner"]
  }
}
```

Compatibility notes: Public Notion API currently models databases, data sources, and views as first-class resources and historically exposes inline databases as `child_database` blocks. A Notion-compatible client SHOULD import/export `child_database.title` and database metadata, but MAY use `database_view` internally to represent linked views, selected data source, and view state.

Edge cases: collections over 1,000 rows may not append visually at the end under active sorting/filtering; define insertion semantics. Missing properties referenced by filters/sorts MUST put the view into repair mode. Linked data sources may allow local view changes without mutating source views. Multi-source databases require clear source selection per view.

### 6.31 Unsupported or future block (`unsupported`)

Purpose: preserve blocks the client cannot understand or edit.

Schema fields:

```ts
export type UnsupportedBlock = BaseBlock<'unsupported', {
  original_type?: string;
  raw?: unknown;
  reason?: 'unknown_type' | 'unsupported_version' | 'permission_filtered' | 'import_error';
}>;
```

Allowed children: MAY preserve known child IDs if the imported representation exposes them; the editor MUST NOT allow arbitrary child editing unless it can maintain semantics.

Rendering behavior: show a safe placeholder with original type if known and actions to retry import, open in source app, or remove. Do not render raw HTML/scripts from unknown payloads.

Editing behavior: selectable, movable, duplicable, deletable. Direct editing disabled unless a plugin claims the original type.

Keyboard/markdown/slash: no creation command except developer/test tools.

Drag/drop: standalone unless child semantics are known. Moving MUST preserve raw payload.

Accessibility: placeholder MUST announce unsupported content and original type.

Serialization example:

```json
{
  "object": "block",
  "id": "blk_unknown_1",
  "type": "unsupported",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "unsupported": { "original_type": "meeting_notes", "reason": "unsupported_version", "raw": { "meeting_notes": { "status": "processing" } } }
}
```

Known obscure or version-specific Notion blocks such as `meeting_notes`, older `transcription`, AI-generated blocks, or provider-specific internal blocks MUST be imported as `unsupported` unless a dedicated plugin implements their semantics. A plugin MAY render meeting notes/transcription as a generated transcript/media block, but it MUST preserve raw payload fields and MUST NOT pretend unsupported content is fully editable.

Edge cases: public Notion API may return `unsupported` for internal blocks. Implementations MUST preserve enough raw data to round-trip; if not possible, they MUST warn before destructive edits.

## 7. Media and file compatibility notes

File-like blocks (`image`, `video`, `audio`, `file`, `pdf`) SHOULD support three source classes: external URL, hosted file reference with expiring URL, and upload-session reference. Public Notion API uses `file`, `file_upload`, and `external` file objects; this spec's `FileRef` intentionally mirrors that model while keeping upload mechanics outside client-only block semantics.

Clients MUST show upload progress/error placeholders without corrupting block identity. Replacing a pending upload with the final file reference MUST be an undoable block payload update. Hosted URLs that expire MUST be treated as cache data; stable asset/upload IDs are canonical.

## 8. Command, drag/drop, and selection requirements by family

- Text-family blocks MUST support rich-text selection, cross-block copy/paste, block selection, type transforms, color, comments, and inline mentions.
- Container-family blocks MUST distinguish dropping `before`, `after`, and `inside`. Blue-guide or equivalent indicators MUST show only valid destinations.
- Layout-family blocks MUST provide keyboard alternatives for column/table operations.
- Generated blocks (`breadcrumb`, `table_of_contents`, database views) MUST persist configuration, not duplicated generated text.
- Media/embed blocks MUST be focusable as blocks and expose internal controls without trapping keyboard navigation.
- Database views MUST own internal row/cell/card selection separate from page block selection.

## 9. Public API serialization strategy

A client that interoperates with Notion-like APIs SHOULD serialize blocks using the public shape:

```json
{
  "object": "block",
  "id": "blk_example",
  "type": "paragraph",
  "parent": { "type": "page_id", "page_id": "page_1" },
  "created_time": "2026-03-11T12:00:00.000Z",
  "last_edited_time": "2026-03-11T12:00:00.000Z",
  "in_trash": false,
  "has_children": false,
  "paragraph": { "rich_text": [], "color": "default" }
}
```

For client-only fields (`order_key`, `client`, `alt`, `metadata`, `button.actions`, `database_view.configuration`, etc.), serializers MUST either place them in an extension namespace or strip them when sending to strict public APIs. Importers MUST tolerate additive fields, opaque IDs/cursors, `in_trash` replacing deprecated `archived`, and version-specific block type changes such as renamed internal blocks.

## 10. Edge-case checklist

A conforming editor SHOULD test at least these cases:

- Undo after every markdown transform and slash command.
- IME composition around `/`, `@`, `[[`, `+`, and markdown triggers.
- Cross-block text selection, whole-block selection, and database cell selection in the same page.
- Turning blocks with children into types that cannot contain children.
- Moving/copying a selected parent and descendants without duplicates or cycles.
- Column collapse and empty-column deletion on mobile widths.
- Table width changes, row repair, and header toggles.
- Media upload cancellation, expired file URLs, and failed external embeds.
- Synced block source deletion, copy unsync, permission denial, and cycle prevention.
- Button action validation, confirmation, partial failure, and paste/import safety.
- Database view row insertion under active filters/sorts/grouping and missing schema references.
- Unsupported/future block round-tripping without executing unknown content.
