# Notion-compatible input commands and shortcuts specification

## 1. Scope and authority

This document is a normative, browser-only TypeScript specification for the input, command, shortcut, and autocomplete layer of a Notion-compatible editor for web applications. It covers client behavior only: DOM events, selection mapping, command dispatch, clipboard/drag-and-drop handling, menu UI, and transaction emission. It MUST NOT be read as a backend, sync, permissions service, or file-storage design.

The public behavior basis is Notion's Help Center and public API representation, especially keyboard shortcuts, slash commands, writing/editing basics, links/backlinks, comments/mentions/reminders, embeds/bookmarks/link previews, rich text objects, and block objects. Public docs do not expose Notion's internal editor implementation, so this spec defines compatible observable behavior and a robust TypeScript architecture for implementing it.

Normative keywords **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are used as in RFC 2119.

## 2. Terminology

| Term | Meaning |
| --- | --- |
| Editor host | The top-level browser editor controller that owns command dispatch and document transactions. |
| Block editor | A `contenteditable` or custom editing surface for one block, table cell, database property, code block, equation editor, or nested page title. |
| Rich text | Structured inline content: text, annotations, links, mentions, inline equations, and comment anchors. It MUST NOT be stored as arbitrary HTML. |
| Command | A declarative action that can be invoked by shortcuts, slash commands, menus, toolbar buttons, paste choices, or autocomplete entries. |
| Input rule | A rule that observes committed typed text and turns trigger text into rich text, blocks, or commands. |
| Surface | The UI or event source invoking a command: slash menu, keyboard, block handle, selected-block menu, link menu, paste menu, mention menu, mobile toolbar, etc. |
| Transaction | An atomic editor change containing typed operations, selection mapping, undo metadata, and optional UI effects. |

## 3. Client architecture overview

The editor MUST centralize all input through a deterministic pipeline. UI components MUST emit commands or transactions; they MUST NOT mutate document state or the DOM independently.

```text
Browser events
  keydown / beforeinput / input / composition / paste / copy / cut / drop / selectionchange
        |
        v
Input controller
  - IME guard
  - active menu/focus-trap routing
  - nested-editor ownership
  - shortcut normalization
  - clipboard/drop classification
        |
        v
Command + input-rule resolver
  - predicates and disabled reasons
  - conflict resolution
  - ranking/filtering for menus
        |
        v
Transaction executor
  - schema validation
  - undo grouping
  - selection mapping
  - render scheduling
        |
        v
DOM renderer + selection bridge
```

The implementation MUST support at least these selection modes:

```ts
type EditorSelection =
  | { kind: "text"; anchor: TextPoint; focus: TextPoint }
  | { kind: "block"; blockIds: readonly BlockId[]; anchorId: BlockId; focusId: BlockId }
  | { kind: "cell"; tableId: BlockId; anchor: CellPoint; focus: CellPoint }
  | { kind: "databaseRows"; viewId: string; rowIds: readonly PageId[] }
  | { kind: "gap"; position: BlockPosition };
```

Text selections SHOULD bridge to the browser native `Selection` when possible. Block, row, card, and gap selections MUST be owned by editor state and rendered with explicit focus/selection indicators.

## 4. DOM event handling requirements

### 4.1 Event ownership

1. The editor host MUST listen in capture phase for `keydown`, `beforeinput`, `compositionstart`, `compositionupdate`, `compositionend`, `paste`, `copy`, `cut`, `dragover`, `drop`, and `selectionchange` for editor-owned roots.
2. A nested editor MUST declare ownership of events originating inside it. Examples: code editor, equation editor, database cell editor, page-title editor, inline link input, comment composer, and command search field.
3. Events MUST be routed to the nearest owning editor scope first. Unhandled events MAY bubble to parent editor scopes.
4. The editor MUST call `preventDefault()` only after a command/input rule has been selected and can execute or after the editor must suppress unsafe browser mutation. Browser defaults MUST remain available when the editor does not handle the event.

### 4.2 `beforeinput` and `input`

`beforeinput` MUST be the primary hook for text mutations when supported. The editor MUST inspect `InputEvent.inputType`, `data`, `dataTransfer`, target ranges, and current editor selection.

| `inputType` family | Required behavior |
| --- | --- |
| `insertText` | Allow or intercept committed text insertion. After insertion, run inline menus and input rules unless composing or disabled by context. |
| `insertLineBreak` | In text blocks, insert a soft line break for `Shift+Enter`; in code/equation editors delegate to nested editor. |
| `insertParagraph` | Split the current block, create a new text block, continue list/todo/toggle context where appropriate, or open a selected page block. |
| `deleteContentBackward` / `deleteContentForward` | Merge/split/delete text or blocks according to selection mode; selected blocks MUST be deleted as blocks. |
| `insertFromPaste` / `insertFromDrop` | Route through the paste/drop resolver. Browser HTML insertion MUST be prevented for editor-owned content. |
| `formatBold` / `formatItalic` etc. | MAY be treated as shortcut-equivalent formatting commands if produced by the browser. |
| `historyUndo` / `historyRedo` | MUST route to the editor history. Native browser undo MUST NOT corrupt editor state. |

The subsequent browser input event (`input`) MUST be used as reconciliation: if the browser mutated a contenteditable surface before interception, the editor MUST diff/reconcile the DOM back into document state or roll the DOM back to the authoritative render. Reconciliation MUST NOT run Markdown shortcuts a second time.

### 4.3 Composition and IME

IME composition safety is mandatory.

1. From `compositionstart` until `compositionend`, the editor MUST set `ctx.composing = true` for the owning editor.
2. While composing, the editor MUST NOT execute Markdown shortcuts, slash commands, mention triggers, page-link triggers, emoji triggers, automatic URL transforms, or keyboard shortcuts derived from printable keys.
3. Navigation keys used by the IME candidate window MUST NOT be intercepted unless the event target is a menu explicitly owned by the editor and `event.isComposing` is false.
4. On `compositionend`, the editor MUST treat the committed text as one undoable insertion, then MAY run non-destructive trigger detection on the committed text. If the committed text ends with `/`, `@`, `[[`, `+`, or `:`, menus MAY open after commit.
5. `Esc` during composition SHOULD be left to the IME/browser. `Esc` after composition MUST dismiss editor menus before selecting blocks.
6. Input rules MUST be Unicode-aware and MUST NOT assume English/QWERTY key positions.

