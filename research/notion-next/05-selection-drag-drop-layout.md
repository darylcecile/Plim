# Notion-compatible selection, drag-and-drop, and layout specification

## 1. Scope and authority

This document specifies the browser-only TypeScript behavior required to implement a Notion-compatible editor surface for web apps. It is normative for the client editor, renderer, input controller, selection controller, drag-and-drop controller, and layout measurement system. It intentionally does not specify backend storage, networking, authorization services, upload services, or server transaction APIs.

The spec builds on the existing research in `research/notion-editor-architecture/01-data-model.md`, `02-editor-ux-dx.md`, and `04-clone-implications.md`: blocks are stable identity-bearing tree nodes; indentation is structural; rich text is semantic data rather than HTML; commands emit transactions; selection is explicit and must be mapped through transactions; drag/drop is a tree operation; columns, toggles, simple tables, pages, and database views are first-class block/layout structures.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and **MAY** are to be interpreted as normative requirements. If a browser has a platform limitation, the implementation MUST provide the closest compatible behavior using custom overlays, measurement caches, clipboard formats, or keyboard alternatives rather than silently dropping the feature.

## 2. Terminology

- **Block**: A stable record with an ID, type, properties, parent, and ordered child position. Text lines, list items, toggles, pages, columns, simple tables, embeds, and database views are blocks.
- **Block tree**: The ordered render tree produced from parent/child edges. It is the source of truth for layout and structural operations.
- **Root selected block**: A selected block whose ancestor is not also selected. Root selected blocks form the structural payload for block operations.
- **Covered block**: A root selected block and every descendant implied by that selection.
- **Text point**: A stable address inside a rich-text-bearing block: block ID, rich-text path, offset, and affinity.
- **Anchor/focus**: The fixed and moving endpoints of a selection. The anchor is where range extension began; the focus is where it currently ends.
- **Visible traversal**: Preorder traversal of blocks that are rendered in the current page/view, excluding children hidden by collapsed toggles/headings or filtered database projections.
- **Transaction**: A typed, local editor change that mutates the canonical client document state and includes a selection mapping.
- **Drop target**: A semantic tree/view position such as before a block, after a block, inside a block, side-by-side as a column, into a page, or into a database view group.

## 3. Shared invariants

1. The editor MUST treat block identity as independent from DOM identity. DOM nodes MAY unmount, virtualize, or re-render without changing selection anchors or drag payloads.
2. The editor MUST treat native browser selection as an input/output adapter, not the canonical model. The canonical selection MUST be an explicit TypeScript `SelectionState`.
3. Every command that edits document structure, rich text, layout, database rows, or table cells MUST emit a transaction and MUST map the previous selection to a valid post-transaction selection.
4. Structural indentation MUST change the block tree. It MUST NOT be represented only by CSS margin or padding.
5. A selected parent block MUST semantically include its descendants for copy, duplicate, delete, move, export, and block command application unless a command explicitly operates only on root blocks.
6. The implementation MUST expose keyboard alternatives for every pointer-only visual affordance, including block movement, nesting/outdenting, column creation where supported, row/card movement, and drag-handle menu actions.
7. The implementation MUST preserve user intent across viewport resizing, zooming, virtualization, IME composition, undo/redo, and browser focus changes.

## 4. Selection model

### 4.1 Selection states

The editor MUST support these canonical selection states:

1. `none`: no editor selection, used when focus is outside the editor or a modal has intentionally captured interaction.
2. `caret`: a collapsed text insertion point inside one rich-text-bearing block.
3. `rich_text_range`: an expanded range inside one or more rich-text-bearing blocks.
4. `block`: one or more root selected blocks, ordered by visible traversal.
5. `mixed`: a range whose start/end are text points and whose middle may include complete blocks. This is REQUIRED for Notion-like partial selection across block boundaries.
6. `cell`: a simple-table or database-grid selection, when a grid-like block owns the active selection.
7. `gap`: a structural position before/after/inside a block used by keyboard movement, drop preview, or programmatic insertion.

The editor MAY internally add specialized selections for formula editors, code editors, board cards, or embedded widgets, but such selections MUST either map to one of the states above or explicitly suspend the outer editor selection while preserving it for restoration.

### 4.2 Caret selection

- A caret selection MUST contain a `TextPoint` with block ID, rich-text path, offset, affinity, and document revision.
- A caret MUST be visually displayed inside the editable block and MUST be reflected into native selection while the containing editable DOM is mounted and focused.
- If the caret block is virtualized or hidden by a collapsed ancestor, the editor MUST retain the logical caret but MUST show a visible block-level focus indicator or scroll/unfold the block before text input.
- `Enter` in a rich-text block SHOULD split the block or create a new sibling according to the block type. `Shift+Enter` SHOULD insert a soft line break where the block supports it.
- `Esc` from a caret MUST select the containing block. If a menu is open, the first `Esc` MUST close the menu and restore the caret; a subsequent `Esc` MUST select the block.
- A caret in an empty text block MUST expose the same insertion affordances as Notion: placeholder text, slash-command trigger, paste/drop target, and handle/plus controls.

### 4.3 Rich text range selection

- A rich text range MUST preserve anchor/focus direction even if the visual range is normalized for rendering.
- Ranges within a single block MUST support text formatting, link creation, comments, cut/copy/paste, drag-to-replace where supported, and deletion.
- Ranges across multiple blocks MUST support cut/copy/paste, comments on text ranges, text formatting where all covered text supports the mark, and replacement with typed or pasted content.
- Cross-block text selection MUST work in all supported browsers. If native browser selection cannot span the relevant editable islands reliably, the editor MUST render a custom selection overlay and synthesize clipboard/comment payloads from `SelectionState`.
- When a range starts or ends at a block boundary, the selection MUST record explicit boundary affinity so mapping can decide whether inserted text belongs before or after the boundary.
- Formatting commands over a range that partially covers non-text blocks MUST apply only to text spans and MUST leave non-text blocks unchanged unless the command is explicitly structural.

### 4.4 Block and multi-block selection

