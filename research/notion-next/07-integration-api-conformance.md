# Notion-compatible editor integration API and conformance specification

Status: normative implementation specification for client-only TypeScript/browser editors.  
Target date: 2026-05-01.  
Scope: web applications running in modern Chrome, Safari, and Firefox.  
Non-scope: backend architecture, server storage, network sync protocols, server APIs, and vendor-specific Notion private internals.

This document specifies the integration surface a host web app uses to embed and extend a Notion-compatible editor. It draws on the preceding Notion architecture research: Notion content is block-first; pages are block trees with stable IDs; rich text is semantic typed spans; databases are page collections with schemas, data sources, views, formulas, relations, and rollups; commands, slash menus, Markdown shortcuts, block selection, drag/drop, comments, mentions, synced blocks, files, embeds, offline caching, and accessibility are first-class product behavior.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

---

## 1. Goals and non-goals

### 1.1 Goals

An implementation conforming to this specification MUST provide a browser-only TypeScript package that host apps can mount into their own DOM and integrate with their own state, storage, analytics, file services, and UI shell. The API MUST cover:

- editor creation, mounting, unmounting, focus, and destruction;
- initial document loading and replacement;
- controlled and uncontrolled document modes;
- transaction/change events and selection events;
- command execution, command providers, slash menus, and Markdown input rules;
- stable document snapshots and import/export;
- persistence adapters for memory, localStorage, IndexedDB, app state, or host callbacks;
- theming, localization, accessibility, telemetry, error reporting, file/embed resolution, and custom blocks/plugins.

### 1.2 Non-goals

The integration API MUST NOT require a backend. A conforming implementation MAY integrate with a backend through host-supplied adapters, but the editor core MUST run without server access.

This specification does not require Notion API credential handling, Notion server import, multi-user realtime collaboration, or a server-side transaction validator. When such features are present, they MUST be implemented through browser-safe adapters and MUST NOT be hard dependencies of the editor core.

---

## 2. Package and module boundaries

A conforming implementation MUST expose package boundaries equivalent to the following table. Names are illustrative; the separation is normative.

| Module | Required in Core Editor | Browser-only | Responsibilities |
| --- | --- | --- | --- |
| `@notion-next/model` | MUST | MUST | TypeScript types, validators, document model, operation model, import/export schemas. No DOM dependency. |
| `@notion-next/core` | MUST | MUST | Editor state, transactions, commands, selection model, undo/redo, plugin registry. No framework dependency. |
| `@notion-next/dom` | MUST | MUST | DOM mounting, contenteditable integration, clipboard, drag/drop, keyboard dispatch, browser observers. |
| `@notion-next/react` or framework adapter | SHOULD | MUST | Optional host framework bindings. MUST be a thin wrapper over core/dom. |
| `@notion-next/persistence` | MUST | MUST | Memory, localStorage, IndexedDB, and host-callback adapters. |
| `@notion-next/blocks` | MUST | MUST | Built-in Notion-compatible block definitions. |
| `@notion-next/databases` | Required for Database-Capable | MUST | Data sources, property schemas/values, views, filters/sorts, formulas/rollups. |
| `@notion-next/media` | Required for Embeds/Media-Capable | MUST | File placeholders, images, video/audio, bookmarks, embeds, link previews through resolvers. |
| `@notion-next/a11y` | Required for Accessibility-Conformant | MUST | Accessibility assertions, keyboard maps, live announcements, high-contrast/reduced-motion helpers. |

The core packages MUST be ESM-compatible, MUST ship TypeScript declarations, SHOULD provide source maps, and MUST NOT use Node-only APIs in browser entry points. Any worker entry point MUST be explicitly exported so host build tools can bundle it under strict CSP.

---

## 3. Document model contract

### 3.1 Core identifiers

All persisted editor objects MUST have stable IDs. Block and page IDs MUST be opaque strings. Implementations SHOULD generate UUIDv4 or collision-resistant IDs in the browser. Host apps MAY provide an `idFactory`.

```ts
type UUID = string;
type BlockId = string;
type PageId = BlockId;
type DataSourceId = string;
type PropertyId = string;
```

### 3.2 Document envelope

The editor MUST use a typed block tree rather than an HTML blob.

```ts
export interface NotionDocument {
  object: 'document';
  schemaVersion: string;
  rootPageId: PageId;
  blocks: Record<BlockId, NotionBlock>;
  childOrder: Record<BlockId, BlockId[]>;
  pages?: Record<PageId, PageMetadata>;
  databases?: Record<string, DatabaseRecord>;
  dataSources?: Record<DataSourceId, DataSourceRecord>;
  views?: Record<string, ViewRecord>;
  assets?: Record<string, AssetRecord>;
  locale?: string;
}

export interface NotionBlock<TType extends string = string, TProps = unknown> {
  object: 'block';
  id: BlockId;
  type: TType;
  parent: ParentRef;
  properties: TProps;
  hasChildren: boolean;
  inTrash?: boolean;
  createdTime?: string;
  lastEditedTime?: string;
  createdBy?: ActorRef;
  lastEditedBy?: ActorRef;
  unsupported?: boolean;
}
```

The implementation MUST preserve unknown block types and unknown properties during load, edit, snapshot, import/export, and persistence unless a host explicitly opts into lossy normalization. Turning a block into another type MUST preserve children and ignored properties.

### 3.3 Rich text