### 4.4 Keyboard normalization

The editor MUST normalize keyboard events into bindings independent of platform-specific modifier names.

```ts
type Platform = "mac" | "windows" | "linux";

type KeyChord = {
  key: string;              // normalized logical key, e.g. "b", "Enter", "/"
  code?: string;            // optional physical key when needed
  mod?: boolean;            // cmd on macOS, ctrl on Windows/Linux
  shift?: boolean;
  alt?: boolean;            // option on macOS
  ctrl?: boolean;           // physical Ctrl, distinct from mod on macOS
  meta?: boolean;
};

function eventToChord(event: KeyboardEvent, platform: Platform): KeyChord {
  const mod = platform === "mac" ? event.metaKey : event.ctrlKey;
  return {
    key: event.key.length === 1 ? event.key.toLowerCase() : event.key,
    code: event.code,
    mod,
    shift: event.shiftKey,
    alt: event.altKey,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
  };
}
```

The implementation SHOULD show shortcut labels using platform terms: `⌘`/`⌥` on macOS and `Ctrl`/`Alt` on Windows/Linux.

## 5. Canonical command registry model

Commands MUST be declarative records. Every UI surface MUST query the same registry, filter by context, and execute through the same transaction executor.

```ts
type CommandId = string;
type BlockId = string;
type PageId = string;

type CommandSurface =
  | "keyboard"
  | "slash"
  | "plus-menu"
  | "block-handle"
  | "selected-block-menu"
  | "command-palette"
  | "mention-menu"
  | "paste-menu"
  | "mobile-toolbar"
  | "api-test";

type CommandCategory =
  | "basic"
  | "inline"
  | "media"
  | "database"
  | "embed"
  | "advanced"
  | "transform"
  | "color"
  | "comment"
  | "navigation";

type DisabledReason = {
  code:
    | "read_only"
    | "invalid_selection"
    | "invalid_parent"
    | "unsupported_block"
    | "requires_text_selection"
    | "requires_block_selection"
    | "requires_provider"
    | "offline_unavailable"
    | "browser_reserved"
    | "nested_editor_owns_event"
    | "feature_disabled";
  message: string;
};

type CommandPredicate = (ctx: EditorContext) => true | DisabledReason;

type KeyboardBinding = {
  chord: string;            // e.g. "mod+b", "mod+alt+1", "mod+shift+m"
  when: readonly SelectionKind[];
  platform?: Platform | "all";
  preventDefault?: "always" | "when-enabled" | "never";
  priority?: number;
};

type SlashBinding = {
  trigger: "/";
  aliases: readonly string[];       // no leading slash, e.g. ["h1", "#"]
  placement: "insert-block" | "inline" | "action" | "transform";
  consumesQuery?: boolean;
};

type MarkdownInputRule = {
  id: string;
  trigger: "space" | "enter" | "character";
  scope: "line-start" | "inline" | "block-end";
  pattern: RegExp;
  contexts?: readonly BlockType[];
  excludeContexts?: readonly BlockType[];
  commandId: CommandId;
  getArgs(match: RegExpMatchArray, ctx: EditorContext): unknown;
};

type CommandDefinition<Args = unknown> = {
  id: CommandId;
  title: string;
  description?: string;
  category: CommandCategory;
  icon?: string;
  surfaces: readonly CommandSurface[];
  search: {
    aliases: readonly string[];
    keywords?: readonly string[];
    boost?: number;
  };
  predicates: readonly CommandPredicate[];
  keyboard?: readonly KeyboardBinding[];
  slash?: readonly SlashBinding[];
  markdown?: readonly MarkdownInputRule[];
  preview?: (ctx: EditorContext, args: Args) => CommandPreview | null;
  execute(ctx: EditorContext, args: Args): Transaction | Promise<Transaction>;
};
```

A command registry MUST support:

- Registration by core editor and block plugins.
- Lookup by ID.
- Slash alias lookup with exact and fuzzy search.
- Keyboard lookup by normalized chord and context.
- Predicate evaluation that returns a disabled reason instead of hiding all unavailable commands.
- Stable ordering, frequency/recency boosts, and deterministic test fixtures.
- Async provider-backed entries, such as page search, people search, emoji search, link-preview provider detection, and file chooser results.

### 5.1 Example predicates

```ts
const canEdit: CommandPredicate = (ctx) =>
  ctx.permissions.canEditContent ? true : { code: "read_only", message: "You do not have edit access." };

const hasTextSelection: CommandPredicate = (ctx) =>
  ctx.selection.kind === "text"
    ? true
    : { code: "requires_text_selection", message: "Select text first." };

const canHaveChildren = (blockId: BlockId): CommandPredicate => (ctx) =>
  ctx.schema.blockSupportsChildren(ctx.doc.getBlock(blockId).type)
    ? true
    : { code: "invalid_parent", message: "This block type cannot contain nested blocks." };
```

### 5.2 Example commands