- A block selection MUST store `anchorBlockId`, `focusBlockId`, and normalized `rootBlockIds` in visible traversal order.
- `rootBlockIds` MUST NOT contain both an ancestor and descendant. Descendants are implied by coverage.
- A block selection over a collapsed toggle or toggle heading MUST cover hidden descendants for structural operations, copy, duplicate, and delete, even though hidden descendants are not individually visible.
- `Cmd/Ctrl+A` inside a text block MUST first select the current block. A second press while the current block is selected SHOULD expand to all sibling blocks or the page body according to current editor context.
- Arrow keys from a block selection MUST move the block focus through visible traversal. `Shift+ArrowUp/Down` MUST extend or shrink the range from the anchor.
- `Shift+Click` on a block MUST select the visible traversal range from the anchor block to the clicked block. Platform-specific additive/toggle shortcuts SHOULD follow Notion-like behavior (`Cmd+Shift+Click` on macOS, `Alt+Shift+Click` on Windows/Linux) and MUST be configurable.
- `Backspace`/`Delete` with a block selection MUST delete/trash the selected root blocks and their descendants in one undoable transaction.
- `Enter` with a selected editable text block MUST place a caret inside it. `Enter` with a selected child page MUST open the page. `Cmd/Ctrl+Enter` MUST trigger the block-specific primary action when one exists, such as toggling a to-do, opening/closing a toggle, opening a page, or full-screening media.

### 4.5 Mixed selections

Mixed selections are REQUIRED because Notion supports partial selection across paragraphs, lists, callouts, and related blocks.

- A mixed selection MUST store `anchor` and `focus` text points plus `coveredBlockIds` derived from tree traversal.
- Copying a mixed selection MUST produce a lossless internal clipboard payload containing partial rich-text slices and complete intervening block subtrees. It MUST also produce HTML, plain text, and Markdown-like fallbacks for external paste targets.
- Deleting a mixed selection MUST join or normalize boundary blocks where the schema permits and MUST preserve valid descendants.
- Formatting a mixed selection MUST apply to covered rich text only. A block-level command over a mixed selection MUST first promote the selection to the smallest valid block selection or MUST reject with a user-visible explanation.
- Comments over mixed text SHOULD anchor to rich-text ranges. The editor MUST NOT claim to support multi-block block comments unless the comment model explicitly supports that separate feature.

### 4.6 Selection anchors and durability

- Text anchors MUST use block IDs plus rich-text paths and offsets, not DOM paths.
- Block anchors MUST use block IDs and MAY include parent/order context for fallback.
- Cell anchors MUST use table/database block ID plus stable row/page ID and stable column/property ID. Numeric row/column indices MAY be cached but MUST NOT be the durable anchor.
- Anchors SHOULD include `assoc`/affinity values (`before`, `after`, `inside`, `nearest`) to resolve insertions at the same position.
- Anchors SHOULD include a `visualX` value for vertical caret motion across lines and blocks.
- The implementation MUST invalidate or repair anchors that point to trashed/deleted content before rendering or executing commands.

### 4.7 Mapping selections through transactions

Every transaction MUST expose a mapping that can transform a pre-transaction `SelectionState` into a post-transaction `SelectionState`.

Required mapping behavior:

- Text insertion before an anchor MUST increment offsets in the same text span; insertion after an anchor MUST not.
- Text deletion covering an anchor MUST move the anchor to the deletion boundary using its affinity.
- Block moves MUST preserve anchors by block ID and MUST update derived traversal order.
- Block deletion MUST move contained text/caret anchors to the nearest valid editable position, preferring the previous visible sibling, then next visible sibling, then parent insertion gap, then page start.
- Block duplication MUST keep selection on the moved/copied result when the transaction was user-initiated duplicate; otherwise it MUST keep selection on the original unless the command requested the duplicate.
- Split-block operations MUST keep pre-split text before the split in the original block and after the split in the new block; anchors at the split boundary MUST use affinity.
- Merge-block operations MUST remap anchors in the removed block into the survivor block with offsets adjusted by the survivor's text length and join separator rules.
- Toggle collapse MUST not delete hidden selection anchors. If a visible selection becomes hidden, the rendered selection MUST collapse to the toggle block while retaining a restorable logical selection where safe.
- Database filter/sort/view projection changes MUST preserve row/page selection by stable page IDs when possible; otherwise they MUST move selection to the nearest visible row/card.

A transaction that cannot map the current selection MUST return an explicit mapping failure and MUST choose a deterministic repair before committing UI state.

### 4.8 Mouse, pointer, touch, and trackpad behavior

- Single-click in editable text MUST place the caret.
- Double-click SHOULD select a word or inline entity. Triple-click SHOULD select the block's text or the block according to platform convention.
- Dragging from inside text MUST create a rich text or mixed selection.
- Dragging from the page left/right margins or block gutter MUST create a block selection and MUST show block selection outlines rather than relying on native text highlight.
- Clicking a block handle MUST focus the block and open its block menu. Dragging a block handle MUST start block drag.
- Pointer capture MUST be used during custom selection and dragging to avoid losing state when the pointer leaves the block or iframe boundary.
- Touch UIs MUST NOT depend on hover. They MUST expose persistent or tap-revealed block controls, native text selection handles where usable, and long-press or toolbar entry points for block selection/actions.
- Mobile MAY omit desktop multi-block block selection if the product intentionally follows Notion mobile limitations, but it MUST still support text selection across blocks and toolbar-based duplicate/delete/indent/outdent for the active block.
- Trackpad interactions MUST distinguish scroll/pan from drag initiation by requiring a handle drag, a movement threshold, or a pressed pointer button.

### 4.9 Keyboard extension and editing modes

The editor MUST implement context-sensitive keyboard dispatch:

- Text mode: text insertion, deletion, marks, links, mentions, comments, slash menu, IME composition, and rich-text range extension.
- Block mode: block navigation, range extension, duplicate, delete, move, indent/outdent, color/type commands, and selected-block command menu.
- Grid mode: cell navigation, range fill, row/card selection, and database-specific actions.
- Menu/modal mode: arrow navigation, `Enter` activation, `Esc` dismiss, typeahead, and focus restoration.

Required shortcuts include:

- `Esc` transition from text/menu to block selection as described above.
- `Shift+ArrowUp/Down` extend block selection in block mode.
- `Tab` and `Shift+Tab` indent/outdent selected blocks when schema-valid and not captured by a nested widget.
- `Cmd/Ctrl+Shift+ArrowUp/Down` move selected blocks up/down.
- `Cmd/Ctrl+D` duplicate selected blocks.
- `Cmd/Ctrl+/` open the selected-block command menu.
- Platform text shortcuts for bold, italic, underline, strikethrough, link, inline code, undo, redo, cut/copy/paste, and select-all.