Text-bearing blocks MUST store semantic rich text segments, not raw HTML.

```ts
export type RichText = Array<TextSpan | MentionSpan | EquationSpan>;

export interface TextSpan {
  type: 'text';
  text: { content: string; link?: { url: string } | null };
  annotations?: TextAnnotations;
  plainText?: string;
  href?: string | null;
}

export interface MentionSpan {
  type: 'mention';
  mention:
    | { type: 'page'; pageId: PageId }
    | { type: 'database'; databaseId: string }
    | { type: 'data_source'; dataSourceId: DataSourceId }
    | { type: 'user'; userId: string }
    | { type: 'date'; start: string; end?: string; timeZone?: string }
    | { type: 'link_preview'; url: string }
    | { type: 'template_mention'; value: 'today' | 'now' | 'me' };
  annotations?: TextAnnotations;
  plainText?: string;
  href?: string | null;
}

export interface EquationSpan {
  type: 'equation';
  equation: { expression: string };
  annotations?: TextAnnotations;
  plainText?: string;
}
```

Normalization MUST merge adjacent equivalent text spans, MUST retain mention identity through editing and export, and MUST prevent invalid nesting of inline entities.

### 3.4 Required core block types

The Core Editor conformance class MUST implement at least these blocks:

- `page`, `paragraph`, `heading_1`, `heading_2`, `heading_3`;
- `bulleted_list_item`, `numbered_list_item`, `to_do`, `toggle`, `quote`, `divider`, `callout`;
- `code`, `equation`, `table_of_contents`, `breadcrumb`, `unsupported`;
- `column_list`, `column`, `table`, `table_row` if layout blocks are enabled by the host.

The Full Notion-Compatible Editor conformance class MUST additionally implement child pages/databases, synced blocks, templates/buttons, comments/suggestions surfaces, page links/backlinks, mentions, all required database blocks, and all required media/embed blocks.

---

## 4. Editor lifecycle API

### 4.1 Creation

An implementation MUST expose an editor factory. The factory MUST NOT mutate the DOM until `mount()` is called.

```ts
import { createNotionEditor } from '@notion-next/dom';

const editor = createNotionEditor({
  document: initialDocument,
  mode: 'uncontrolled',
  persistence: indexedDbAdapter,
  plugins: [myBlockPlugin],
  locale: 'en-US',
  theme: { colorScheme: 'system' },
});
```

```ts
export interface CreateEditorOptions {
  document?: NotionDocument | Promise<NotionDocument>;
  loadDocument?: () => Promise<NotionDocument>;
  mode?: 'controlled' | 'uncontrolled';
  readOnly?: boolean | ((ctx: PermissionContext) => boolean);
  persistence?: PersistenceAdapter;
  commandProviders?: CommandProvider[];
  plugins?: EditorPlugin[];
  fileResolver?: FileResolver;
  embedResolver?: EmbedResolver;
  telemetry?: TelemetryHook;
  errorReporter?: ErrorReporter;
  locale?: string;
  messages?: LocaleMessages;
  theme?: ThemeConfig;
  idFactory?: () => string;
  clock?: () => Date;
  featureFlags?: Record<string, boolean>;
}
```

If both `document` and `loadDocument` are supplied, `document` MUST be used for initial render and `loadDocument` MAY refresh it asynchronously. If neither is supplied, the editor MUST create a valid empty page document.

### 4.2 Mounting and unmounting

```ts
await editor.mount(containerElement);
editor.focus({ blockId, offset: 0 });
await editor.unmount();
await editor.destroy();
```

`mount(element)` MUST:

1. validate that `element` is an `HTMLElement` connected or connectable to the current `document`;
2. render the current document;
3. install DOM event handlers, observers, clipboard handlers, keyboard handlers, and drag/drop handlers;
4. restore persisted selection when valid; and
5. emit `lifecycle:mounted`.

`unmount()` MUST remove DOM event listeners and observers and MUST NOT discard editor state. `destroy()` MUST call `unmount()`, flush pending persistence when possible, unsubscribe adapters, clear timers/workers owned by the editor, and make later method calls fail with a stable `editor_destroyed` error code.

Mounting the same editor twice simultaneously MUST throw `already_mounted`. Moving an editor between containers MUST be performed as `unmount()` followed by `mount()`.

### 4.3 Initial loading states

The editor MUST expose loading, ready, degraded, and failed lifecycle states.

```ts
type EditorStatus =
  | { state: 'loading' }
  | { state: 'ready' }
  | { state: 'degraded'; reason: ErrorCode; recoverable: boolean }
  | { state: 'failed'; error: EditorError };
```

If loading fails and no valid persisted fallback exists, the editor MUST render an accessible error state and MUST NOT render a partially invalid document as editable content. If a cached document is available and refresh fails, the editor MAY enter `degraded` and continue editing according to adapter policy.

---

## 5. Controlled and uncontrolled modes

### 5.1 Uncontrolled mode

In uncontrolled mode, the editor owns its internal state. Host apps receive change events and MAY persist snapshots, but MUST NOT be required to echo state back.

```ts
const editor = createNotionEditor({
  mode: 'uncontrolled',
  document,
  persistence: createIndexedDbAdapter({ databaseName: 'notes' }),
});
```

The editor MUST apply valid local transactions immediately and MUST keep undo/redo, selection, and pending persistence internally consistent.

### 5.2 Controlled mode