```ts
const turnHeading1: CommandDefinition<{ blockIds?: BlockId[] }> = {
  id: "block.turn.heading_1",
  title: "Heading 1",
  description: "Turn the current block into a large heading.",
  category: "basic",
  icon: "H1",
  surfaces: ["keyboard", "slash", "plus-menu", "selected-block-menu", "block-handle"],
  search: { aliases: ["h1", "#", "heading", "large heading"], keywords: ["title", "header"] },
  predicates: [canEdit],
  keyboard: [
    { chord: "mod+alt+1", platform: "mac", when: ["text", "block"], preventDefault: "when-enabled" },
    { chord: "mod+shift+1", platform: "windows", when: ["text", "block"], preventDefault: "when-enabled" },
    { chord: "mod+shift+1", platform: "linux", when: ["text", "block"], preventDefault: "when-enabled" },
  ],
  slash: [{ trigger: "/", aliases: ["h1", "#", "heading1"], placement: "transform" }],
  markdown: [
    {
      id: "markdown.heading_1",
      trigger: "space",
      scope: "line-start",
      pattern: /^#$/u,
      excludeContexts: ["code", "equation"],
      commandId: "block.turn.heading_1",
      getArgs: (_m, ctx) => ({ blockIds: ctx.currentBlockIds() }),
    },
  ],
  execute(ctx, args) {
    const blockIds = args.blockIds ?? ctx.currentBlockIds();
    return ctx.tx()
      .deleteTriggerText({ pattern: /^#\s?$/u })
      .setBlockType(blockIds, "heading_1", { preserveRichText: true, preserveChildren: true })
      .setSelectionAfterBlocks(blockIds)
      .commit("Turn into Heading 1");
  },
};

const applyRed: CommandDefinition<{ target: "text" | "block"; background?: boolean }> = {
  id: "color.red",
  title: "Red",
  category: "color",
  icon: "A",
  surfaces: ["slash", "keyboard", "selected-block-menu", "block-handle", "mobile-toolbar"],
  search: { aliases: ["red", "red text", "red background"], keywords: ["color", "highlight"] },
  predicates: [canEdit],
  slash: [{ trigger: "/", aliases: ["red", "red background"], placement: "action" }],
  execute(ctx, args) {
    const color = args.background ? "red_background" : "red";
    return args.target === "text" && ctx.selection.kind === "text"
      ? ctx.tx().annotateText(ctx.selection, { color }).rememberLastColor(color).commit("Color text")
      : ctx.tx().setBlockColor(ctx.currentBlockIds(), color).rememberLastColor(color).commit("Color block");
  },
};

const addComment: CommandDefinition = {
  id: "comment.add",
  title: "Comment",
  category: "comment",
  icon: "💬",
  surfaces: ["keyboard", "slash", "block-handle", "selected-block-menu", "mobile-toolbar"],
  search: { aliases: ["comment", "discuss", "note"], keywords: ["feedback", "thread"] },
  predicates: [canEdit],
  keyboard: [{ chord: "mod+shift+m", when: ["text", "block"], preventDefault: "when-enabled" }],
  slash: [{ trigger: "/", aliases: ["comment"], placement: "action" }],
  execute(ctx) {
    const anchor = ctx.commentAnchorFromSelection();
    return ctx.tx().openCommentComposer(anchor).commit("Open comment composer");
  },
};
```

### 5.3 Command execution contract

```ts
async function executeCommand<Args>(registry: CommandRegistry, id: CommandId, ctx: EditorContext, args: Args) {
  const command = registry.get<Args>(id);
  const disabled = registry.disabledReason(command, ctx);
  if (disabled) return ctx.ui.showDisabled(command, disabled);

  const tx = await command.execute(ctx, args);
  const validation = ctx.schema.validate(tx);
  if (!validation.ok) return ctx.ui.showError(command, validation.message);

  ctx.history.apply(tx, { group: tx.label, source: id });
  ctx.render.schedule();
  ctx.selection.apply(tx.selectionAfter);
}
```

Command handlers MUST return transactions or UI effects that are explicitly modeled in transactions. They MUST NOT directly write to `innerHTML`, change DOM selection without going through the selection bridge, or call backend APIs.

## 6. Input rules and text behavior

### 6.1 Text input and plain text insertion

Text blocks MUST behave like a word processor while preserving Notion's block model:

- Typing inserts Unicode text at the current rich-text selection.
- `Enter` in a text block MUST split the block at the caret and create a following text block unless the current context has a specialized behavior.
- `Shift+Enter` MUST insert a soft line break inside the current block where supported.
- Empty list/todo/toggle items followed by `Enter` SHOULD exit that list context into a paragraph.
- `Backspace` at the start of a block SHOULD merge with the previous compatible block or outdent/delete according to list nesting. It MUST NOT lose children or comments silently.
- Browser spellcheck MAY be used in web contexts; implementation MUST not depend on desktop-only spellcheck.

### 6.2 Markdown shortcuts

Markdown shortcuts MUST run only on committed input, not during IME composition. Line-start rules MUST require the caret to be in a rich-text block at the start of the logical text content or after only leading whitespace. They MUST be undoable as a single history step with the trigger insertion.

| Trigger | Timing | Required result | Notes |
| --- | --- | --- | --- |
| `**text**` | after closing `**` | Apply bold annotation to `text`; remove delimiters. | MUST NOT run inside code/equation. |
| `*text*` | after closing `*` | Apply italic annotation. | MUST avoid conflicting with line-start bullet `* `. |
| `` `text` `` | after closing backtick | Apply inline code annotation. | MUST treat content literally. |
| `~text~` | after closing `~` | Apply strikethrough annotation. | SHOULD require non-empty text. |
| `* `, `- `, `+ ` | line start + space | Turn block into bulleted list item and remove marker. | `+` conflicts with page creation only when not followed by space. |
| `[] ` | line start + space | Turn block into unchecked to-do item. | Trigger has no space between brackets. |
| `1. ` | line start + space | Turn block into numbered list item. | Start number MAY be stored for display. |
| `a. ` | line start + space | Turn block into numbered/lettered list item. | SHOULD preserve marker style if the renderer supports it. |
| `i. ` | line start + space | Turn block into numbered/roman list item. | SHOULD preserve marker style if the renderer supports it. |
| `# ` | line start + space | Turn block into Heading 1. | Remove marker. |
| `## ` | line start + space | Turn block into Heading 2. | Remove marker. |
| `### ` | line start + space | Turn block into Heading 3. | Remove marker. |
| `> ` | line start + space | Turn block into toggle list item. | Notion uses this for toggle list, not block quote. |
| `" ` | line start + space | Turn block into quote block. | Remove marker. |
| `---` | line start after third dash | Create a divider block. | Empty trigger block SHOULD become divider; following text block SHOULD be created if user continues. |

Input rules MAY support additional Markdown import syntax on paste, but live typing compatibility MUST prioritize the table above.

### 6.3 Slash commands

Typing `/` in an editable block MUST open the slash menu unless:

- the editor is composing;
- the slash is typed inside a code/equation context that owns literal text;
- a nested editor claims the event;
- the user escaped the menu and continues literal typing;
- permissions or read-only mode prohibit editing.

The slash token from `/` through the current query MUST be a replaceable range. Selecting a slash command MUST remove that token and execute the command. Pressing `Esc` MUST dismiss the menu and leave the literal slash/query text intact. Backspacing over the slash MUST close the menu.