Shortcut bindings MUST be configurable because Notion documents QWERTY/English limitations and browser/OS conflicts vary.

### 4.10 Focus management

- The editor root SHOULD be a single tab stop that manages roving focus internally, unless accessibility testing shows per-block tab stops are preferable for a specific block type.
- Opening a slash menu, block menu, comment popover, link editor, date picker, or drag keyboard controller MUST store the current selection and restore it when dismissed.
- Toolbar buttons MUST NOT steal selection irreversibly. Commands invoked from toolbar focus MUST operate on the stored editor selection.
- Nested interactive blocks such as embeds, database views, simple tables, buttons, and code editors MUST explicitly enter and leave nested focus mode. While in nested mode, outer editor shortcuts MUST either be suspended or delegated by a documented priority table.
- Browser focus loss to another application MUST preserve selection state for copy/paste and undo, but visual caret blinking SHOULD stop.

### 4.11 Accessibility announcements

- The editor MUST expose visible focus indicators for caret-containing blocks, selected blocks, block handles, drop targets, and keyboard drag mode.
- Block handles MUST have accessible names such as `Block actions for Heading 2` and MUST expose both menu and move actions.
- The editor MUST announce selection changes through an ARIA live region when native assistive technology does not provide equivalent feedback: e.g. `3 blocks selected`, `Text selected from paragraph to toggle`, `Moved 2 blocks into toggle`, `Invalid drop target: cannot move a block into itself`.
- Blocks MUST expose type and nesting level where appropriate. Lists SHOULD use list/listitem semantics; toggles SHOULD use button/disclosure semantics; simple tables SHOULD use table/grid semantics; database views SHOULD use grid/list/board semantics appropriate to the view.
- Keyboard drag mode MUST announce current target and operation, and MUST allow cancel with `Esc`.

## 5. Drag-and-drop model

### 5.1 Drag affordances and handles

- Desktop block controls MUST include a handle/menu affordance equivalent to Notion's `⋮⋮`. It SHOULD appear on hover/focus and MUST also be reachable by keyboard.
- Touch/tablet controls MUST be tap-revealed or persistent and sized for touch. They MUST not require hover.
- Dragging the handle of an unselected block MUST drag that block. Dragging the handle of a block within the current block selection MUST drag all selected root blocks.
- Dragging selected rich text MAY initiate text drag when the browser supports it, but structural block drag MUST require a block handle, gutter drag, keyboard drag mode, or explicit command to avoid accidental moves.
- The drag preview SHOULD show a compact representation of the root selected blocks and a count when multiple blocks are dragged.

### 5.2 Drag payloads

The editor MUST distinguish these payload sources:

1. Internal block payload: root block IDs, source page/view, selection snapshot, and whether descendants are covered.
2. Internal rich-text payload: rich-text slices plus source anchors.
3. Internal cell/row/card payload: row/page IDs, property IDs, view ID, and grouping/sort context.
4. External files: `File` objects from the browser `DataTransfer` or file picker.
5. External URLs: text/URI list, plain text URLs, HTML anchors, or browser bookmarks.
6. External rich text/plain text/HTML: imported through the same classifier used by paste.

Internal drags MUST include an application-specific MIME type when using native HTML Drag and Drop. They MUST also maintain an in-memory payload for same-window drags because some browsers strip custom MIME data.

### 5.3 Drop target resolution

Hit testing MUST resolve pointer coordinates to a semantic `DropTarget`, not just a DOM node. The resolver MUST use measured layout rectangles, schema constraints, current selection, view state, and input modifiers.

```text
Pointer/drop event
  |
  v
Find deepest visible LayoutRect under pointer
  |
  +-- no block under pointer?
  |     |
  |     +-- inside page canvas gap -> page-end/page-start gap target
  |     +-- outside editor -> invalid/external target
  |
  +-- over block chrome/handle?
  |     |
  |     +-- menu click -> no drop target
  |     +-- drag hover -> before/after/inside based on zones
  |
  +-- over simple table/database view?
  |     |
  |     +-- row/card/cell zone -> grid/view target
  |     +-- page body zone -> structural block target
  |
  +-- over column/list/toggle/page body?
        |
        +-- horizontal edge zone -> column side-by-side target if valid
        +-- top band -> before block
        +-- bottom band -> after block
        +-- content/indent band -> inside block if block accepts children
        +-- otherwise nearest valid before/after target
```

Resolution rules:

- The resolver MUST reject moving a block into itself or any of its descendants.
- The resolver MUST reject targets whose schema cannot accept the payload.
- The resolver MUST prefer the deepest valid target when nesting is visually indicated, but MUST avoid surprising deep nesting by using indent thresholds and explicit inside zones.
- Before/after targets MUST reference a parent ID and sibling ID. Inside targets MUST reference a parent ID and insertion side (`start` or `end`).
- Column creation targets MUST only appear when a side-by-side layout is valid, the payload can become column content, and the viewport supports columns.
- Collapsed toggles/headings MAY expose an `inside` target that appends hidden children, but the drop indicator MUST clearly show the content will go inside the collapsed block. Implementations SHOULD auto-expand after a hover delay.
- Database view targets MUST distinguish between moving the database block itself and moving rows/cards inside the view.

### 5.4 Drop indicators

- Drop indicators MUST be projections of validated `DropTarget`s. The editor MUST NOT show an indicator for an invalid drop.
- Before/after indicators SHOULD be horizontal blue guide lines aligned to the target block's content column and indentation level.
- Inside/nesting indicators SHOULD be indented and/or boxed to show the new parent.
- Column indicators SHOULD be vertical guides or side panels showing the resulting column placement and width.
- Database row/card indicators SHOULD match the view: row insertion line for tables/lists, card placeholder for boards/galleries, calendar/timeline placement marker for date-based views.
- Invalid targets MUST provide feedback: no-drop cursor, muted indicator, tooltip or live-region announcement, and unchanged transaction state.

### 5.5 Reordering, nesting, and outdenting