In controlled mode, the host owns the canonical document. The editor MUST emit transaction drafts and MUST wait for `setDocument()` or `acceptTransaction()` according to the configured policy.

```ts
const editor = createNotionEditor({ mode: 'controlled', document });

editor.on('transaction', tx => {
  const next = applyTransaction(appState.document, tx);
  setAppState({ document: next });
  editor.acceptTransaction(tx.id, next);
});
```

A controlled editor MUST support both policies:

| Policy | Requirement |
| --- | --- |
| `optimistic` | Editor applies locally, emits transaction, and host MUST confirm or reject. Rejection MUST rollback or rebase selection. |
| `strict` | Editor emits proposed transaction and MUST NOT mutate content until host accepts. UI MUST remain responsive and indicate pending command state. |

Controlled mode MUST NOT write to a persistence adapter unless `persistenceRole: 'cache' | 'drafts'` is explicitly configured.

### 5.3 Document replacement

`setDocument(document, options)` MUST replace the current document atomically. If `preserveSelection` is true, the editor MUST remap selection by block IDs and rich-text offsets where possible; otherwise it MUST place focus at the document start or host-specified selection.

---

## 6. Change events, transactions, and snapshots

### 6.1 Operation model

All editor mutations MUST be represented as transactions containing typed operations. Direct DOM mutation MUST NOT be the source of truth.

```ts
export interface EditorTransaction {
  id: string;
  time: string;
  source: 'keyboard' | 'input' | 'paste' | 'drop' | 'command' | 'api' | 'import' | 'persistence';
  operations: EditorOperation[];
  beforeSelection?: EditorSelection;
  afterSelection?: EditorSelection;
  metadata?: Record<string, unknown>;
}
```

Core operations MUST include:

- create, insert, move, duplicate, trash, restore block;
- split and merge text blocks;
- set block type while preserving properties;
- patch rich text range and annotations;
- indent, outdent, wrap, unwrap;
- set page metadata;
- set selection;
- import/replace subtree.

Database-Capable implementations MUST add operations for data source schema changes, page property changes, view changes, relation edges, formula/rollup invalidation, and database row/card moves.

### 6.2 Events

The editor MUST provide typed event subscription and unsubscription.

```ts
const off = editor.on('change', event => {
  console.log(event.transaction, event.snapshot.version);
});
off();
```

Required events:

| Event | When emitted | Required payload |
| --- | --- | --- |
| `lifecycle` | mount/unmount/destroy/status changes | status, timestamp |
| `transaction` | before or after local transaction depending mode | transaction, document version, source |
| `change` | committed local document state changed | transaction, snapshot metadata, dirty flag |
| `selectionChange` | text/block/cell selection changed | selection, cause |
| `command` | command started/completed/failed | command ID, args, result/error |
| `persistence` | adapter save/load/sync state changes | adapter ID, status, error? |
| `error` | recoverable or fatal editor error | stable error object |
| `telemetry` | if host opts into local event stream | structured telemetry event |

Event handlers MUST run outside the editor mutation critical section. Exceptions thrown by handlers MUST be reported through `errorReporter` and MUST NOT corrupt editor state.

### 6.3 State snapshots

`getSnapshot()` MUST return an immutable, serializable state snapshot.

```ts
export interface EditorSnapshot {
  version: number;
  document: NotionDocument;
  selection: EditorSelection | null;
  pendingTransactions: EditorTransaction[];
  dirty: boolean;
  generatedAt: string;
}
```

Snapshots MUST be deterministic for equal document state except for declared metadata such as `generatedAt`. A host MUST be able to persist and later reload a snapshot without losing block IDs, unknown fields, selection anchors that still resolve, database schemas, view definitions, assets, or plugin-owned serializable state.

---

## 7. Commands, slash commands, shortcuts, and providers

### 7.1 Command registry

The editor MUST expose a declarative command registry shared by slash menu, add-block menu, block handle menu, keyboard shortcuts, mobile/touch toolbar, command palette, and host API.

```ts
export interface EditorCommand<TArgs = unknown> {
  id: string;
  title: string;
  description?: string;
  aliases: string[];
  category: 'basic' | 'inline' | 'media' | 'database' | 'advanced' | 'style' | 'host';
  icon?: IconSpec;
  shortcuts?: KeyboardShortcut[];
  contexts: CommandContextKind[];
  isEnabled(ctx: CommandContext): boolean;
  run(ctx: CommandContext, args: TArgs): Promise<CommandResult> | CommandResult;
}
```

Command handlers MUST emit transactions or documented side effects through adapters. They MUST NOT directly edit DOM nodes.

### 7.2 Required commands

Core Editor MUST implement commands for text, page link, paragraphs, headings, lists, to-dos, toggles, quote, divider, code, equation, callout, table of contents, duplicate, delete, move up/down, indent/outdent, turn into, color, comment placeholder, copy block link, undo, redo, and search command palette.

Full Notion-Compatible Editor MUST additionally implement commands for child page, child database, synced block, template/button, breadcrumb, mentions, date/reminder, emoji, database insertion, all media/embed block creation, relation/page link creation, and block move-to-page.

Database-Capable Editor MUST implement table/list/board/calendar/gallery/timeline views, property creation/editing, row/page creation, relation picker, formula editor, rollup configuration, filter/sort/group commands, and bulk row edit.

### 7.3 Slash menu behavior