Slash commands MUST support insertion commands, inline commands, actions on current/selected blocks, transformations, and colors. `/turn...`, `/color...`, `/default`, and color names MUST work at the beginning or end of text blocks, matching Notion behavior.

### 6.4 Inline autocomplete triggers

The editor MUST implement the following inline triggers as autocomplete sessions:

| Trigger | Required candidates | Priority behavior |
| --- | --- | --- |
| `@` | people, groups, pages, dates, reminders | Search live; date words such as today/tomorrow/yesterday/next Wednesday MUST be parsed. |
| `@remind` | reminder date/time parser | Result MUST create a date mention with reminder metadata. |
| `[[` | existing pages, add new sub-page, add new page in... | Page linking MUST be listed before page creation. |
| `+` | add new sub-page, add new page in..., existing pages | Page creation MUST be listed before linking unless followed by space for Markdown bullet. |
| `:` | emoji and custom emoji | Search by name/alias; system emoji picker shortcuts remain browser/OS-owned. |
| `/equation` or `/math` | inline or block equation editor | TeX input MUST render through a safe math renderer. |

Autocomplete trigger text MUST be replaceable atomically, undoable, and resilient to selection changes. `Esc` MUST dismiss the menu and preserve literal text.

## 7. Command UI behavior

All command menus MUST use the registry and a common item model.

```ts
type CommandMenuItem = {
  key: string;
  commandId: CommandId;
  title: string;
  subtitle?: string;
  icon?: string;
  group: CommandCategory | string;
  aliases: readonly string[];
  disabled?: DisabledReason;
  score: number;
  preview?: CommandPreview;
  asyncState?: "idle" | "loading" | "loaded" | "error";
};
```

### 7.1 Filtering and ranking

1. Filtering MUST match title, slash aliases, search aliases, keywords, and provider result titles.
2. Ranking SHOULD combine exact alias match, prefix match, word-boundary match, fuzzy match, category priority, context relevance, recency, frequency, and current selection compatibility.
3. Exact slash aliases MUST outrank fuzzy matches. Example: `/h1` MUST rank Heading 1 first; `/book` MUST rank Web bookmark first.
4. Recently used and most-used blocks SHOULD appear near the top of the unfiltered slash menu, as Notion documents.
5. Disabled commands MAY remain visible with disabled reasons when discoverability matters; destructive or irrelevant commands MAY be hidden outside their surfaces.
6. Query normalization SHOULD fold case, accents, punctuation, and whitespace but MUST preserve provider IDs.

### 7.2 Grouping

Slash and plus menus SHOULD group entries as Notion does: Basic, Database, Media, Embeds, Advanced, Inline. Selection action menus SHOULD group by Transform, Color, Edit actions, Move/duplicate/delete, Comments, and integration-specific actions. Command palette/search MAY group by Pages, Commands, Recent pages, and Provider results.

### 7.3 Keyboard navigation

Menus MUST implement accessible combobox/listbox behavior:

- `ArrowDown` / `ArrowUp`: move active item.
- `Home` / `End`: first/last item.
- `Enter`: execute active enabled item.
- `Tab`: MAY accept active item in inline autocompletes; in modal dialogs it MUST follow focus-trap rules.
- `Esc`: dismiss and restore focus/selection.
- `PageUp` / `PageDown`: move by viewport page in long menus.
- Pointer hover MAY update active item but MUST NOT steal text focus.

Menus MUST keep focus in the text editor or search input while using `aria-activedescendant`, or intentionally move focus into a dialog with a focus trap. Screen readers MUST receive loading, error, disabled, and result-count announcements.

### 7.4 Preview, async providers, and errors

- Commands MAY expose a preview transaction. Hovering or arrowing through items SHOULD show a non-committed preview for transformations/colors where safe.
- Async providers MUST be cancellable by query/session ID. Stale responses MUST be ignored.
- Provider errors MUST render inline error rows with retry affordances and MUST NOT close the menu or lose typed query.
- Empty states MUST explain what can be created, linked, or searched.
- Destructive commands such as delete/move of large selections MAY require confirmation; confirmation MUST be keyboard accessible.

### 7.5 Command palette and search

The browser editor MUST distinguish three search surfaces even if they share UI components:

1. **In-page search** (`cmd/ctrl+F`) searches visible page content and highlights matches without changing document structure.
2. **Workspace/page search** (`cmd/ctrl+P` or `cmd/ctrl+K` outside text editing) searches recent pages, permitted pages, and provider/index results supplied to the client. It SHOULD support recent pages, exact phrase queries, filters, and relevance/date sorting when those capabilities are available from the injected search provider.
3. **Command search** (`cmd/ctrl+/`, slash menu search, block action search) searches the command registry and current selection actions.

A web implementation MAY receive search results from an in-memory index, local database, worker, or injected service adapter, but this spec does not define backend indexing. Search UI MUST preserve keyboard navigation, disabled reasons, loading/error states, and focus restoration exactly like slash/mention menus. Page results and command results MUST be visually distinct so executing a command is never confused with navigating to content.

## 8. Common keyboard shortcuts

`cmd/ctrl` means Command on macOS and Control on Windows/Linux. `option/alt` means Option on macOS and Alt on Windows/Linux. Web apps cannot reliably intercept every browser/OS-reserved shortcut; when a shortcut is unavailable, the editor MUST provide a menu/toolbar alternative.

### 8.1 Navigation, search, app shell

| Action | macOS | Windows/Linux | Required behavior |
| --- | --- | --- | --- |
| Search inside page | `⌘F` | `Ctrl+F` | Open in-page search when editor shell owns the page; otherwise allow browser find if unsupported. |
| Workspace search / recent pages | `⌘P` or `⌘K` when not editing text | `Ctrl+P` or `Ctrl+K` when not editing text | Open search/command surface; while editing text, `mod+K` MUST prefer link editing. |
| Copy page URL | `⌘L` in Notion app context | `Ctrl+L` in Notion app context | Browser URL bar may own this in web apps; provide Copy page link command. |
| Back / forward page | `⌘[` / `⌘]` | `Ctrl+[` / `Ctrl+]` | Navigate editor history/page stack where not browser-reserved. |
| Toggle dark/light mode | `⌘⇧L` | `Ctrl+Shift+L` | MAY be app-shell command. |
| New page | `⌘N` | `Ctrl+N` | In browser, often reserved; provide fallback. |
| New window/tab in app | `⌘⇧N`, `⌘T` | `Ctrl+Shift+N`, `Ctrl+T` | Browser may own these; web app SHOULD not rely on interception. |
| Database peek previous | `Ctrl+Shift+K` | `Ctrl+K` | Only in database peek modal. |
| Database peek next | `Ctrl+Shift+J` | `Ctrl+J` | Only in database peek modal. |
| System emoji picker | `Ctrl+⌘Space` | `Win+.` or `Win+;` | OS-owned; editor MAY also provide `/emoji` and `:` picker. |