- Reordering blocks MUST preserve relative order of all dragged root blocks.
- Moving a parent block MUST move its entire subtree unless the command explicitly extracts descendants.
- Indenting by drag or `Tab` MUST move selected root blocks into the nearest preceding sibling that accepts children. If multiple blocks are selected, they MUST move together as children preserving order.
- Outdenting by drag or `Shift+Tab` MUST move selected root blocks after their current parent or after the parent's selected ancestor according to visible traversal.
- Dragging to an area between indentation levels MUST choose the nearest valid structural level and MUST show the chosen level before drop.
- Adjacent list items of compatible type SHOULD preserve list continuity after moves. Numbered-list numbering MAY be derived at render time.
- Moving blocks across pages MUST preserve block IDs for moves and allocate new IDs for copies. The client MUST update local parent/order state transactionally.

### 5.6 Columns and layout moves

- Dropping a block to the side of another block MAY create a `column_list` containing two or more `column` children when the schema and viewport allow it.
- Existing blocks moved into columns MUST be wrapped in `column` blocks. The original relative block order MUST be preserved inside columns.
- Moving content out of a column MUST remove empty columns and MUST unwrap a `column_list` that no longer has at least two non-empty columns.
- Resizing columns MUST update column width ratios, not only CSS widths. Ratios SHOULD sum to 1 after normalization.
- Phones MUST render columns as a deterministic vertical sequence, left-to-right then top-to-bottom. Column creation SHOULD be disabled on phone layouts if matching Notion behavior.

### 5.7 Toggles, pages, synced blocks, and database views

- Dropping into a toggle or toggle heading MUST append or insert children under that block. If collapsed, the editor SHOULD auto-expand after a delay or clearly show that the drop is into hidden content.
- Dropping onto a child page block from the page canvas SHOULD offer or perform `move into page` only when the page content is available in the client and the action is valid. It MUST NOT be confused with dropping after the page block.
- Dropping synced block instances MUST preserve source/copy semantics. A move MUST move the instance; a copy SHOULD create another synced copy unless the user explicitly chooses materialized duplicate/unsync behavior.
- Dragging an inline database block MUST move the block as document content. Dragging rows/cards inside a database view MUST operate on database page items, not on the database block.
- Dropping rows/cards between board groups MUST update the grouping property and manual order key in one operation when valid.
- In sorted or filtered database views, manual reordering MUST be disabled, transformed into a property update that makes the row belong at the target, or shown as invalid. The behavior MUST be explicit and predictable.
- Database table columns MAY be reordered by dragging headers. That operation MUST update view/property display order, not the document block tree.

### 5.8 Copy vs move modifiers

- Default internal block drag SHOULD be move.
- Holding `Option/Alt` MUST request copy/duplicate, matching Notion's documented duplicate-drag behavior.
- On platforms where `Ctrl` conventionally means copy, the editor MAY also treat `Ctrl` as copy if it does not conflict with browser/OS behavior.
- The drag cursor, drop indicator, and live-region announcement MUST show whether the operation is move or copy.
- Copying blocks MUST allocate new IDs for copied ordinary blocks and descendants. Links, mentions, comments, and synced-block references MUST follow documented clone rules. At minimum, block comments SHOULD not silently become comments on both original and copy.
- Moving blocks MUST preserve IDs and existing block links.

### 5.9 External drops: files, URLs, text, and HTML

- Dropping files into the editor MUST create file/media placeholder blocks or dispatch a client upload intent. This spec does not define backend upload, but the editor MUST represent uploading, failed, canceled, and completed client states.
- Dropping images/videos/audio/PDFs SHOULD create corresponding media blocks when the file type is supported; unknown files SHOULD create generic file blocks.
- Dropping a URL MUST run the paste/drop classifier and offer or choose among link mention, plain link, bookmark, embed, or authenticated preview according to product capabilities and user intent.
- Dropping plain text with newlines SHOULD create rich text and blocks using the same parser as paste.
- Dropping HTML from external apps MUST sanitize it, preserve safe inline formatting and links, and convert block-like structures into editor blocks where possible.
- External drops MUST respect the current selection: drop onto selected text replaces it; drop onto a block gap inserts blocks; drop onto selected blocks may replace or insert adjacent according to explicit UI feedback.

### 5.10 Autoscroll and long drags

- During pointer drag, the editor MUST autoscroll scrollable containers when the pointer is near an edge. This includes the window, page scroller, modal scrollers, database view scrollers, and horizontal table/board scrollers.
- Autoscroll speed SHOULD scale with distance into the edge zone and MUST be capped to avoid losing pointer context.
- The measurement cache MUST update during autoscroll and viewport resize.
- Long drags over collapsed toggles, pages, or board groups MAY auto-expand/open after a delay, but MUST allow cancel and MUST not commit a move until drop.

### 5.11 Invalid drops

Drops MUST be invalid when they would:

- Create a cycle by moving a block into itself or its descendant.
- Put children under a block type that does not accept children.
- Create `column` outside `column_list` or `column_list` without at least two non-empty columns.
- Put non-`table_row` children directly under a simple table or rows with the wrong table width.
- Move filtered/sorted database rows in a way that cannot produce the visible result.
- Cross a locked/read-only editor boundary.
- Move content into a hidden virtual target without enough loaded context to validate the result.
- Exceed configured client limits for drag payload size or block count without explicit confirmation.

Invalid drops MUST leave the document unchanged and MUST preserve the pre-drag selection.

## 6. Layout model

### 6.1 Block layout and indentation

- Layout MUST be derived from the block tree, block type, viewport, and view state.
- A block's visual indentation MUST correspond to structural depth or view-specific indentation. It MUST NOT be a substitute for parent/child edges.
- Nested lists, to-dos, toggles, quotes, callouts, and paragraphs with children MUST render descendants in an indented child region.
- Selected parent blocks MUST draw selection affordances around the parent row and SHOULD visually indicate descendant coverage when expanded.
- The editor SHOULD use consistent logical spacing units for block gap, handle gutter, content gutter, and child indentation so hit testing and visuals agree.

### 6.2 Block gaps and click zones

- The page canvas MUST expose click zones before, after, and between blocks for caret placement and insertion.
- Clicking an empty gap near text content SHOULD place the caret at the nearest editable text boundary or create/select an insertion gap when no text block exists.
- Clicking the left/right margin and dragging MUST start block selection where supported.
- A block's measured zones SHOULD include: content rect, full row rect, handle rect, gutter rect, child content rect, top drop band, bottom drop band, and side-column bands.
- Gap click zones MUST remain usable under zoom and high-DPI rendering.