Typing `/` in an editable text context MUST open an accessible command menu unless escaped or disabled in that block type. The menu MUST:

- filter by aliases, title, keywords, and localized labels;
- rank exact aliases before fuzzy matches, and SHOULD incorporate recent/frequent use;
- support keyboard navigation, pointer selection, screen reader announcements, and `Esc` dismissal;
- restore focus and selection after dismissal or command execution;
- allow literal `/` insertion by dismissal without command execution.

### 7.4 Markdown input rules

The editor MUST implement these Notion-compatible live input rules in plain rich-text blocks:

| Input at block start | Required operation |
| --- | --- |
| `* `, `- `, `+ ` | convert to `bulleted_list_item` and remove marker |
| `[] ` | convert to `to_do` unchecked and remove marker |
| `1. `, `a. `, `i. ` | convert to `numbered_list_item` and remove marker |
| `# `, `## `, `### ` | convert to heading 1/2/3 and remove marker |
| `> ` | convert to `toggle` and remove marker |
| `" ` | convert to `quote` and remove marker |
| `---` | convert empty/current block to `divider` |

Inline shortcuts `**bold**`, `*italic*`, `` `code` ``, and `~strike~` MUST be supported where they do not conflict with IME composition or localized input. Input rules MUST NOT run inside code blocks, equations, or blocks/plugins that opt out. Every input-rule conversion MUST be undoable as one user intent.

### 7.5 Keyboard dispatch

Keyboard shortcuts MUST be context-aware across text selection, block selection, menu focus, database cell selection, modal dialogs, and read-only mode. The implementation MUST provide a way for host apps to inspect and override key bindings without monkey-patching DOM listeners.

---

## 8. Selection, editing modes, clipboard, and drag/drop

### 8.1 Selection model

The editor MUST represent selection explicitly.

```ts
export type EditorSelection =
  | { mode: 'text'; anchor: TextPoint; focus: TextPoint }
  | { mode: 'blocks'; anchorBlockId: BlockId; focusBlockId: BlockId; selectedBlockIds: BlockId[] }
  | { mode: 'cells'; dataSourceId: DataSourceId; anchor: CellCoord; focus: CellCoord }
  | { mode: 'none' };
```

Core Editor MUST support caret/range selection in rich text and whole-block selection. Database-Capable Editor MUST support cell/row/card selection. `Esc`, arrow keys, `Shift` extension, `Enter`, delete/backspace, duplicate, and move commands MUST work without pointer input.

### 8.2 Clipboard

Copy/cut MUST place at least `text/plain` and SHOULD place `text/html`. When copying inside the same editor family, the implementation MUST also place a custom MIME payload such as `application/x-notion-next-fragment+json` containing blocks, child order, rich text, assets references, and plugin data needed for lossless paste.

Paste MUST classify content in this order:

1. trusted internal fragment from same origin/editor family;
2. files from clipboard items;
3. HTML;
4. Markdown if declared or detected;
5. plain text/URLs.

If the Async Clipboard API is unavailable or denied, the editor MUST fall back to browser `copy`, `cut`, and `paste` events. Clipboard handling MUST be sanitized and MUST NOT inject unsanitized HTML.

### 8.3 Drag/drop

The editor MUST support pointer and keyboard alternatives for block movement. Pointer drag/drop MUST use semantic drop targets: before, after, inside/nest, side-by-side column, database group, file upload, or forbidden. Drop guides MUST reflect valid operations only.

Drag/drop MUST produce the same transaction operations as keyboard/menu moves. Holding platform duplicate modifiers (`Alt`/`Option`) SHOULD duplicate instead of move. Moving a block into its descendant MUST be rejected. Moving across pages or database groups MUST update structural parent/order and any affected database grouping property in a single transaction.

---

## 9. Persistence adapters

### 9.1 Adapter interface

The editor MUST integrate persistence through an explicit adapter.

```ts
export interface PersistenceAdapter {
  id: string;
  capabilities: {
    durable: boolean;
    async: boolean;
    quotaBytes?: number;
    supportsTransactions?: boolean;
    supportsBroadcast?: boolean;
  };
  load(key: string): Promise<PersistedSnapshot | null>;
  save(key: string, snapshot: PersistedSnapshot): Promise<void>;
  remove?(key: string): Promise<void>;
  watch?(key: string, cb: (event: PersistenceWatchEvent) => void): () => void;
  flush?(): Promise<void>;
}
```

The implementation MUST provide adapters for:

- memory storage;
- localStorage with quota/error handling;
- IndexedDB with versioned object stores and transaction failure recovery;
- host callback/app-state persistence.

The editor MAY provide OPFS or WASM SQLite adapters, but these MUST be optional and MUST account for worker/CSP/browser support.

### 9.2 Failure behavior

Persistence failures MUST NOT silently discard edits. On adapter failure, the editor MUST:

1. keep edits in memory when possible;
2. emit a `persistence` event with stable error code;
3. mark snapshot `dirty`;
4. expose retry/export options;
5. avoid clearing undo/redo until the host resolves the failure.

If localStorage quota is exceeded, the adapter SHOULD fall back to compressed snapshots or IndexedDB only when explicitly configured. If IndexedDB is blocked/private/unavailable, the editor MUST enter degraded mode and report `storage_unavailable`.

### 9.3 Multi-tab behavior