### 8.2 Text editing and formatting

| Action | Shortcut | Required behavior |
| --- | --- | --- |
| New block/paragraph | `Enter` | Split current block or edit selected block/page. |
| Soft line break | `Shift+Enter` | Insert line break inside current block where supported. |
| Add comment | `cmd/ctrl+Shift+M` | Comment current text selection, caret, or selected block. |
| Bold | `cmd/ctrl+B` | Toggle bold on text selection or active mark. |
| Italic | `cmd/ctrl+I` | Toggle italic. |
| Underline | `cmd/ctrl+U` | Toggle underline; prevent browser default if editor supports it. |
| Strikethrough | `cmd/ctrl+Shift+S` | Toggle strikethrough. |
| Link | `cmd/ctrl+K` while text selection/caret is in editor | Open link editor; paste URL over selected text MUST create link. |
| Inline code | `cmd/ctrl+E` | Toggle code annotation. |
| Indent/nest | `Tab` | Nest selected/current block under previous compatible block. In menus/dialogs, follow focus navigation instead. |
| Outdent/un-nest | `Shift+Tab` | Move selected/current block up one nesting level. |
| Apply last color | `cmd/ctrl+Shift+H` | Reapply last used text/highlight/block color. |

### 8.3 Block creation and transformation

| Action | macOS | Windows/Linux | Required behavior |
| --- | --- | --- | --- |
| Text block | `⌘⌥0` | `Ctrl+Shift+0` | Turn current block/selection into text. |
| Heading 1 | `⌘⌥1` | `Ctrl+Shift+1` | Turn into Heading 1. |
| Heading 2 | `⌘⌥2` | `Ctrl+Shift+2` | Turn into Heading 2. |
| Heading 3 | `⌘⌥3` | `Ctrl+Shift+3` | Turn into Heading 3. |
| To-do | `⌘⌥4` | `Ctrl+Shift+4` | Turn into to-do checkbox. |
| Bulleted list | `⌘⌥5` | `Ctrl+Shift+5` | Turn into bulleted list item. |
| Numbered list | `⌘⌥6` | `Ctrl+Shift+6` | Turn into numbered list item. |
| Toggle list | `⌘⌥7` | `Ctrl+Shift+7` | Turn into toggle list item. |
| Code block | `⌘⌥8` | `Ctrl+Shift+8` | Turn into code block. |
| Page | `⌘⌥9` | `Ctrl+Shift+9` | Create page or turn current line into page. |
| Selected-block action menu | `⌘/` | `Ctrl+/` | Open action menu for selected/current blocks. |
| Modify current block | `⌘Enter` | `Ctrl+Enter` | Open page, check/uncheck to-do, open/close toggle, fullscreen image/embed as context requires. |
| Expand/collapse toggles | `⌘⌥T` | `Ctrl+Alt+T` | Toggle all toggles in selected/current toggle list. |

### 8.4 Block selection and movement

| Action | macOS | Windows/Linux | Required behavior |
| --- | --- | --- | --- |
| Select current block / clear selection | `Esc` | `Esc` | Dismiss menus first; then select current block; if blocks selected, clear or return to caret depending context. |
| Select current block from caret | `⌘A` once | `Ctrl+A` once | First press selects current block; second press MAY select page/all text. |
| Move block selection | Arrow keys | Arrow keys | Move block focus between visible blocks. |
| Extend block selection | `Shift+↑/↓` | `Shift+↑/↓` | Expand selected block range. |
| Range select with pointer | `Shift+click` | `Shift+click` | Select all blocks in range. |
| Toggle whole-block select with pointer | `⌘Shift+click` | `Alt+Shift+click` | Select/deselect whole block. |
| Delete selected blocks | `Backspace` or `Delete` | `Backspace` or `Delete` | Delete blocks as a transaction. |
| Duplicate selected blocks | `⌘D` | `Ctrl+D` | Duplicate selected blocks with new IDs. |
| Edit selected block | `Enter` | `Enter` | Place caret inside text or open page. |
| Move selected block | `⌘Shift+Arrow` | `Ctrl+Shift+Arrow` | Move block up/down or across nesting where valid. |
| Duplicate while dragging | hold `Option` | hold `Alt` | Drop creates a duplicate instead of move. |

### 8.5 Database/table-specific shortcuts

| Action | Shortcut | Required behavior |
| --- | --- | --- |
| Fill selected cells right | `cmd/ctrl+R` | In simple table/database grid with multiple cells selected, fill right. |
| Fill selected cells down | `cmd/ctrl+D` | In grid selection, fill down; outside grid, duplicate blocks. |
| Batch edit rows/cards | `cmd/ctrl+/` | Open row/card action menu. |

## 9. Common slash commands

Slash command aliases MUST be matched without the leading `/`. The slash menu SHOULD include all Notion block categories, not just an MVP subset.

### 9.1 Basic and database commands