### 6.3 Toggles and collapsed content

- Toggle and toggle-heading collapsed state MUST be layout state on the block or view, not deletion of child data.
- Collapsed descendants MUST be excluded from visible traversal and ordinary pointer hit testing.
- Copy/delete/move of a collapsed parent MUST include descendants.
- Search highlights, comments, or selection restoration inside collapsed descendants SHOULD reveal or indicate the collapsed ancestor.
- Measuring collapsed content MUST NOT require rendering all descendants; use tree metadata for coverage counts and lazy measurement for visible descendants.

### 6.4 Columns

- Column layout MUST be represented by `column_list` blocks containing `column` children. `column` blocks MUST NOT appear outside a `column_list`.
- A newly created column list MUST have at least two non-empty columns.
- Column widths MUST be stored as ratios or equivalent normalized data. CSS layout MUST be derived from that data.
- Desktop/tablet layouts SHOULD render columns horizontally while there is sufficient width. Phone layouts MUST collapse to a single vertical stream in column order.
- Drag and resize hit testing MUST include vertical resize handles and inter-column gaps.
- Virtualization MUST treat each visible column as an independently measurable flow while preserving global traversal order for keyboard selection.

### 6.5 Nested lists and numbering

- Bulleted, numbered, to-do, and toggle list items MUST support child blocks according to schema.
- Indent/outdent MUST be normalized so a list item is not nested under an incompatible non-child parent.
- Numbered list counters SHOULD be derived from sibling runs of compatible numbered-list blocks and depth. Moving a numbered item MUST update rendered numbering without mutating unrelated text.
- Selecting or moving a parent list item MUST include nested children.

### 6.6 Simple tables

- Simple tables MUST be distinct from databases. They are structured layout/content blocks, not queryable collections of pages.
- A simple table SHOULD be represented as a `table` block with `table_row` children and table configuration such as width, header row, header column, and column widths.
- All rows MUST match the table width after normalization.
- Cell content SHOULD support rich text and MAY support limited inline mentions/links/comments according to the rich text model.
- Row/column add/remove, resize, header toggles, and cell color actions MUST update table state transactionally.
- The layout MUST support horizontal overflow on narrow screens. It MUST NOT corrupt selection or drag hit testing when scrolled horizontally.

### 6.7 Database views and embedded widgets

- Inline database views MUST participate as blocks in the page layout while owning nested row/card/cell layout internally.
- Database view virtualization MUST preserve row/page selection by stable page IDs.
- Dragging rows/cards inside the view MUST use view-specific hit testing. Dragging the database block handle MUST move the database block in the surrounding page.
- Board, gallery, calendar, timeline, table, and list views MAY have different layout rectangles, but they MUST produce compatible `LayoutRect` and `DropTarget` data for selection/drag controllers.

### 6.8 Measuring and layout rects

- The renderer MUST publish layout measurements through a registry keyed by stable block/view/cell IDs.
- Measurements MUST be updated after mount, resize, content mutation, font load, image/media load, zoom change, column resize, table scroll, and virtualization changes.
- Measurement writes SHOULD be batched with `ResizeObserver`, `IntersectionObserver`, and `requestAnimationFrame` to avoid layout thrashing.
- Hit testing MUST use current viewport coordinates and scroll offsets. It MUST be robust to CSS transforms used by virtualizers.
- Measurement data MUST include enough semantic metadata for hit testing without reading arbitrary DOM during every pointer move.

### 6.9 Virtualized rendering implications

- Virtualization MUST NOT change canonical selection, drag payload, or transaction semantics.
- The editor MUST be able to scroll a selected or targeted block into view by block ID.
- Selections spanning unmounted blocks MUST render partial overlays for visible portions and maintain logical coverage for unmounted portions.
- Drag hit testing near unmounted ranges MUST use spacer/sentinel measurements and tree metadata to resolve insertion before/after the nearest loaded block.
- Copy/delete/move operations over virtualized selections MUST operate over the canonical tree, not the mounted DOM.
- Accessibility metadata such as selected count, row count, and position SHOULD remain correct even when not all blocks are mounted.

### 6.10 Responsive behavior

- The editor MUST define breakpoints or container-query behavior for phone, tablet, and desktop page widths.
- Phone layouts MUST collapse columns into a vertical order and SHOULD disable side-by-side column creation.
- Handles and menus MUST change from hover-revealed to tap-revealed/persistent on coarse pointers.
- Simple tables and database tables SHOULD horizontally scroll rather than compress cells below usable touch size.
- Drop zones MUST adjust to visual layout after responsive collapse; a side-column drop target MUST NOT appear when columns are collapsed.

### 6.11 Browser compatibility constraints

The implementation SHOULD target current evergreen Chromium, Safari, and Firefox.

- Use Pointer Events for custom selection and drag interactions. Mouse/touch fallbacks MAY exist for older embedded browsers.
- Use `beforeinput`, `input`, `compositionstart/update/end`, Clipboard API, Selection API, DataTransfer, ResizeObserver, and IntersectionObserver where available.
- IME composition MUST be respected. Input rules MUST NOT transform text while composition is active unless the browser has committed text.
- Browser-native HTML Drag and Drop is inconsistent on touch and custom MIME payloads. The editor SHOULD use a hybrid custom pointer drag for internal drags and native drag/drop for external files/URLs where required.
- Firefox/Safari selection limitations MUST be handled by canonical selection state and overlays rather than feature omission.
- The editor MUST not use `document.execCommand` as canonical behavior. It MAY use it only as a compatibility shim when the resulting state is normalized back into the model.

## 7. TypeScript contracts

These types are a normative starting point. Implementations MAY add fields, but MUST preserve the semantics.