If an adapter supports cross-tab updates through `BroadcastChannel`, `storage` events, SharedWorker, or IndexedDB polling, it MUST provide deterministic conflict policy: last accepted snapshot, transaction merge, host-controlled conflict, or read-only secondary tab. The policy MUST be exposed in adapter capabilities.

---

## 10. Import/export

### 10.1 Required formats

Core Editor MUST import and export:

- native JSON snapshot;
- HTML fragment/document;
- plain text;
- Markdown with Notion-compatible block mappings for supported blocks.

Full Notion-Compatible Editor MUST preserve all built-in block types through native JSON and SHOULD export graceful Markdown/HTML fallbacks for blocks that Markdown cannot represent.

Database-Capable Editor MUST export database schemas, rows-as-pages, property values, views, filters, sorts, relations, formulas, and rollups in native JSON. Markdown/HTML export MUST include visible view content and link to row pages where representable.

### 10.2 Import rules

Importers MUST sanitize untrusted HTML, MUST preserve source URLs for bookmarks/embeds when safe, MUST create stable new IDs for imported blocks unless the host explicitly requests ID preservation, and MUST report unsupported constructs rather than dropping them silently.

```ts
const result = await editor.import({
  format: 'markdown',
  content: '# Roadmap\n\n[] Ship MVP',
  target: { parentBlockId: editor.rootPageId, position: 'end' },
});

if (result.warnings.length) console.warn(result.warnings);
```

### 10.3 Export rules

Exports MUST be deterministic for identical snapshots and options. Exporters MUST support selection/subtree export. Asset URLs MUST be resolved through `FileResolver`; if a file cannot be resolved, export MUST include an explicit placeholder or warning.

---

## 11. Theming and localization

### 11.1 Theming

The editor MUST support host-controlled theming via CSS custom properties and a typed theme object. It MUST NOT require global CSS resets. Theme variables MUST cover at least text, background, muted text, borders, selection, focus rings, block hover, menu surfaces, danger/success/warning states, code, mentions, database property colors, and Notion-style block colors/backgrounds.

The editor MUST support light, dark, and system color schemes. High contrast mode MUST be supported without relying solely on hue. Reduced motion preferences MUST disable non-essential animations and provide non-animated drag/drop and menu transitions.

### 11.2 Localization and i18n

All user-visible strings MUST be localizable. The editor MUST accept locale, messages, date/time/number formatters, text direction, and keyboard shortcut labels.

```ts
createNotionEditor({
  locale: 'fr-FR',
  messages: frenchMessages,
  direction: 'ltr',
  formatters: {
    date: new Intl.DateTimeFormat('fr-FR'),
    number: new Intl.NumberFormat('fr-FR'),
  },
});
```

The editor MUST support Unicode input, IME composition, RTL text inside rich text, localized date parsing hooks for date mentions, and locale-sensitive formula/function help when formulas are implemented. Keyboard shortcuts MUST be remappable because physical keyboard layouts differ.

---

## 12. Custom blocks, plugins, and command providers

### 12.1 Plugin interface

```ts
export interface EditorPlugin {
  id: string;
  version: string;
  blocks?: BlockDefinition[];
  commands?: CommandProvider;
  inputRules?: InputRule[];
  normalizers?: DocumentNormalizer[];
  importers?: Importer[];
  exporters?: Exporter[];
  themes?: ThemeContribution;
  messages?: LocaleContribution;
  onInstall?(api: PluginAPI): void | Promise<void>;
  onUninstall?(api: PluginAPI): void | Promise<void>;
}
```

Plugins MUST be isolated through documented APIs. A plugin MUST NOT require direct access to private editor internals. Plugin failures MUST be caught and reported with plugin ID.

### 12.2 Block definitions

```ts
export interface BlockDefinition<TProps = unknown> {
  type: string;
  schema: SchemaValidator<TProps>;
  supportsChildren: boolean | ((props: TProps) => boolean);
  allowedChildTypes?: string[] | 'any';
  render: BlockRenderer<TProps>;
  renderEditor?: BlockEditorRenderer<TProps>;
  normalize?: BlockNormalizer<TProps>;
  toMarkdown?: BlockMarkdownExporter<TProps>;
  fromMarkdown?: BlockMarkdownImporter<TProps>;
  toHtml?: BlockHtmlExporter<TProps>;
  commands?: EditorCommand[];
}
```

Custom blocks MUST serialize through snapshots, MUST participate in selection, copy/paste, drag/drop, undo/redo, accessibility labels, theming, and import/export warnings. Unknown custom blocks MUST render a stable unsupported-block placeholder rather than crashing.

### 12.3 Custom command providers

Command providers MAY add dynamic commands, such as app-specific templates or slash actions. Providers MUST return commands deterministically for a given context or declare that they are asynchronous. Async providers MUST support cancellation so stale slash menu queries do not update current UI.

---

## 13. File, media, bookmark, and embed resolvers

### 13.1 File resolver

The editor MUST NOT assume a built-in upload backend. Media operations MUST use a host-supplied resolver.

```ts
export interface FileResolver {
  pick?(accept: string): Promise<File[]>;
  createUpload(file: File, ctx: FileContext): Promise<FileUploadHandle>;
  getDisplayUrl(asset: AssetRecord): Promise<{ url: string; expiresAt?: string } | null>;
  revoke?(asset: AssetRecord): Promise<void>;
}
```