| Command aliases | Category | Required behavior |
| --- | --- | --- |
| `/text`, `/plain` | Basic | Create/turn into plain text paragraph. |
| `/page` | Basic | Create a child page; pressing Enter after creation SHOULD open it. |
| `/bullet` | Basic | Create/turn into bulleted list item. |
| `/num`, `/number` | Basic | Create/turn into numbered list item. |
| `/todo`, `/checkbox` | Basic | Create/turn into to-do checkbox. |
| `/toggle` | Basic | Create/turn into toggle list item. |
| `/div`, `/divider` | Basic | Create divider block. |
| `/quote` | Basic | Create/turn into quote block. |
| `/h1`, `/#` | Basic | Create/turn into Heading 1. |
| `/h2`, `/##` | Basic | Create/turn into Heading 2. |
| `/h3`, `/###` | Basic | Create/turn into Heading 3. |
| `/table` | Basic | Create a simple table block. |
| `/link` | Basic | Insert Link to page block and open page picker. |
| `/callout` | Basic | Create callout block with icon. |
| `/table view` | Database | Create inline database table view. |
| `/board view` | Database | Create inline database board view. |
| `/gallery view` | Database | Create inline database gallery view. |
| `/list view` | Database | Create inline database list view. |
| `/calendar view` | Database | Create inline database calendar view. |
| `/timeline view` | Database | Create inline database timeline view where supported. |
| `/database`, `/inline database` | Database | Create or link an inline database. |
| `/linked database`, `/linked view` | Database | Insert a linked view of an existing database/data source. |
| `/chart`, `/dashboard` | Database | Create chart/dashboard-style database view where the product surface supports it. |

### 9.2 Inline commands

| Command aliases | Required behavior |
| --- | --- |
| `/mention` | Open mention picker for pages/people/groups. |
| `/date`, `/reminder` | Open date/reminder picker and insert date mention. |
| `/equation` | Insert inline TeX equation rich-text node. |
| `/emoji` | Open emoji/custom emoji picker. |

### 9.3 Media and embed commands

| Command aliases | Required behavior |
| --- | --- |
| `/image` | Offer upload, paste URL, embed, and supported image sources. |
| `/pdf` | Upload or embed PDF URL inline. |
| `/book`, `/bookmark`, `/web` | Create web bookmark block from URL. |
| `/video` | Upload or embed video. |
| `/audio` | Upload or embed audio. |
| `/code` | Create code block with language selector. |
| `/file` | Upload or embed file. |
| `/embed` | Create generic embed from URL. |
| `/tweet`, `/x` | Create tweet/X embed where supported. |
| `/drive`, `/google drive` | Open Google Drive embed/search provider if configured. |
| `/maps`, `/google maps` | Embed map URL. |
| `/figma`, `/loom`, `/typeform`, `/codepen`, `/whimsical`, `/gist` | Create provider-specific embed prompt. |

### 9.4 Advanced/action commands

| Command aliases | Required behavior |
| --- | --- |
| `/duplicate` | Duplicate current/selected block(s). |
| `/moveto`, `/move to` | Open move-to-page picker. |
| `/delete` | Delete current/selected block(s). |
| `/toc`, `/table of contents` | Insert generated table-of-contents block. |
| `/button`, `/template` | Insert button/template block. Client spec MUST model configuration UI but not backend execution. |
| `/bread`, `/breadcrumb` | Insert generated breadcrumb block. |
| `/math`, `/latex` | Insert equation block or open math editor; inline `/equation` remains available. |
| `/synced`, `/synced block` | Create a synced block wrapper or convert the selected blocks into synced content where supported. |
| `/ai`, `/ask ai` | Open an AI action UI as a command surface if the product includes Notion AI-style features; generation itself is outside this browser-only spec. |
| `/turn...` | Open/execute block type transform. |
| `/comment` | Add comment to current selection/block. |
| `/default` | Clear block/text color or background. |

### 9.5 Color commands

The editor MUST support block colors and inline text/highlight colors using Notion-compatible names: `default`, `gray`, `brown`, `orange`, `yellow`, `green`, `blue`, `purple`, `pink`, and `red`, each with optional `background`. Examples: `/red`, `/blue background`, `/gray`, `/default`.

Color commands MUST apply to selected text when text is selected and to current/selected blocks otherwise. The UI MUST not rely on color alone; names and contrast-compliant swatches MUST be present.

## 10. Inline entities

### 10.1 Mentions

Mentions MUST be structured rich-text nodes, not plain text URLs. Supported mention types MUST include users/people, groups if the app supports them, pages, databases if exposed, dates, reminders, link-preview mentions, and template placeholders where template blocks are implemented.

`@` mention search MUST:

- search people/groups/pages in real time;
- allow keyboard and pointer selection;
- insert a durable entity reference plus display text;
- update page mention display when page title changes;
- preserve access-limited/private page states as restricted placeholders where applicable;
- notify users only through whatever application notification layer exists outside this browser-only spec.

### 10.2 Dates and reminders

The date parser MUST accept typed dates and natural-language terms documented by Notion, including today, tomorrow, yesterday, and relative weekdays. It SHOULD accept locale-aware numeric formats while storing an unambiguous ISO date/time/range in the document model.

A reminder MUST be represented as a date mention with reminder metadata. The browser editor MAY show reminder scheduling UI; actual notification delivery is outside this client-only spec.

### 10.3 Equations

Inline equations MUST be represented as rich-text `equation` nodes containing a TeX/KaTeX-compatible expression. Block equations MAY be represented as an equation block. Equation editing MUST sanitize rendering output and MUST NOT execute user-provided HTML/script. Invalid TeX SHOULD show an inline error without deleting the user's expression.

### 10.4 Links and link previews

The editor MUST support:

- `cmd/ctrl+K` link editing for selected text or current caret.
- Pasting a URL over selected text to create a text link.
- Page mentions via `@`, `[[`, and `+`.
- Link to page blocks via `/link`.
- Copy link to block from block menus.
- URL paste choices: paste as plain link, mention, bookmark, embed, or provider preview when available.

Provider preview detection is client-side in this spec. It MAY call injected provider interfaces but MUST NOT define backend token exchange. Auth, refresh, and server-side preview synchronization are outside scope; the browser UI MUST still render loading, unauthenticated, access denied, content not found, and generic error states.

### 10.5 Comments

Comments MUST be creatable from text selections, carets, or single block anchors. The editor MUST NOT claim block-comments on multiple blocks at once; Notion documents that multiple-block block comments are not supported, though text selected across multiple blocks can be commented.

Comment anchors MUST store stable block IDs and text offsets/ranges. Anchors MUST map through transactions where possible. If an anchor cannot be mapped, the UI SHOULD show it as stale/resolved with recovery affordances rather than silently dropping it.

## 11. Paste, copy, cut, and drop

### 11.1 Clipboard model

The editor MUST write and read multiple clipboard formats when browser permissions allow:

```ts
type ClipboardFragment = {
  version: 1;
  source: "notion-next";
  blocks?: SerializedBlock[];
  richText?: RichTextSegment[];
  selectionKind: EditorSelection["kind"];
};
```

On copy, the editor SHOULD write:

1. `application/x-notion-next-fragment+json` for internal fidelity.
2. `text/html` for rich cross-app paste.
3. `text/markdown` where supported by the Clipboard API or internal paste path.
4. `text/plain` always.

On paste, priority MUST be:

1. trusted internal fragment;
2. files/images from clipboard;
3. HTML;
4. Markdown if explicitly detected or source metadata indicates Markdown;
5. URI list / URL text;
6. plain text.

Untrusted HTML MUST be sanitized. Scripts, event handlers, external styles that affect the page, hidden tracking elements, and unsafe URLs MUST be stripped.

### 11.2 Paste into selections

| Selection | Required paste behavior |
| --- | --- |
| Text selection | Insert rich inline content when the fragment is inline-compatible; multi-block fragments SHOULD replace the selected text with blocks split around the selection. |
| Caret in empty text block | Multi-block paste SHOULD replace the empty block with imported blocks. |
| Caret in non-empty text block | Plain text SHOULD insert inline; multi-block paste SHOULD split before/after and insert blocks between. |
| Block selection | Pasted blocks MUST replace selected blocks or insert after selection according to paste command variant. |
| Cell selection | Tabular clipboard data SHOULD fill cells; unsupported multi-cell paste into simple tables MUST show an explanatory error if not implemented, matching Notion's limitation. |
| Read-only selection | Paste MUST be disabled with reason. |

### 11.3 HTML paste import

HTML paste MUST map semantic elements to editor structures:

| HTML | Target |
| --- | --- |
| `p`, `div` text | Paragraph blocks or inline spans. |
| `h1`/`h2`/`h3` | Heading blocks. |
| `strong`/`b`, `em`/`i`, `u`, `s`/`del`, `code` | Rich-text annotations. |
| `a[href]` | Text links or page/link mentions if recognized. |
| `ul`/`ol`/`li` | Bulleted/numbered list blocks with nesting. |
| checkbox task list items | To-do blocks when detectable. |
| `blockquote` | Quote blocks. |
| `pre code` | Code blocks with language if detectable. |
| `hr` | Divider block. |
| `table` | Simple table block when supported; otherwise Markdown/plain text fallback. |
| `img`, dropped image files | Image blocks or inline image upload placeholder. |
| URLs from supported providers | Offer paste-as choices. |

### 11.4 Markdown paste import

Markdown paste MUST support headings, paragraphs, emphasis, links, inline code, fenced code, block quotes, horizontal rules, ordered/unordered lists, task lists, tables, images, and TeX delimiters if equation support is enabled. The importer SHOULD preserve nesting and SHOULD avoid interpreting normal prose as Markdown unless the clipboard source indicates Markdown or the content strongly matches Markdown structure.

### 11.5 Plain text paste

Plain text paste MUST preserve line breaks. Multiple paragraphs separated by blank lines SHOULD become multiple paragraph blocks when pasting into block context. Single-line URLs MUST run the URL paste resolver. Tab-separated or CSV-like text MAY fill table/database cells when a cell selection is active.

### 11.6 Copy and cut

Copy MUST preserve selected rich text, blocks, nested children, links, mentions, equations, and comments anchors where appropriate. When copying blocks, pasted copies MUST receive new block IDs. Cut MUST perform copy first and then delete as one transaction only after clipboard write succeeds or after the browser fallback copy event completes. Internal move operations SHOULD prefer move transactions over copy+delete when staying inside the same document.

### 11.7 Drop handling

Drop handling MUST use the same resolver as paste and MUST compute a semantic drop target: before block, after block, inside child-supporting block, into table cell, into database view, into column position, or inline text position.

| Dropped data | Required behavior |
| --- | --- |
| Text | Insert text or imported blocks at drop target. |
| HTML | Sanitize/import as paste. |
| URL / URI list | Offer paste-as link, mention, bookmark, embed, preview when relevant. |
| Image file | Create image block or local upload placeholder. |
| PDF/audio/video/file | Create corresponding media/file block or upload placeholder. |
| Multiple files | Insert multiple file/media blocks in order. |
| Internal block drag | Move blocks; holding `option/alt` duplicates. |

The browser-only implementation MAY create object URLs for local previews. It MUST expose unresolved upload state rather than assuming a backend exists.

## 12. Block transformations and actions

Block transformations MUST preserve as much user data as the target schema permits.

- Paragraph/list/todo/toggle/quote/heading transformations MUST preserve rich text and comments.
- Children MUST be preserved when target supports children. If the target does not support children, the command MUST either be disabled with a reason or lift children to valid sibling positions with a preview/explanation.
- Turning a line into a page MUST create a child page using the line text as title and move/lift children according to schema.
- Duplicating blocks MUST duplicate entire subtrees with new IDs, except synced-block semantics MAY intentionally create a synced copy if the user chose that command.
- Moving blocks MUST preserve subtree identity, block links, comments, and selection where possible.
- Deleting blocks MUST be undoable and SHOULD trash rather than permanently erase where the data model supports trash.
- `cmd/ctrl+Enter` MUST be context-sensitive: open page blocks, toggle to-do checked state, open/close toggles, or fullscreen image/embed blocks.

## 13. Conflict resolution

The dispatcher MUST resolve conflicts in this priority order:

1. **System and browser reserved behavior.** The editor MUST NOT rely on shortcuts the browser/OS refuses to deliver. Provide command UI alternatives.
2. **IME composition.** Composition owns printable text, candidate navigation, and `Esc` until committed/cancelled.
3. **Modal focus traps.** Open dialogs, file pickers, auth prompts, link editors, and comment composers own their documented shortcuts. `Esc` closes the topmost modal first.
4. **Active autocomplete/menu.** Menus own arrows, Enter, Tab where configured, PageUp/PageDown, and Escape.
5. **Nested editor.** Code blocks, equations, database cells, and page-title editors own editing shortcuts unless they explicitly bubble them.
6. **Grid/table selection.** Cell fill/movement shortcuts outrank block duplicate/move shortcuts while a grid selection is active.
7. **Block selection.** Whole-block shortcuts apply when block selection is active.
8. **Text editing.** Text formatting, Markdown rules, slash/mention triggers, and native selection apply in text mode.
9. **App shell.** Search/navigation shortcuts apply when focus is not inside an editing surface or when the editing surface declines them.