```ts
export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type BlockId = Brand<string, 'BlockId'>;
export type PageId = Brand<string, 'PageId'>;
export type ViewId = Brand<string, 'ViewId'>;
export type TableId = Brand<string, 'TableId'>;
export type PropertyId = Brand<string, 'PropertyId'>;
export type ClientRevision = Brand<number, 'ClientRevision'>;

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
  | 'divider'
  | 'child_page'
  | 'child_database'
  | 'column_list'
  | 'column'
  | 'table'
  | 'table_row'
  | 'synced_block'
  | 'template'
  | 'bookmark'
  | 'embed'
  | 'image'
  | 'video'
  | 'file'
  | 'unsupported';

export interface RichTextPath {
  /** Path into the block's rich-text-bearing property, e.g. ['title', 3] or ['cells', rowId, colId, 0]. */
  readonly parts: readonly (string | number)[];
}

export type TextAffinity = 'before' | 'after' | 'inside' | 'nearest';

export interface TextPoint {
  readonly blockId: BlockId;
  readonly path: RichTextPath;
  readonly offset: number;
  readonly affinity: TextAffinity;
  readonly revision: ClientRevision;
  readonly visualX?: number;
}

export interface BlockPoint {
  readonly blockId: BlockId;
  readonly parentId?: BlockId | PageId;
  readonly side: 'before' | 'after' | 'inside-start' | 'inside-end';
  readonly depth?: number;
  readonly revision: ClientRevision;
}

export interface CellPoint {
  readonly ownerBlockId: BlockId;
  readonly rowId: BlockId | PageId;
  readonly columnId: PropertyId | string;
  readonly kind: 'simple-table' | 'database-table' | 'database-board' | 'database-gallery' | 'database-list';
}

export type SelectionState =
  | { readonly kind: 'none'; readonly reason?: 'blur' | 'modal' | 'readonly' }
  | {
      readonly kind: 'caret';
      readonly point: TextPoint;
      readonly preferredBlockId?: BlockId;
    }
  | {
      readonly kind: 'rich_text_range';
      readonly anchor: TextPoint;
      readonly focus: TextPoint;
      readonly direction: 'forward' | 'backward';
    }
  | {
      readonly kind: 'block';
      readonly anchorBlockId: BlockId;
      readonly focusBlockId: BlockId;
      readonly rootBlockIds: readonly BlockId[];
      readonly coveredBlockIds: readonly BlockId[];
      readonly traversalScope: 'page' | 'toggle' | 'column' | 'database-view' | 'selection-overlay';
    }
  | {
      readonly kind: 'mixed';
      readonly anchor: TextPoint;
      readonly focus: TextPoint;
      readonly coveredBlockIds: readonly BlockId[];
      readonly fullySelectedBlockIds: readonly BlockId[];
      readonly direction: 'forward' | 'backward';
    }
  | {
      readonly kind: 'cell';
      readonly ownerBlockId: BlockId;
      readonly viewId?: ViewId;
      readonly anchor: CellPoint;
      readonly focus: CellPoint;
      readonly selectedRowIds: readonly (BlockId | PageId)[];
      readonly selectedColumnIds: readonly (PropertyId | string)[];
    }
  | {
      readonly kind: 'gap';
      readonly target: DropTarget;
      readonly initiatedBy: 'keyboard' | 'pointer' | 'program';
    };

export interface LayoutRect {
  readonly id: string;
  readonly blockId?: BlockId;
  readonly parentBlockId?: BlockId;
  readonly viewId?: ViewId;
  readonly blockType?: BlockType;
  readonly depth: number;
  readonly rect: DOMRectReadOnly;
  readonly contentRect?: DOMRectReadOnly;
  readonly rowRect?: DOMRectReadOnly;
  readonly handleRect?: DOMRectReadOnly;
  readonly gutterRect?: DOMRectReadOnly;
  readonly childContentRect?: DOMRectReadOnly;
  readonly scrollContainerId?: string;
  readonly visible: boolean;
  readonly collapsed?: boolean;
  readonly virtual?: boolean;
  readonly acceptsChildren?: boolean;
  readonly columnIndex?: number;
  readonly rowIndex?: number;
  readonly zIndex?: number;
}

export type DropPosition = 'before' | 'after' | 'inside-start' | 'inside-end' | 'side-left' | 'side-right';

export type DropTarget =
  | {
      readonly kind: 'block-position';
      readonly parentId: BlockId | PageId;
      readonly referenceBlockId?: BlockId;
      readonly position: DropPosition;
      readonly depth: number;
      readonly indicatorRect: DOMRectReadOnly;
      readonly allowedEffects: readonly ('move' | 'copy')[];
    }
  | {
      readonly kind: 'column-position';
      readonly columnListId?: BlockId;
      readonly targetColumnId?: BlockId;
      readonly side: 'left' | 'right';
      readonly widthRatioPreview?: readonly number[];
      readonly indicatorRect: DOMRectReadOnly;
      readonly allowedEffects: readonly ('move' | 'copy')[];
    }
  | {
      readonly kind: 'table-position';
      readonly tableBlockId: BlockId;
      readonly rowId?: BlockId;
      readonly columnId?: string;
      readonly position: 'row-before' | 'row-after' | 'column-before' | 'column-after' | 'cell';
      readonly indicatorRect: DOMRectReadOnly;
      readonly allowedEffects: readonly ('move' | 'copy')[];
    }
  | {
      readonly kind: 'database-view-position';
      readonly databaseBlockId: BlockId;
      readonly viewId: ViewId;
      readonly beforePageId?: PageId;
      readonly afterPageId?: PageId;
      readonly groupKey?: string;
      readonly operation: 'manual-order' | 'set-group-property' | 'open-page' | 'move-view-block';
      readonly indicatorRect: DOMRectReadOnly;
      readonly allowedEffects: readonly ('move' | 'copy')[];
    }
  | {
      readonly kind: 'external-import';
      readonly parentId: BlockId | PageId;
      readonly referenceBlockId?: BlockId;
      readonly position: 'before' | 'after' | 'end' | 'replace-selection';
      readonly accepts: readonly ('files' | 'urls' | 'html' | 'text')[];
      readonly indicatorRect: DOMRectReadOnly;
    }
  | {
      readonly kind: 'invalid';
      readonly reason:
        | 'cycle'
        | 'schema'
        | 'readonly'
        | 'self-drop'
        | 'unsupported-payload'
        | 'filtered-view'
        | 'unloaded-target'
        | 'platform';
      readonly message: string;
      readonly nearestValidTarget?: DropTarget;
    };

export interface DragPayload {
  readonly id: string;
  readonly source: 'internal-blocks' | 'internal-text' | 'internal-cells' | 'external';
  readonly selectionBeforeDrag: SelectionState;
  readonly sourcePageId?: PageId;
  readonly sourceViewId?: ViewId;
  readonly rootBlockIds?: readonly BlockId[];
  readonly coveredBlockIds?: readonly BlockId[];
  readonly textHtml?: string;
  readonly textPlain?: string;
  readonly textMarkdown?: string;
  readonly files?: readonly File[];
  readonly urls?: readonly string[];
  readonly rows?: readonly PageId[];
  readonly columns?: readonly (PropertyId | string)[];
  readonly effectAllowed: readonly ('move' | 'copy' | 'link')[];
  readonly requestedEffect: 'move' | 'copy' | 'link';
  readonly createdAt: number;
}

export interface ReorderOperation {
  readonly op: 'reorder' | 'indent' | 'outdent' | 'move' | 'copy' | 'wrap-in-columns' | 'move-database-items';
  readonly payloadId: string;
  readonly blockIds: readonly BlockId[];
  readonly destination: DropTarget;
  readonly preserveRelativeOrder: boolean;
  readonly allocateNewIds: boolean;
  readonly nestingDelta?: -1 | 0 | 1;
  readonly columnWidthRatios?: readonly number[];
  readonly databaseUpdate?: {
    readonly viewId: ViewId;
    readonly groupPropertyId?: PropertyId;
    readonly groupValue?: unknown;
    readonly manualOrderKeyBefore?: string;
    readonly manualOrderKeyAfter?: string;
  };
  readonly selectionAfter: SelectionState;
}

export type SelectionMapResult =
  | { readonly status: 'mapped'; readonly selection: SelectionState }
  | { readonly status: 'repaired'; readonly selection: SelectionState; readonly reason: string }
  | { readonly status: 'invalid'; readonly fallback: SelectionState; readonly reason: string };

export type SelectionMapStep =
  | { readonly kind: 'insert-text'; readonly at: TextPoint; readonly length: number }
  | { readonly kind: 'delete-text'; readonly from: TextPoint; readonly to: TextPoint }
  | { readonly kind: 'split-block'; readonly originalBlockId: BlockId; readonly newBlockId: BlockId; readonly at: TextPoint }
  | { readonly kind: 'merge-blocks'; readonly removedBlockId: BlockId; readonly survivorBlockId: BlockId; readonly survivorOffset: number }
  | { readonly kind: 'move-blocks'; readonly blockIds: readonly BlockId[]; readonly fromParentId: BlockId | PageId; readonly toParentId: BlockId | PageId }
  | { readonly kind: 'copy-blocks'; readonly originalToCopy: ReadonlyMap<BlockId, BlockId> }
  | { readonly kind: 'delete-blocks'; readonly deletedBlockIds: readonly BlockId[]; readonly fallback: BlockPoint | TextPoint }
  | { readonly kind: 'set-collapsed'; readonly blockId: BlockId; readonly collapsed: boolean }
  | { readonly kind: 'view-projection-change'; readonly ownerBlockId: BlockId; readonly visibleRowIds: readonly PageId[] };

export interface SelectionMapping {
  readonly revisionBefore: ClientRevision;
  readonly revisionAfter: ClientRevision;
  readonly steps: readonly SelectionMapStep[];
  mapPoint(point: TextPoint | BlockPoint | CellPoint): TextPoint | BlockPoint | CellPoint | null;
  mapSelection(selection: SelectionState): SelectionMapResult;
}
```