Image/video/audio/file blocks MUST render upload, progress, success, expired, unauthorized, and failed states. Private download URLs MUST be treated as expiring and MUST NOT be persisted as canonical asset identity unless the resolver declares them stable.

### 13.2 Embed resolver

```ts
export interface EmbedResolver {
  classifyUrl(url: string): Promise<EmbedOffer[]>;
  resolve(offer: EmbedOffer, ctx: EmbedContext): Promise<EmbedResolution>;
  refresh?(embedId: string): Promise<EmbedResolution>;
}
```

Pasting a URL MUST be able to offer link, mention, bookmark, embed, and provider-specific preview when available. Embed rendering MUST use sandboxed iframes where iframes are used, MUST honor CSP, MUST expose accessible titles, and MUST show failures such as unsupported URL, provider auth required, blocked by frame policy, network failure, or content removed.

---

## 14. Telemetry, diagnostics, and error reporting

Telemetry MUST be opt-in. The editor MUST NOT send telemetry to any third party by default. Host telemetry hooks MUST receive structured events and MUST be able to redact content.

```ts
export interface TelemetryHook {
  capture(event: TelemetryEvent): void;
}

export interface ErrorReporter {
  report(error: EditorError, context: ErrorContext): void;
}
```

Telemetry events SHOULD include command IDs, durations, block counts, adapter statuses, browser feature availability, and error codes. They MUST NOT include document text, URLs, file names, user identifiers, or clipboard content unless the host explicitly opts in.

Errors MUST use stable codes, human-readable messages, severity, recoverability, cause, and safe context.

```ts
export interface EditorError {
  code:
    | 'invalid_document'
    | 'schema_violation'
    | 'command_disabled'
    | 'storage_unavailable'
    | 'quota_exceeded'
    | 'clipboard_denied'
    | 'embed_blocked'
    | 'plugin_error'
    | 'browser_unsupported'
    | 'editor_destroyed'
    | string;
  message: string;
  severity: 'info' | 'warning' | 'error' | 'fatal';
  recoverable: boolean;
  cause?: unknown;
}
```

---

## 15. Browser support requirements

Target browsers are current stable Chrome, Safari, and Firefox as of 2026-05-01.

### 15.1 DOM and editing APIs

A conforming implementation MUST use standards-based DOM APIs and MUST avoid browser-specific private APIs. It MUST handle:

- `contenteditable` differences, including nested editable islands;
- `beforeinput` and `input` events, including `inputType`, cancellation, and fallback behavior;
- IME composition (`compositionstart/update/end`) without prematurely applying slash/Markdown rules;
- Selection and Range APIs for text selection and custom block selection overlays;
- focus management across menus, dialogs, iframes, and block widgets.

If `beforeinput` behavior differs by browser for a feature, the editor MUST provide a tested fallback using `keydown`, `input`, or controlled DOM reconciliation.

### 15.2 Clipboard

The editor SHOULD use Async Clipboard API when available and permitted. It MUST fallback to clipboard events. It MUST handle Safari and Firefox permission differences and MUST never require persistent clipboard permission for basic copy/paste.

### 15.3 Drag/drop and pointer

The editor MUST support Pointer Events for mouse, pen, and touch where available and MUST fallback to Mouse/Touch events only if needed. Native HTML Drag and Drop MAY be used for external file drops, but internal block movement SHOULD use pointer-driven semantic drag to avoid inconsistent browser drag images and selection behavior.

### 15.4 Observers and layout APIs

The editor MUST use `ResizeObserver` for block/embed/database layout and `IntersectionObserver` for lazy rendering or virtualization when available. If unavailable, it MUST degrade to scroll/resize listeners with documented performance limits.

### 15.5 Storage APIs

Memory and host-callback adapters MUST work in all target browsers. localStorage and IndexedDB adapters MUST detect disabled storage, private browsing failures, quota exceeded errors, transaction aborts, and blocked upgrades. Optional OPFS/WASM SQLite adapters MUST feature-detect OPFS, workers, SharedWorker, Web Locks, and cross-origin isolation requirements before use.

### 15.6 Security and CSP

The editor MUST support strict CSP deployments. It MUST NOT require `unsafe-eval` or inline scripts in core packages. Styles SHOULD be class/CSS-variable based and SHOULD NOT require inline style attributes except for sanitized dynamic geometry where unavoidable.

The editor MUST sanitize imported HTML, pasted HTML, embed HTML, SVG, and URLs. It MUST reject `javascript:` URLs and unsafe data URLs except safe image data URLs if explicitly allowed. Iframes MUST be sandboxed by default. Plugins that render HTML MUST pass through the same sanitizer or declare trusted rendering and be host-approved.

---

## 16. Accessibility requirements

Accessibility-Conformant implementations MUST satisfy these requirements in addition to Core Editor behavior.

### 16.1 Keyboard-only operation

Every authoring operation required by the conformance class MUST be possible without a mouse, including block creation, selection, move up/down, indent/outdent, turn into, delete, duplicate, comments, slash commands, database row/cell navigation, property editing, and media/embed block focus.

### 16.2 Screen reader support

The editor MUST expose meaningful roles, names, states, and descriptions for:

- the editor region and page title;
- blocks, block type, nesting level, collapsed/expanded state, checkbox state;
- slash/mention menus as combobox/listbox patterns;
- dialogs and popovers with focus traps and escape behavior;
- tables/databases with row/column/cell semantics;
- drag handles and keyboard move controls;
- upload/embed progress and errors.