Conflict examples:

| Conflict | Resolution |
| --- | --- |
| `cmd/ctrl+K` in text vs workspace search | Text/link editor wins when caret or text selection is inside rich text; workspace search wins outside editing. |
| `Tab` indentation vs focus traversal | Editor-owned rich text uses Tab to indent; menus/dialogs use Tab for focus; settings MUST offer accessible alternatives. |
| `+` page creation vs bullet Markdown | `+ ` at line start + space creates bullet; `+query` opens page creation/linking menu. |
| `/` literal vs slash menu | `/` opens menu; `Esc` dismisses and preserves literal text; future typing continues text. |
| `Ctrl+D` duplicate vs fill down | Cell selection uses fill down; block/text context uses duplicate or browser bookmark default only if unhandled. |
| Browser native undo vs editor undo | `beforeinput(historyUndo)` and `cmd/ctrl+Z` MUST route to editor history in editor roots. |
| Nested code block `Tab` vs block indent | Code editor inserts indentation when focused; block indent requires block selection or bubbling command. |

## 14. Accessibility requirements

1. Every command reachable by pointer MUST be reachable by keyboard.
2. Slash, mention, emoji, page-link, paste-choice, and command menus MUST implement ARIA combobox/listbox or dialog patterns with labels, active descendant, result counts, disabled states, loading states, and errors.
3. Focus restoration MUST return to the originating editor selection after menu dismissal or command execution.
4. Whole-block selection MUST be visible and announced with block type, title/text preview, and nesting level.
5. Drag-and-drop actions MUST have keyboard equivalents: move up/down, indent/outdent, move to page, duplicate, create columns where supported, and reorder rows/cards.
6. Color choices MUST include text labels and meet contrast guidelines. Color MUST NOT be the only information channel.
7. Touch/mobile toolbars MUST not rely on hover and SHOULD expose `+`, block actions, mentions, comments, image/file insertion, delete, indent/outdent, colors, duplicate, and block links.
8. Error messages and disabled reasons MUST be programmatically associated with the menu item or control that produced them.
9. The editor SHOULD support reduced motion for previews, menus, drag guides, and selection animations.

## 15. Browser/contenteditable requirements

- The document model MUST be authoritative; contenteditable DOM is a projection.
- Rich-text spans MUST use stable data attributes for block and inline node mapping, but user data MUST NOT depend on DOM IDs.
- Selection mapping MUST survive rerenders by mapping block IDs and text offsets, not DOM node references alone.
- The editor MUST normalize DOM mutations caused by spellcheck, autocorrect, browser paste, and mobile keyboards.
- The editor SHOULD use `beforeinput.getTargetRanges()` where available and fall back to browser selection APIs where not.
- Firefox differences in cross-block partial text selection MUST be handled gracefully; feature detection SHOULD decide whether to enable native cross-block ranges or an editor-owned selection overlay.
- Mobile browsers MAY deliver different `beforeinput`/composition sequences; tests MUST cover iOS Safari, Android Chrome, desktop Chromium, Safari, and Firefox.

## 16. Acceptance examples

### 16.1 Slash command execution

```text
Given caret in an empty paragraph
When user types "/h1" and presses Enter in the slash menu
Then the paragraph becomes a Heading 1
And the slash query is removed
And undo restores the literal "/h1" paragraph or previous paragraph state in one step
```

### 16.2 IME-safe Markdown

```text
Given a Japanese IME composition is active
When the composing text temporarily contains "# "
Then the editor MUST NOT create a heading
When composition commits the final text "# " at line start
Then the editor MAY run the heading rule only after compositionend
```

### 16.3 Paste URL over selected text

```text
Given selected text "project brief"
When clipboard contains "https://example.com/brief" and user pastes
Then selected text remains visible
And its link URL becomes "https://example.com/brief"
And the paste-as block menu is not shown unless the user explicitly requests paste options
```

### 16.4 Link/page creation trigger priority

```text
"[[Roadmap" -> menu ranks existing page links first, then add sub-page, then add new page in...
"+Roadmap"  -> menu ranks add sub-page/add new page first, then existing page links
"+ " at line start -> bulleted list Markdown rule, no page menu
```

## 17. Test matrix

Implementations SHOULD maintain fixtures for:

- All shortcuts in Section 8 on macOS and Windows/Linux labels.
- All slash aliases in Section 9 with exact, prefix, fuzzy, and disabled searches.
- IME composition around `/`, `@`, `[[`, `+`, `:`, Markdown markers, Enter, Backspace, and Escape.
- Paste from Notion-like HTML, Google Docs HTML, Markdown, plain text, single URL, multiple URLs, images, PDFs, and mixed files.
- Copy/cut/paste of text selections across blocks, whole blocks with children, comments, mentions, equations, links, tables, and synced-block placeholders.
- Focus-trap and nested-editor conflicts for link editor, comment composer, code block, equation editor, database cell, and command palette.
- Accessibility keyboard navigation and screen reader labels for all autocomplete menus.

## 18. Source anchors

Primary public sources used by this spec:

- Notion Help Center: [Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)
- Notion Help Center: [Using slash commands](https://www.notion.com/help/guides/using-slash-commands)
- Notion Help Center: [Writing and editing basics](https://www.notion.com/help/writing-and-editing-basics)
- Notion Help Center: [Comments, mentions & reminders](https://www.notion.com/help/comments-mentions-and-reminders)
- Notion Help Center: [Create links & backlinks](https://www.notion.com/help/create-links-and-backlinks)
- Notion Help Center: [Embeds, bookmarks & link mentions](https://www.notion.com/help/embed-and-connect-other-apps)
- Notion Help Center: [Link previews](https://www.notion.com/help/link-previews)
- Notion API: [Rich text object](https://developers.notion.com/reference/rich-text)
- Notion API: [Block object](https://developers.notion.com/reference/block)
- Local research: `research/notion-editor-architecture/00-source-index.md` and `02-editor-ux-dx.md`