## 8. Drop target and block tree transformation diagrams

### 8.1 Reorder within the same parent

```text
Before                         Drop A after C                  After
Page                           target: parent=Page             Page
├─ A                            reference=C                    ├─ B
├─ B                            position=after                 ├─ C
└─ C                                                           └─ A

Operation: move [A] from Page to Page after C. A keeps its ID and subtree.
```

### 8.2 Indent under preceding sibling

```text
Before                         Drop B inside A                 After
Page                           target: parent=A                Page
├─ A                            position=inside-end            └─ A
├─ B                                                           └─ B
└─ C                           Valid only if A accepts children
                                                              └─ C
```

Rendered more explicitly:

```text
Page
├─ A
│  └─ B
└─ C
```

### 8.3 Outdent from a nested parent

```text
Before                         Shift+Tab / drag left           After
Page                           target: parent=Page             Page
└─ A                            reference=A                    ├─ A
   ├─ B                         position=after                 ├─ B
   └─ C                                                        └─ C
```

If both `B` and `C` are selected, they move together after `A` preserving order.

### 8.4 Create columns by side drop

```text
Before                         Drop B to right of A            After
Page                           target: side-right(A)           Page
├─ A                                                           └─ ColumnList
└─ B                                                              ├─ Column(width=.5)
                                                                 │  └─ A
                                                                 └─ Column(width=.5)
                                                                    └─ B
```

Moving one column's last block out MUST delete the empty column and unwrap or normalize the column list if fewer than two non-empty columns remain.

### 8.5 Move into collapsed toggle

```text
Before                         Hover/drop inside T             After
Page                           target: parent=T                Page
├─ Toggle T [collapsed]         indicator: inside collapsed     ├─ Toggle T [collapsed]
└─ B                                                           │  └─ B (hidden)
                                                              └─ ...
```

The editor SHOULD auto-expand `T` on hover delay. If it stays collapsed, the live region MUST announce that the block moved into collapsed content.

### 8.6 Database board move between groups

```text
Before board view              Drop Card P into Done group      Transaction
Todo: [P, Q]                   before R                         set P.Status = Done
Done: [R]                                                       set P.manualOrder between start and R

After board view
Todo: [Q]
Done: [P, R]
```

If active filters would hide `P` after the property update, the drop MUST warn or reject instead of making the card disappear unexpectedly.

## 9. Edge cases

Implementations MUST handle or explicitly reject these cases:

### 9.1 Selection edge cases

- Caret in an empty block at the beginning/end of a page.
- Text range that starts in a paragraph and ends inside a nested toggle child.
- Mixed selection containing images, embeds, dividers, and text blocks.
- Block selection where the anchor is deleted by a remote/local transaction.
- Parent block selected while a descendant is collapsed or virtualized.
- `Esc` while a slash menu, date picker, link editor, or comment popover is open.
- IME composition while a selection is active and an input rule would normally fire.
- Browser focus loss during selection drag.
- Selecting across columns and then resizing/collapsing columns responsively.
- Selection restoration after undo/redo of split, merge, indent, outdent, and delete.