The editor MUST provide polite live-region announcements for command completion, block moved, block converted, upload progress/failure, menu result counts, and validation errors.

### 16.3 Visual accessibility

The editor MUST provide visible focus indicators, text selection indicators, block selection indicators, and drop targets at WCAG-conformant contrast. Color choices MUST NOT be the only cue for status, property values, comments, or validation. Reduced motion MUST be honored.

### 16.4 Touch and zoom

Interactive controls MUST remain usable at browser zoom levels up to 200%. Touch targets for block handles, menus, checkboxes, toggles, drag affordances, and database controls SHOULD be at least 44 CSS pixels where layout permits.

---

## 17. Conformance classes

| Class | Purpose | Required feature set |
| --- | --- | --- |
| Core Editor | Block document editor embeddable in web apps | lifecycle API, block tree, rich text, core block types, slash commands, Markdown shortcuts, selection, undo/redo, clipboard, drag/drop, snapshots, persistence adapters, theming, localization, telemetry/error hooks |
| Full Notion-Compatible Editor | Complete Notion-like page editor | Core plus Database-Capable and Embeds/Media-Capable requirements, pages/subpages, synced blocks, comment surfaces, mentions, backlinks, templates/buttons, full command catalog, import/export fallbacks, and plugin API |
| Database-Capable Editor | Notion-style databases | Full or Core plus data sources, schemas, rows-as-pages, properties, views, filters/sorts/groups, table/list/board/calendar/gallery/timeline layouts, relations, rollups, formulas, database import/export/tests |
| Embeds/Media-Capable Editor | Files and external content | Core plus image/video/audio/file/PDF blocks, upload placeholders, file resolver, bookmark resolver, embed/link-preview resolver, sandboxing, progress/errors, drag/drop file insertion |
| Accessibility-Conformant Editor | WCAG-grade authoring surface | Applicable class plus keyboard-only parity, screen reader roles/announcements, high contrast, reduced motion, zoom/touch usability, a11y conformance tests |

Core Editor conformance MUST include all APIs in sections 2 through 15 that are not explicitly marked as database-only, media-only, or accessibility-only. Full Notion-Compatible Editor conformance MUST include Core Editor, Database-Capable Editor, and Embeds/Media-Capable Editor behavior, because Notion pages can contain databases, media, files, embeds, synced blocks, mentions, comments, and templates in the same document tree. Database-Capable and Embeds/Media-Capable MAY be claimed independently by products that intentionally embed only those feature families. Accessibility-Conformant MAY be claimed with any other class, but a Full Notion-Compatible product SHOULD also claim Accessibility-Conformant before being described as production-ready.

An implementation MAY claim multiple classes. A claim MUST publish the exact version of this spec, supported browsers, known deviations, and test results.

---

## 18. Conformance test matrix

### 18.1 Test environments

Implementations claiming conformance MUST run tests on current stable Chrome, Safari, and Firefox as of the claim date. The test matrix MUST include desktop pointer/keyboard, touch-capable viewport simulation, light/dark/high-contrast modes where available, reduced motion, English plus at least one non-English locale, and IME input.

### 18.2 Required conformance tests

| Area | Required tests |
| --- | --- |
| Document model validation | valid empty document; nested blocks; unknown block preservation; invalid parent cycles rejected; type conversion preserves properties/children; unsupported block renders safely |
| Editor operations | create/split/merge/move/delete/duplicate/indent/outdent/turn-into; undo/redo; controlled strict/optimistic acceptance/rejection; snapshot reload |
| Slash commands | `/` opens menu; alias filtering; exact/fuzzy ranking; command execution; `Esc` literal slash; async provider cancellation; disabled command explanation |
| Markdown shortcuts | all required line-start rules; inline marks; undo boundaries; no rules in code/equation; IME safety |
| Selection | caret/range; cross-block text selection where browser permits; block selection with `Esc`; range extension; copy/cut/paste; selection remapping after transactions |
| Drag/drop | reorder, nest, outdent, move multi-block range, duplicate modifier, reject invalid drop, file drop, keyboard equivalent |
| Databases | schema creation/rename/delete; stable property IDs; row pages; table/list/board/calendar/gallery/timeline views; filters/sorts/groups; relations; formulas; rollups; large property values |
| Import/export | native JSON round trip; Markdown import/export; HTML sanitization; unsupported constructs warned; assets resolved/fallback; subtree export |
| Persistence failures | localStorage quota; IndexedDB unavailable/blocked/abort; adapter save rejection; dirty state retained; retry/export path; multi-tab conflict policy |
| Performance | 1,000-block page edit; 10,000-block read/virtualized render; database view with 10,000 rows and 100 properties; slash menu under 100 ms for built-ins; keystroke local apply under one frame on reference hardware |
| Cross-browser | beforeinput/input differences; clipboard fallbacks; pointer/touch; observer fallbacks; storage private mode; composition events; Firefox selection differences documented |
| Accessibility | keyboard-only full flow; screen reader menu announcements; focus restoration; high contrast; reduced motion; zoom 200%; axe or equivalent static checks plus manual SR smoke tests |
| Security | pasted HTML sanitizer; dangerous URL rejection; sandboxed iframes; CSP test without unsafe-eval/inline scripts; plugin error isolation |

### 18.3 Test API