### 9.2 Drag/drop edge cases

- Dragging a selected parent into one of its descendants.
- Dragging multiple heterogeneous blocks into a block type that accepts only specific children.
- Dragging into/out of collapsed toggles and toggle headings.
- Dragging selected blocks where one selected block is an ancestor of another; normalization must use root selected blocks.
- Dragging a synced block source/copy and choosing move vs copy semantics.
- Dragging files plus text/URL data in the same DataTransfer payload.
- Dragging rows/cards in sorted, filtered, grouped, or paginated database views.
- Dragging table rows/columns while the table is horizontally scrolled.
- Autoscroll across nested scroll containers and virtualized spacers.
- Drop target changes due to responsive column collapse mid-drag.

### 9.3 Layout edge cases

- Empty column deletion and column-list unwrapping.
- Table rows with mismatched width after paste/import.
- Measuring blocks with lazy-loaded images, embeds, or variable fonts.
- Browser zoom levels and high-DPI rounding causing one-pixel drop-zone gaps.
- Nested list numbering after move, delete, indent, and outdent.
- Virtualized selection overlays for unmounted middle blocks.
- RTL or mixed-direction text in rich-text blocks and tables.
- Reduced motion, high contrast mode, and forced colors.

## 10. Conformance tests

An implementation claiming conformance SHOULD automate these tests in Playwright/WebDriver plus unit tests for pure mapping/hit-test functions.

### 10.1 Selection conformance

1. Place caret in paragraph, press `Esc`, verify the paragraph block is selected and announced.
2. Press `Cmd/Ctrl+A` once inside text, verify current block selection; press again, verify expanded page/body selection.
3. Create three sibling blocks, select first, `Shift+ArrowDown` twice, verify ordered root IDs and visual outlines.
4. Drag from page margin across nested blocks, verify root/covered block normalization.
5. Select text from the middle of one block through the middle of another, copy, and verify internal, HTML, Markdown, and plain text payloads.
6. Delete a mixed selection across two paragraphs and verify boundary merge/normalization and selection mapping.
7. Collapse a toggle containing the caret, verify logical selection repair and visible collapsed-parent indication.
8. Split a block with a caret at the split point, undo, redo, and verify caret mapping each time.
9. Merge two text blocks by backspace at start of second, verify anchors in both blocks map into survivor.
10. Run the cross-block selection suite in Chromium, Safari, and Firefox; verify overlay fallback where native selection is insufficient.
11. Use IME composition around slash/mention/Markdown triggers and verify no premature transformation.
12. Open and close slash menu, block menu, link editor, and comment popover; verify focus and selection restore.

### 10.2 Drag/drop conformance

1. Drag an unselected block handle after a later sibling; verify move operation, ID preservation, order, undo, and selection after drop.
2. Select multiple blocks, drag one selected handle, verify all root selected blocks move preserving relative order.
3. Hold `Option/Alt` while dragging; verify copy operation, new IDs, selection on copies, and original unchanged.
4. Attempt to drag a parent into a descendant; verify invalid target feedback and no mutation.
5. Drag a block into a toggle; verify child insertion, collapsed/expanded feedback, undo, and copy payload.
6. Drag a block to the side of another block; verify `column_list`/`column` creation, width ratios, and responsive phone collapse order.
7. Move the last block out of a column; verify empty column deletion and column-list normalization.
8. Drag rows/cards between database board groups; verify grouping property and manual order update or explicit invalid state under filters/sorts.
9. Drag files, URLs, plain text, and HTML into block gaps and selected text; verify classifier output and sanitized import.
10. Drag near top/bottom/left/right scroll edges; verify autoscroll, live target updates, and no accidental drop.
11. Use keyboard drag mode to move, indent, outdent, cancel, and commit; verify live announcements.
12. Repeat internal drags with virtualization enabled and with target blocks initially unmounted.

### 10.3 Layout conformance

1. Render deep nested lists and verify structural depth, ARIA levels, hit-test depth, and selection traversal agree.
2. Collapse/expand toggles and verify visible traversal excludes/includes descendants without losing data.
3. Resize columns and verify stored width ratios, measured rects, drop targets, and keyboard traversal.
4. Switch desktop to phone width and verify columns collapse left-to-right with no side-column drop targets.
5. Resize simple table columns and horizontally scroll; verify cell selection and row/column drag indicators align.
6. Load images/embeds after initial render and verify measurement cache updates without stale drop zones.
7. Virtualize a long page, select a range spanning unmounted blocks, copy/delete, and verify operations use canonical tree.
8. Test zoom levels 80%, 100%, 125%, 200%; verify click zones and indicators remain correct.
9. Test RTL text and mixed-direction blocks; verify caret, range, and drop indicators remain logical.
10. Test high-contrast/forced-colors and reduced-motion; verify selection/drop indicators remain perceivable.

### 10.4 Type-level conformance

- Unit tests MUST verify `SelectionMapping.mapSelection` for insert text, delete text, split, merge, move, copy, delete, collapse, and view projection changes.
- Unit tests MUST verify `resolveDropTarget(pointer, layoutRects, payload, schema)` returns only valid semantic targets.
- Property-based tests SHOULD generate random block trees and moves to verify no cycles, no duplicate selected roots, valid column/table normalization, and deterministic order.
- Clipboard serialization tests SHOULD round-trip internal block payloads and degrade to HTML/Markdown/plain text.

## 11. Implementation checklist

- [ ] Canonical `SelectionState` implemented independently from DOM selection.
- [ ] Selection mapping is required on every transaction and covered by tests.
- [ ] Mouse, pointer, touch, keyboard, and assistive technology paths can all create and modify selections.
- [ ] Block drag uses semantic payloads and validated drop targets.
- [ ] External drop uses the same classifier as paste.
- [ ] Reorder/indent/outdent/columns/database moves all emit transactions.
- [ ] Layout measurements are registered by stable IDs and updated incrementally.
- [ ] Virtualization preserves selection and drag semantics.
- [ ] Columns, toggles, lists, simple tables, and database views have explicit layout/drop behavior.
- [ ] Browser-specific selection/drag limitations have tested fallbacks.
- [ ] Accessibility announcements and keyboard alternatives are implemented for selection and drag/drop.