The implementation SHOULD expose a test harness for deterministic transactions.

```ts
const harness = createEditorHarness({ document, plugins });
await harness.type('[] ');
harness.expectTransaction([
  { op: 'set_block_type', type: 'to_do' },
  { op: 'replace_text', text: '' },
]);
```

Conformance tests MUST assert both document state and emitted events, not DOM appearance alone.

---

## 19. TypeScript host integration examples

### 19.1 Uncontrolled editor with IndexedDB persistence

```ts
import {
  createNotionEditor,
  createIndexedDbAdapter,
  type NotionDocument,
} from '@notion-next/dom';

const initialDocument: NotionDocument = {
  object: 'document',
  schemaVersion: '2026-05-01',
  rootPageId: 'page-home',
  blocks: {
    'page-home': {
      object: 'block',
      id: 'page-home',
      type: 'page',
      parent: { type: 'workspace' },
      properties: { title: [{ type: 'text', text: { content: 'Home' } }] },
      hasChildren: true,
    },
    'block-1': {
      object: 'block',
      id: 'block-1',
      type: 'paragraph',
      parent: { type: 'block_id', blockId: 'page-home' },
      properties: { richText: [{ type: 'text', text: { content: 'Start writing…' } }] },
      hasChildren: false,
    },
  },
  childOrder: { 'page-home': ['block-1'], 'block-1': [] },
};

const editor = createNotionEditor({
  mode: 'uncontrolled',
  document: initialDocument,
  persistence: createIndexedDbAdapter({ databaseName: 'my-app-editor', key: 'home' }),
  locale: navigator.language,
  theme: { colorScheme: 'system' },
  errorReporter: {
    report(error, context) {
      console.error('[editor]', error.code, error.message, context);
    },
  },
});

editor.on('change', event => {
  console.log('document version', event.snapshot.version);
});

await editor.mount(document.querySelector('#editor')!);
```

### 19.2 Controlled editor using host app state

```ts
const editor = createNotionEditor({
  mode: 'controlled',
  document: appStore.document,
  controlledPolicy: 'optimistic',
});

editor.on('transaction', tx => {
  try {
    const next = applyTransaction(appStore.document, tx);
    appStore.setDocument(next);
    editor.acceptTransaction(tx.id, next);
  } catch (cause) {
    editor.rejectTransaction(tx.id, { code: 'host_rejected', cause });
  }
});

appStore.subscribe(nextDocument => {
  editor.setDocument(nextDocument, { preserveSelection: true });
});
```

### 19.3 Custom persistence adapter

```ts
import type { PersistenceAdapter, PersistedSnapshot } from '@notion-next/core';

export function createHostCallbackAdapter(saveToHost: (s: PersistedSnapshot) => Promise<void>): PersistenceAdapter {
  let last: PersistedSnapshot | null = null;

  return {
    id: 'host-callback',
    capabilities: { durable: true, async: true, supportsTransactions: false },
    async load() {
      return last;
    },
    async save(_key, snapshot) {
      last = snapshot;
      await saveToHost(snapshot);
    },
    async remove() {
      last = null;
    },
  };
}
```

### 19.4 File and embed resolvers

```ts
const editor = createNotionEditor({
  fileResolver: {
    async createUpload(file) {
      const asset = await appFiles.createObjectUrlAsset(file);
      return { assetId: asset.id, status: 'uploaded', asset };
    },
    async getDisplayUrl(asset) {
      return { url: await appFiles.getObjectUrl(asset.id) };
    },
  },
  embedResolver: {
    async classifyUrl(url) {
      if (url.includes('youtube.com')) return [{ kind: 'embed', url, label: 'Embed video' }];
      return [{ kind: 'bookmark', url, label: 'Create bookmark' }];
    },
    async resolve(offer) {
      return { kind: offer.kind, url: offer.url, title: offer.label, sandbox: 'allow-scripts allow-same-origin' };
    },
  },
});
```

### 19.5 Custom block plugin

```ts
const statusBlockPlugin: EditorPlugin = {
  id: 'app.status-block',
  version: '1.0.0',
  blocks: [
    {
      type: 'app_status',
      supportsChildren: false,
      schema: statusSchema,
      render({ props }) {
        return h('span', { class: `status status-${props.color}` }, props.label);
      },
      toMarkdown({ props }) {
        return `**Status:** ${props.label}`;
      },
    },
  ],
  commands: {
    getCommands() {
      return [
        {
          id: 'app.insert_status',
          title: 'Status badge',
          aliases: ['status', 'badge'],
          category: 'host',
          contexts: ['empty_block', 'slash_menu'],
          isEnabled: () => true,
          run: ctx => ctx.transactions.insertBlock({ type: 'app_status', properties: { label: 'On track', color: 'green' } }),
        },
      ];
    },
  },
};
```

---

## 20. Implementation checklist

A release claiming this specification MUST publish:

- package versions and browser support statement;
- conformance classes claimed;
- unsupported Notion-compatible features, if any, with stable error/warning behavior;
- adapter capabilities and failure policies;
- CSP requirements;
- accessibility test evidence;
- cross-browser conformance results;
- TypeScript API docs for lifecycle, transactions, plugins, adapters, import/export, theming, localization, telemetry, and errors.

A Notion-compatible editor that omits required behavior from a claimed conformance class MUST NOT claim that class. It MAY claim a lower class and document extensions separately.
