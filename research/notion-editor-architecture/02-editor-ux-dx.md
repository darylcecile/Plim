# Notion editor UX/DX and architecture implications

## Scope

This document researches Notion's public editor interaction model and the data-model signals exposed by public Notion Help Center and Notion API documentation. It is intended to inform a future Notion-like clone, especially the editor UX, command system, document tree model, schema constraints, and collaboration/automation boundaries.

**Evidence labels used below:**

- **Confirmed:** Behavior or data shape explicitly described in public Notion documentation.
- **Inference:** Architecture or implementation likely implied by public behavior, but not confirmed by Notion. Notion's internal editor, collaboration algorithm, storage, and client implementation details are not public.

## UX behavior

### 1. Block-based editing and page canvas

**Confirmed:** Notion presents page content as composable blocks. Its Help Center says every piece of content added to a page, such as text, image, or table, is a block, and every page is a stack of blocks combined however the user wants ([What is a block?](https://www.notion.com/help/what-is-a-block)). The same article says users can press `/` on desktop or tap `+` above the mobile keyboard to see content types, can turn any block into another type, and can use the `⋮⋮` handle to drag, drop, reorder, and reshape content ([What is a block?](https://www.notion.com/help/what-is-a-block)).

**Confirmed:** Desktop page editing is centered on three visible tools: the `+` add-block icon, the `⋮⋮` block menu/drag handle, and the `/` command menu. The block menu exposes actions including `Turn into`, `Color`, `Copy link to block`, `Duplicate`, `Move to`, `Delete`, `Comment`, `Suggest edits`, and `Ask AI` ([Intro to writing & editing](https://www.notion.com/help/writing-and-editing-basics)). The `/` menu duplicates much of the add/action surface: users can type `/bullet`, `/heading`, `/delete`, `/duplicate`, or `/red` to insert content, invoke actions, or apply colors ([Intro to writing & editing](https://www.notion.com/help/writing-and-editing-basics); [Using slash commands](https://www.notion.com/help/guides/using-slash-commands)).

**Confirmed:** Notion's block vocabulary includes basic text/page/list/heading/table/toggle/quote/divider/link/callout blocks, databases, media, embeds, advanced blocks such as buttons, breadcrumbs, and table of contents, plus inline options such as mentions, dates/reminders, and emoji ([Intro to writing & editing](https://www.notion.com/help/writing-and-editing-basics)). In the public API, a block object has an `id`, `parent`, `type`, timestamps, author metadata, `has_children`, `in_trash`, and a type-specific payload; documented block types include `paragraph`, headings, list items, `to_do`, `toggle`, `child_page`, `child_database`, `column_list`, `column`, `table`, `table_row`, `bookmark`, `link_preview`, `synced_block`, `template`, and many media/embed types ([Block object](https://developers.notion.com/reference/block)).

**Inference:** The editor is not merely a rich-text document with formatting marks. It needs a first-class block tree where each row of text, media object, database view, table, column, synced region, and nested page has an identity, parent, order, type-specific schema, and separate rendering/editing behavior.

### 2. Slash commands and contextual command menus

**Confirmed:** Pressing `/` opens a full menu of content blocks. Users can type after `/` to filter commands, for example `/text`, `/page`, `/bullet`, `/todo`, `/toggle`, `/quote`, `/h1`, `/link`, `/mention`, `/date`, `/image`, `/book`, `/embed`, `/duplicate`, `/moveto`, `/delete`, `/toc`, `/button`, `/template`, `/bread`, and `/math` ([Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)). Slash commands also modify existing content: `/turnbullet` can change a block type, `/red` can apply color, `/comment` can add a comment, and `/duplicate` can duplicate content ([Using slash commands](https://www.notion.com/help/guides/using-slash-commands)).

**Confirmed:** The writing basics page says the block menu's top area includes a combination of the user's most-used and recently-used blocks, implying recency/frequency ranking in addition to static categories ([Intro to writing & editing](https://www.notion.com/help/writing-and-editing-basics)).

**Confirmed:** With one or more blocks selected, `cmd/ctrl` + `/` opens an action menu that can change block type, color, edit, duplicate, or move the selected blocks; in databases, selecting multiple rows/cards and using `cmd/ctrl` + `/` can edit them all at once ([Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)).

**Confirmed:** On mobile, Notion states that the editing experience is different: there are no `/` commands and no hover-revealed icons. Content is created from the toolbar above the keyboard; users can tap `+` to see block types and use toolbar actions for @-tagging, comments, image insertion, delete, indent/outdent, colors, duplicate, and block links ([Intro to writing & editing](https://www.notion.com/help/writing-and-editing-basics)).

**Inference:** A clone should model slash commands and selected-block commands as one command registry with multiple invocation surfaces: slash menu, `+` menu, block handle menu, selection action menu, keyboard shortcuts, mobile toolbar, and possibly AI. Command descriptors need labels, aliases, icons, categories, search keywords, context predicates, permission predicates, input schemas, ranking metadata, and handlers that emit transactions.

### 3. Markdown and input shortcuts

**Confirmed:** Notion supports inline Markdown-like shortcuts while typing: `**text**` for bold, `*text*` for italic, backticks for inline code, and `~text~` for strikethrough ([Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)). At the beginning of a line or block, `*`, `-`, or `+` followed by space creates a bulleted list; `[]` followed by space creates a to-do checkbox; `1.`, `a.`, or `i.` followed by space creates numbered lists; `#`, `##`, and `###` followed by space create headings; `>` followed by space creates a toggle list; `"` followed by space creates a quote; and `---` creates a divider ([Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts); [Intro to writing & editing](https://www.notion.com/help/writing-and-editing-basics)).

**Confirmed:** Keyboard shortcuts can also create or transform block types: `cmd/ctrl` + `option/shift` + `0` creates text, `1`/`2`/`3` create headings, `4` creates a to-do, `5` a bulleted list, `6` a numbered list, `7` a toggle list, `8` a code block, and `9` a page or converts the current line into a page ([Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)).

**Inference:** These behaviors require input rules that observe typed text at specific positions, consume trigger text atomically, replace a block or text span with a new structure, and integrate with undo so a user can reverse an accidental transform. Inline formatting rules operate inside rich text spans, while line-start rules usually transform the whole block type.

### 4. Keyboard shortcuts, block selection, and editing modes

**Confirmed:** Notion distinguishes text editing from block selection. Pressing `Esc` selects the block the cursor is in or clears selected blocks; `cmd/ctrl` + `a` once selects the current block; arrow keys move selection between blocks; `shift` + up/down expands selection; `shift` + click selects a range of blocks; `cmd` + `shift` + click on Mac or `alt` + `shift` + click on Windows/Linux selects or deselects a whole block; `backspace`/`delete` deletes selected blocks; `cmd/ctrl` + `D` duplicates selected blocks; `enter` edits text inside a selected block or opens a page inside a page ([Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)).

**Confirmed:** Block-level commands include `cmd/ctrl` + `shift` + arrow keys to move selected blocks, `cmd/ctrl` + `option/alt` + `T` to expand/collapse all toggles in a toggle list, `cmd/ctrl` + `shift` + `H` to apply the last text/highlight color, and `cmd/ctrl` + `enter` to modify the current block by opening a page, toggling a checkbox, opening/closing a toggle, or full-screening embeds/images ([Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)).

**Confirmed:** Text-level commands include `enter` for a new text line/block, `shift` + `enter` for a line break inside a block, `cmd/ctrl` + `B/I/U`, `cmd/ctrl` + `shift` + `S`, `cmd/ctrl` + `K` for links, pasting a URL over selected text to make a link, and `cmd/ctrl` + `E` for inline code ([Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)).

**Confirmed:** Notion notes its shortcut docs are for English/QWERTY keyboards and says internationalization is on the roadmap ([Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)).

**Inference:** The editor needs a selection state machine with at least three modes: caret/range selection inside rich text, whole-block selection over one or more block IDs, and specialized grid/card/table selections. Keyboard dispatch must be context-aware so the same key means different operations depending on selection mode and block type.

### 5. Workspace search, command search, and page search

**Confirmed:** `cmd/ctrl` + `P` or `cmd/ctrl` + `K` opens workspace search or jumps to recently viewed pages when the cursor is not focused in a block; `cmd/ctrl` + `F` searches inside a page ([Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts); [Search in your workspace](https://www.notion.com/help/search)). Workspace search supports exact phrase matching by quoting the query, recent pages, result labels such as `Most viewed` or `Popular this week`, sorting by relevance or timestamps, and filters such as title-only, creator, teamspace, location, and date ([Search in your workspace](https://www.notion.com/help/search)).

**Confirmed:** Desktop Notion adds Command Search outside the app. Users can trigger search and Notion AI with a customizable keyboard shortcut, menu bar on Mac, or task bar on Windows without foregrounding Notion; the desktop app can open search when creating a new tab ([Search in your workspace](https://www.notion.com/help/search); [Notion for desktop](https://www.notion.com/help/notion-for-desktop)).

**Confirmed:** Search limitations matter for editor/data modeling: Notion says date mentions are included in search, but other @mentions of pages and people, comments/discussions, and some property values are not included in workspace search; database search searches page names and property values but not the page body, while workspace search searches inside database pages ([Search in your workspace](https://www.notion.com/help/search)).

**Inference:** A clone should separate local editor command search from global content search. The former runs over a command registry and current selection; the latter runs over indexed pages, blocks, database properties, permissions, and recency/popularity signals. It should define which embedded objects, comments, mentions, and property values are indexable before shipping.

### 6. Inline mentions, page links, reminders, comments, and backlinks

**Confirmed:** Users can type `@` to mention a person, page, date, or reminder. Person mentions notify workspace members; page mentions create inline links that automatically update if the page title changes; date mentions accept dates or words like today/tomorrow/yesterday; `@remind` followed by a date creates a reminder that notifies the user ([Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts); [Comments, mentions & reminders](https://www.notion.com/help/comments-mentions-and-reminders)).

**Confirmed:** `[[` and `+` also trigger page linking/creation flows. `[[` prioritizes page linking, while `+` prioritizes page creation; both can link existing pages, create sub-pages, or create a new page elsewhere ([Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts); [Links & backlinks](https://www.notion.com/help/create-links-and-backlinks)). `/link` inserts a Link to page block, which behaves more like a sub-page and appears in the sidebar under the page where it was inserted; @-mentioning a page is closer to a hyperlink and does not make it a subpage ([Links & backlinks](https://www.notion.com/help/create-links-and-backlinks)).

**Confirmed:** Every block has its own anchor link: hover, click `⋮⋮`, and select `Copy link to block` ([Links & backlinks](https://www.notion.com/help/create-links-and-backlinks)). Backlinks are created automatically when a page is @-mentioned and respect access controls; backlinks to private pages are only visible to users with access and may be labeled private ([Links & backlinks](https://www.notion.com/help/create-links-and-backlinks)).

**Confirmed:** Comments can be top-level page discussions, text-range comments, or block comments. Users can comment by selecting text, using a block's `⋮⋮` menu, clicking a block comment icon, or pressing `cmd/ctrl` + `shift` + `M`. Notion says users cannot comment on multiple blocks at a time, but can select text across multiple blocks and comment through the menu ([Comments, mentions & reminders](https://www.notion.com/help/comments-mentions-and-reminders)).

**Inference:** Mentions and comments imply durable references to users, groups, pages, dates, blocks, and text ranges. A clone should store mentions as structured inline nodes, not plain URLs, and should maintain title denormalization, permission-aware previews, backlink indexes, notification fanout, and comment anchors that survive text/block edits where possible.

### 7. Link unfurling, bookmarks, embeds, and external content

**Confirmed:** Pasting URLs can produce different representations. For ordinary web links, users can paste as a compact link mention with icon/source/title and hover preview, or paste as a bookmark block with title, description, and URL ([Links & backlinks](https://www.notion.com/help/create-links-and-backlinks); [Embeds, bookmarks & link mentions](https://www.notion.com/help/embed-and-connect-other-apps)). Public or permissioned pages may fail to render rich information if authentication/cookies/access are unavailable ([Links & backlinks](https://www.notion.com/help/create-links-and-backlinks)).

**Confirmed:** Notion link previews are live, synced visualizations for supported platforms including GitHub, Jira, Slack, Asana, Trello, Linear, Zoom, Figma, Adobe XD, Dropbox, OneDrive/SharePoint, Pitch, Amplitude, Hex, GRID, GitLab, Box, Lucid, Whimsical, ClickUp, and Zendesk ([Link previews](https://www.notion.com/help/link-previews)). Users paste a supported link and choose `Paste as: Preview`; first use prompts OAuth/authentication; once authenticated, the preview updates as relevant source fields change; anyone who can view the Notion page can see content pasted as a link preview, with some abstraction for private Slack channels/DMs ([Link previews](https://www.notion.com/help/link-previews)). The link preview guide says paste options include `Paste as preview`, `Paste as mention`, and `Paste as link`; link previews are currently for page content, not comments, page titles, or database text fields ([Bring live links into your Notion workspace with link previews](https://www.notion.com/help/guides/notion-api-link-previews-feature)).

**Confirmed:** The Notion API describes Link Previews as real-time excerpts of authenticated content. A Link Preview-enabled URL triggers authentication, token exchange, developer-specified unfurl attributes, and update/delete notifications from the connection; link previews differ from embed blocks because the developer controls the unfurled data, and OAuth-backed previews can update as source data updates ([Link Previews API introduction](https://developers.notion.com/guides/link-previews/introduction); [Unfurl attribute object](https://developers.notion.com/reference/unfurl-attribute-object)).

**Confirmed:** Embeds can show online content from many domains via Iframely; Notion says some websites prohibit embedding, embeds requiring login will not work on desktop or mobile apps, most embeds can be resized, and embed blocks can be moved or placed in columns ([Embeds, bookmarks & link mentions](https://www.notion.com/help/embed-and-connect-other-apps)).

**Inference:** A clone needs a paste pipeline that can classify clipboard content, offer choices, and create one of several node types: inline text link, inline unfurled mention, bookmark block, generic embed block, authenticated link-preview block, media/file block, or synced database. Link previews need asynchronous background fetch/update, OAuth account selection, permission-aware rendering, caching, and graceful error states.

### 8. Drag-and-drop, block handles, moving, and duplicating

**Confirmed:** Any content block, including lines of text, table rows, board cards, and gallery cards, can be dragged around a page. Users hover over a block, drag the `⋮⋮` handle, follow blue guides, and release to drop. Drag-and-drop also works in the sidebar to reorder pages, nest pages, and move pages between sections ([Intro to writing & editing](https://www.notion.com/help/writing-and-editing-basics)). Holding `option/alt` while dragging duplicates content ([Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)).

**Confirmed:** The block menu can move a block to another page, duplicate it, copy a block link, delete it, turn it into another type, color it, comment on it, suggest edits, and ask AI ([Intro to writing & editing](https://www.notion.com/help/writing-and-editing-basics)). Database table rows and columns can be rearranged by dragging row handles or column headings; cards/rows in views also support drag interactions ([Table view](https://www.notion.com/help/tables); [Intro to databases](https://www.notion.com/help/intro-to-databases)).

**Inference:** Drag-and-drop must produce structural move/copy operations with destinations such as before sibling, after sibling, as child/nested child, into a column, into a page/sidebar parent, or into a database view. It must preserve children, comments, block links, synced-block identity, and selection. Drop guides are UI projections of valid tree positions, not just pixel locations.

### 9. Nesting, outlining, toggles, headings, and table of contents

**Confirmed:** Pressing `Tab` indents and nests content; Notion explicitly says whenever you indent, you are nesting that block inside the block above it, and selecting the parent selects everything nested under it. `Shift` + `Tab` un-nests content ([Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)). Toggle list blocks can contain other content and open/close; toggle headings make all content within the headings collapsible/expandable ([Intro to writing & editing](https://www.notion.com/help/writing-and-editing-basics); [Columns, headings & dividers](https://www.notion.com/help/columns-headings-and-dividers)).

**Confirmed:** The API documents which block types support child blocks, including list items, callouts, child pages/databases, columns, toggleable headings, paragraphs, quotes, synced blocks, tables, templates, to-dos, and toggles ([Block object](https://developers.notion.com/reference/block)). A block's children must be retrieved with the Retrieve block children endpoint, which returns only the first level and must be paginated/recursed for nested content ([Retrieve block children](https://developers.notion.com/reference/get-block-children)).

**Confirmed:** Table of contents can be inserted as a block with `/table of contents` or shown as a page-level right-side setting when a page has headings. The ToC block is a single unit; users edit the real heading blocks to change ToC text. H2/H3 headings are indented in the ToC, and indented headings are not included ([Columns, headings & dividers](https://www.notion.com/help/columns-headings-and-dividers)).

**Inference:** The document tree must distinguish visual indentation from real parent-child relationships. Outlining commands are tree transforms. Rendering of collapsed toggles/headings and table of contents requires derived views over the tree, with normalization rules to avoid invalid nesting.

### 10. Multi-block and partial selection

**Confirmed:** On desktop, users can click and drag from the left or right page margin to select entire blocks or multiple blocks. They can click and drag within a block to select, cut, copy, and paste partial text across paragraphs, bullet lists, callouts, and more. Notion notes partial text selection across blocks is supported on all platforms except Firefox, where they were working with Mozilla to enable it ([Intro to writing & editing](https://www.notion.com/help/writing-and-editing-basics)).

**Confirmed:** Mobile supports double-tap text selection and dragging selection across multiple blocks, but Notion for mobile says users cannot select multiple blocks on a page at a time ([Intro to writing & editing](https://www.notion.com/help/writing-and-editing-basics); [Notion for mobile](https://www.notion.com/help/notion-for-mobile)).

**Inference:** Notion's selection model spans both browser-native text ranges and custom block selections. Cross-block rich-text selection is likely hard because content is rendered as separate editable block nodes; Firefox limitations suggest browser selection APIs influence behavior.

### 11. Columns, simple tables, and layout blocks

**Confirmed:** Columns are created by dragging blocks side-by-side with the `⋮⋮` handle and blue guides. Users can create many columns across the page width, remove them by dragging content back, delete empty columns, and resize columns by dragging vertical guides ([Columns, headings & dividers](https://www.notion.com/help/columns-headings-and-dividers)). Columns are available on tablet but not mobile; on phones, right-hand columns are placed under left columns ([Columns, headings & dividers](https://www.notion.com/help/columns-headings-and-dividers); [Notion for mobile](https://www.notion.com/help/notion-for-mobile)).

**Confirmed:** The public API exposes `column_list` and `column` block types. Columns can only be appended to `column_list` blocks; when creating a `column_list`, it must have at least two `column` children and each column must have at least one child; `width_ratio` can customize column width and provided ratios should add to 1 ([Block object](https://developers.notion.com/reference/block)).

**Confirmed:** Simple tables are non-database tables. They are added with `/table` or the `+` menu, support row/column add/remove, resizing, header row/column, color/clear cell actions, fit-to-page width, and conversion to a database. Notion notes users currently cannot paste multiple simple-table cells at once ([Columns, headings & dividers](https://www.notion.com/help/columns-headings-and-dividers); [Simple tables vs databases](https://www.notion.com/help/guides/simple-tables-vs-databases)).

**Inference:** Columns are not just CSS columns; they are explicit tree nodes so content order, mobile collapse order, block movement, and API representation are deterministic. Simple tables should be modeled separately from databases; they are closer to structured rich-text/grid blocks and have different paste/edit semantics.

### 12. Databases embedded as blocks

**Confirmed:** Notion describes databases as collections of pages. Every item in a database is its own Notion page, with properties at the top and free page space underneath for arbitrary blocks, subpages, or inline databases ([Intro to databases](https://www.notion.com/help/intro-to-databases)). Databases can be full-page or inline; inline database controls are hidden until hover, can be expanded to full page, and can be moved, duplicated, deleted, or converted by dragging to/from the sidebar ([Intro to databases](https://www.notion.com/help/intro-to-databases)).

**Confirmed:** Database views include table, board, gallery, list, calendar, timeline/chart and related layouts depending on docs/version. Databases support properties, filters, sorts, grouping, multiple views, linked views, relations/rollups/formulas, and table rows/cards that open as pages ([Intro to databases](https://www.notion.com/help/intro-to-databases); [Table view](https://www.notion.com/help/tables); [Simple tables vs databases](https://www.notion.com/help/guides/simple-tables-vs-databases)). Notion warns that when a database contains more than 1,000 items, new pages may appear in the middle instead of the end due to sorting/indexing ([Intro to databases](https://www.notion.com/help/intro-to-databases)).

**Confirmed:** The API has a `child_database` block type, a database object with `is_inline`, and database/data-source APIs. Current API docs describe a database as an object containing one or more data sources, displayed inline in a parent page or as a full page; each data source has its own schema and rows/pages, while permissions are managed through databases ([Block object](https://developers.notion.com/reference/block); [Database object](https://developers.notion.com/reference/database)). Database queries accept filters and sorts similar to UI filters/sorts and operate on database properties with pagination ([Query a database](https://developers.notion.com/reference/post-database-query)).

**Inference:** A clone should not model databases as ordinary tables nested in document text. A database block is a view widget over a collection of page records with schema, property values, views, permissions, and a body block tree per row/page. Inline/full-page presentation is a view/layout choice over the same database entity.

### 13. Synced blocks

**Confirmed:** Synced blocks let the same block content appear in multiple places across pages or workspaces. Users select blocks, choose `Turn into` → `Synced block`, copy the synced block, and paste it elsewhere. Editing any instance updates all places where that block exists; editing shows a border and a header indicating other pages and the original. Users can unsync a single copy or unsync all copies from the original ([Synced blocks](https://www.notion.com/help/synced-blocks)).

**Confirmed:** Synced blocks are permission-sensitive: if a user lacks access to the page containing the original block, they cannot see the synced block contents and can request access; edit access to the original is needed to edit synced copies ([Synced blocks](https://www.notion.com/help/synced-blocks)). Notion also documents an important edge case: if a synced block has more than 10 copies, clicking `Unsync all` or deleting the original removes all copies, and undo will not restore them in that case ([Synced blocks](https://www.notion.com/help/synced-blocks)).

**Confirmed:** The API exposes `synced_block` as a block type and supports it among child-supporting blocks and appendable block types ([Block object](https://developers.notion.com/reference/block); [Append block children](https://developers.notion.com/reference/patch-block-children)).

**Inference:** Synced blocks imply indirection rather than physical duplication. A source synced block owns canonical children, copies reference the source, and permissions resolve through the source page. Unsync likely materializes a snapshot copy. Collaboration and deletion need special cascading behavior and guardrails.

### 14. Templates, buttons, and automation-like blocks

**Confirmed:** Notion buttons automate repetitive tasks. Users type `/` and choose `Button`, give it a name/emoji, then configure one or more actions ([Buttons](https://www.notion.com/help/buttons)). Actions include inserting blocks above/below/top/bottom, adding a page to a database, editing pages/properties in a database, sending notifications, sending Gmail, sending webhooks, showing confirmation, opening a page or URL, sending Slack notifications, and defining variables using mentions/formulas ([Buttons](https://www.notion.com/help/buttons)). Buttons require edit permissions, and actions that modify target pages/databases require permissions on those targets; Notion validates button setup errors and may block save until required corrections are made ([Buttons](https://www.notion.com/help/buttons)).

**Confirmed:** The slash-command docs refer to `/button` or `/template` as a template button that duplicates any combination of blocks ([Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)). The API rich text docs include `template_mention` for placeholder date/user mentions inside template button content, such as `today`, `now`, and `me` values that populate when duplicated ([Rich text object](https://developers.notion.com/reference/rich-text)).

**Inference:** Button/template blocks combine editor content, workflows, formulas, variables, permissions, and side effects. A clone should store button configuration as structured data and execute actions transactionally with validation, confirmation, permission checks, and failure reporting.

### 15. AI affordances

**Confirmed:** Notion exposes AI in editor surfaces. The block menu includes `Ask AI` for block actions ([Intro to writing & editing](https://www.notion.com/help/writing-and-editing-basics)). The AI FAQ says users can highlight text or hit `space` in a page to have Notion AI edit a page, review a section, fix grammar, change length/tone, create new content, translate, brainstorm, and then accept/discard changes or try again ([Notion AI FAQs](https://www.notion.com/help/notion-ai-faqs)). Users can type `/AI Block` to create an AI-powered block that generates custom output, page summaries, or key points and can be regenerated over time ([Notion AI FAQs](https://www.notion.com/help/notion-ai-faqs)).

**Confirmed:** Notion AI also appears in search/desktop/mobile surfaces: workspace search can include `Search all sources with AI`, desktop has a shortcut (`shift` + `cmd/ctrl` + `J`) for Notion AI, and mobile offers AI via home-screen widget, Siri, Spotlight, shortcuts, or action button ([Search in your workspace](https://www.notion.com/help/search); [Notion AI FAQs](https://www.notion.com/help/notion-ai-faqs); [Notion for mobile](https://www.notion.com/help/notion-for-mobile)). Notion AI can create databases/properties/views, auto-populate database pages, and help write formulas ([Notion AI FAQs](https://www.notion.com/help/notion-ai-faqs)).

**Inference:** AI is another command surface that proposes edits to the same document/database transaction layer. Because Notion exposes accept/discard/retry, AI output should be represented as a preview/diff or pending transaction, not immediately committed without review.

### 16. Mobile and desktop differences

**Confirmed:** Mobile has no hover states; `•••` and `+` icons are visible instead. Mobile has no columns and collapses desktop-created columns to a single column. Mobile cannot select multiple blocks on a page, import data, or edit some account/workspace/security/billing settings ([Notion for mobile](https://www.notion.com/help/notion-for-mobile)). The writing basics doc adds that mobile has no `/` commands, uses the editing toolbar above the keyboard, supports double-tap text selection across blocks, and exposes toolbar actions for block insertion, @-tagging, comments, images, delete, indent/outdent, colors, duplicate, and block links ([Intro to writing & editing](https://www.notion.com/help/writing-and-editing-basics)).

**Confirmed:** Desktop adds app-specific capabilities such as tabs, push notifications, command search outside the app, menu/task-bar integration, and automatic updates ([Notion for desktop](https://www.notion.com/help/notion-for-desktop)).

**Inference:** A clone should treat desktop and mobile as different shells over a shared document engine. Mobile cannot rely on hover, block handles may need persistent/tappable affordances, slash invocation should have an equivalent toolbar command picker, and columns need deterministic responsive collapse behavior.

## Architecture implications

### 1. Canonical document tree operations

**Confirmed:** Public API data strongly supports a tree model: blocks have `parent`, `has_children`, type-specific child arrays for some block types, and a Retrieve block children endpoint that returns only immediate children and requires pagination/recursion for nested content ([Block object](https://developers.notion.com/reference/block); [Retrieve block children](https://developers.notion.com/reference/get-block-children)). Parent objects are consistent across pages, databases, data sources, comments, and blocks; blocks can be parented by pages, data sources, or blocks; databases can be parented by pages, blocks, or workspace ([Parent object](https://developers.notion.com/reference/parent-object)).

**Confirmed:** The public API supports appending children, updating blocks, and trashing/restoring blocks. Updating a block replaces the entire value for a given field if provided; deleting sets `in_trash: true` rather than permanently removing it ([Append block children](https://developers.notion.com/reference/patch-block-children); [Update a block](https://developers.notion.com/reference/update-a-block); [Delete a block](https://developers.notion.com/reference/delete-a-block)). API request limits include about three requests per second per integration, max 1000 block elements and 500KB payload, rich-text arrays limited to 100 elements, and rich-text content limited to 2000 characters per `text.content` ([Request limits](https://developers.notion.com/reference/request-limits)).

**Inference:** The editor's private client protocol almost certainly has richer operations than the public API, because public append/update/trash endpoints do not cover all UI operations such as arbitrary reorder/move, split/merge blocks, drag into columns, multi-block transform, undo, or collaborative text edits. A clone should define internal operations such as `insert_block`, `delete_block`, `move_block`, `duplicate_subtree`, `split_block`, `merge_blocks`, `indent`, `outdent`, `set_block_type`, `set_rich_text`, `patch_annotations`, `set_property`, `create_database_page`, and `update_view`.

### 2. Rich text and inline node model

**Confirmed:** Blocks that support rich text expose arrays of rich text objects. Rich text object types are `text`, `mention`, and `equation`; annotations include bold, italic, strikethrough, underline, code, and color; text objects can include links; mention objects include database, date, link preview, page, template mention, or user references ([Rich text object](https://developers.notion.com/reference/rich-text)).

**Inference:** A clone should avoid storing a paragraph as a single HTML string. Use a rich-text segment model with inline nodes and annotations so mentions, dates, page links, equations, link-preview mentions, comments, and search indexing stay semantic. Rich-text normalization must merge adjacent identical spans, preserve entity references through paste/undo, and enforce length/array limits if interoperating with Notion-like APIs.

### 3. Command registry and command execution

**Confirmed:** The same capabilities appear through `/`, `+`, `⋮⋮`, keyboard shortcuts, selected-block `cmd/ctrl` + `/`, database row batch edit, and mobile toolbar ([Intro to writing & editing](https://www.notion.com/help/writing-and-editing-basics); [Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts); [Notion for mobile](https://www.notion.com/help/notion-for-mobile)).

**Inference:** Implement commands as declarative records rather than scattered UI callbacks. Each command should define:

- IDs and aliases (`heading_1`, `/h1`, `/#`, shortcut `mod+alt+1`).
- Context (`text-caret`, `block-selection`, `database-row-selection`, `table-cell-selection`, `mobile-toolbar`).
- Guards (schema-valid parent, permissions, feature flags, plan limits, offline state).
- Preview metadata (label, icon, category, recent/frequent ranking).
- A handler that emits an editor transaction, not direct DOM mutation.
- Undo/redo grouping and analytics/audit metadata.

### 4. Transaction model and undo/redo

**Confirmed:** Notion exposes undo/redo on mobile under the top-right `•••` menu and supports keyboard-driven duplicate/delete/move/transform operations on selections ([Intro to writing & editing](https://www.notion.com/help/writing-and-editing-basics); [Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)). Buttons and AI can create or edit pages/databases and sometimes require confirmation, validation, or accept/discard flows ([Buttons](https://www.notion.com/help/buttons); [Notion AI FAQs](https://www.notion.com/help/notion-ai-faqs)).

**Inference:** Editor changes should be expressed as transactions containing one or more operations, preconditions, selection-before/after, and metadata. A single user intent may touch many nodes: converting a multi-block selection to synced block, creating columns, accepting an AI rewrite, or clicking a button that inserts blocks and edits database properties. Transactions need atomicity, validation, undo grouping, conflict handling, and optimistic local application.

### 5. Selection model and anchoring

**Confirmed:** Notion supports whole-block selection, multi-block range selection, partial text selection across blocks, selected-block commands, table multi-cell fill right/down, database multi-row edit, text comments, block comments, and mobile limitations ([Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts); [Intro to writing & editing](https://www.notion.com/help/writing-and-editing-basics); [Table view](https://www.notion.com/help/tables); [Comments, mentions & reminders](https://www.notion.com/help/comments-mentions-and-reminders)).

**Inference:** A clone needs explicit selection types:

- `TextSelection`: block ID plus inline offsets, possibly spanning multiple blocks.
- `BlockSelection`: ordered block IDs/ranges, preserving nesting rules.
- `CellSelection`: table/database grid coordinates.
- `CardSelection` or `RowSelection`: database view items.
- `GapSelection` or drop target: before/after/inside positions for keyboard and drag moves.

Comment anchors and suggestions should reference block IDs plus rich-text offsets or stable text anchors; block comments should reference block IDs. Selection mapping must update anchors after transactions.

### 6. Input rules and normalization

**Confirmed:** Notion has line-start transformations, inline mark transformations, mention/link trigger menus, `Esc` dismiss behavior, slash-command menus, and page creation/linking triggers (`@`, `[[`, `+`) ([Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts); [Links & backlinks](https://www.notion.com/help/create-links-and-backlinks)).

**Inference:** Input rules should be plugins that observe insert-text/composition/paste events, parse surrounding text, and emit transactions. They must be IME-safe, undoable, context-aware (e.g., do not turn `#` into a heading in code blocks), escapeable (`Esc` closes menus), and localized. Normalizers should enforce schema constraints after every transaction, such as no column outside column list, no empty column list, valid table rows, toggleable-heading child rules, contiguous list numbering metadata, and no invalid synced-block cycles.

### 7. Drag/drop move semantics

**Confirmed:** Dragging shows blue guides and can reorder blocks, nest bullets/to-dos, move rows/cards, create columns, reorder pages in sidebar, and duplicate with `option/alt` ([Intro to writing & editing](https://www.notion.com/help/writing-and-editing-basics); [Columns, headings & dividers](https://www.notion.com/help/columns-headings-and-dividers); [Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)).

**Inference:** Drag/drop should be powered by the same transaction layer as keyboard move commands. Valid drop targets are structural positions, not arbitrary DOM containers. Moves across database views need to distinguish manual ordering from sorted/filtered projections: dropping in a sorted view may set a sort property, update a manual rank, or be disallowed. Cross-page moves must update parent IDs, order keys, backlinks/sidebar projections, and permissions.

### 8. Collaboration, optimistic updates, and permissions

**Confirmed:** Notion is collaborative at the UX level: mentions notify people, comments/discussions can be resolved/reopened, synced blocks update across pages/workspaces, link previews update continuously from external tools, database edits can be made by multiple users subject to permissions, and search results depend on access ([Comments, mentions & reminders](https://www.notion.com/help/comments-mentions-and-reminders); [Synced blocks](https://www.notion.com/help/synced-blocks); [Link previews](https://www.notion.com/help/link-previews); [Intro to databases](https://www.notion.com/help/intro-to-databases); [Search in your workspace](https://www.notion.com/help/search)).

**Inference:** The clone should assume low-latency optimistic UI. Local transactions apply immediately, sync to the server, then either commit, rebase, or roll back on validation/permission conflict. Collaborative text editing can use OT, CRDT, or a server-authoritative operation log, but block tree operations also need conflict resolution: simultaneous moves, split/merge around the same block, synced-block source deletion, database schema/property changes, and comment anchors moving under edits.

### 9. Renderer/editor separation

**Confirmed:** Some blocks are editable rich text; some are generated views (table of contents), external renders (embed/link preview), collections (databases), automation triggers (buttons), file/media viewers, or AI outputs ([Intro to writing & editing](https://www.notion.com/help/writing-and-editing-basics); [Columns, headings & dividers](https://www.notion.com/help/columns-headings-and-dividers); [Link previews](https://www.notion.com/help/link-previews); [Buttons](https://www.notion.com/help/buttons); [Notion AI FAQs](https://www.notion.com/help/notion-ai-faqs)).

**Inference:** Each block type should have:

- A read renderer for published/read-only views.
- An editor component for focused editing and toolbar interactions.
- A block chrome adapter for handles, comments, selection, drag/drop, and permissions.
- Schema definition and normalizer.
- Command/input-rule contributions.
- Serialization/import/export behavior.

This separation keeps databases, embeds, AI blocks, and synced blocks from becoming special-case hacks in a monolithic `contenteditable`.

## Clone implementation notes

### Recommended core model

1. **Entities**
   - `Block(id, parent_id, parent_kind, type, props, order_key, created_by, edited_by, timestamps, in_trash, has_children)`.
   - `RichTextSegment(type, text?, mention?, equation?, annotations, href?)`.
   - `Page(id, title/property title, parent, icon, cover, properties?, root_block_id?)`.
   - `Database(id, parent, is_inline, data_sources, views, permissions)` and `DataSource(id, schema, rows/pages)`.
   - `Comment(id, anchor, thread_state, resolved, author, timestamps)`.
   - `SyncedBlock(source_block_id, copy_block_id?, synced_from?)` or equivalent source/copy relation.

2. **Operations**
   - Use small, typed operations (`insert`, `move`, `wrap`, `unwrap`, `split`, `merge`, `patch_text`, `set_type`, `set_props`, `trash`, `restore`, `create_database_page`, `set_property`, `add_comment`, `resolve_comment`).
   - Compose operations into transactions with selection mapping and undo metadata.
   - Validate all transactions against schema and permissions before server commit.

3. **Ordering**
   - Use fractional/ranked order keys for cheap reordering within a parent.
   - Keep order independent of view sorting; database views may project rows by properties rather than physical order.

4. **Normalization**
   - Enforce that column lists contain at least two non-empty columns when created.
   - Prevent columns outside column lists and nested columns inside columns if matching Notion API constraints.
   - Ensure table rows match table width; decide how simple-table cell rich text is represented.
   - Preserve valid nesting under toggle/list/paragraph/callout/quote/to-do/heading blocks that support children.
   - Materialize or reference synced blocks according to source/copy status.

### Command and shortcut design

- Build one command registry shared by slash menu, add menu, block handle menu, selected-block menu, keyboard shortcuts, mobile toolbar, and AI/actions.
- Commands should declare aliases such as `/book`, `/bookmark`, `/web`; `/h1`, `/#`; `/moveto`; `/turnbullet`; `/color` variants.
- Input rules should be separate from commands but may call commands. Example: typing `[] ` invokes `turn_block(to_do)` and removes trigger text.
- Keyboard dispatch should resolve by context: text editing, selected blocks, tables, database rows, modal menus, or mobile shell.
- Include a discoverability layer similar to Notion's shortcut help and recent/most-used slash ranking.

### Selection and editing UX

- Implement block selection independently from browser text selection, but bridge them for copy/paste and comments.
- Keep selection visible and keyboard-operable; `Esc`, arrows, `Shift` range selection, `Enter`, delete, duplicate, and move should work without a mouse.
- Model comments on text ranges and blocks separately. Do not promise multi-block block comments unless the model supports them; Notion explicitly does not comment on multiple blocks at once.
- Treat mobile as touch-first: persistent handles/buttons, no hover dependency, no desktop-only multi-block selection, responsive column collapse.

### Drag/drop design

- Compute drop targets as tree positions with semantic labels: before, after, inside, side-by-side/column, move-to-page, move-to-database.
- Show guides only for valid schema positions.
- Use the same operations for mouse drag, keyboard move, and menu `Move to`.
- Preserve subtree identity for normal moves; duplicate subtree with new IDs for `option/alt` copy unless duplicating synced blocks intentionally creates another synced copy.
- Confirm or restrict dangerous moves involving synced-block originals, database blocks, permission boundaries, or large subtrees.

### Block renderer/editor separation

- Use a plugin interface per block type: `schema`, `renderRead`, `renderEdit`, `commands`, `inputRules`, `normalizers`, `toMarkdown`, `fromMarkdown`, `toAPI`, `fromAPI`.
- Rich-text blocks can share a text editor core; database, embed, link preview, AI, button, and table blocks should own specialized editors while still exposing common block chrome.
- Generated blocks like table of contents should render from derived heading data and not store duplicated heading text.
- Link previews and embeds need loading/error/auth states and should not block editor typing.

### Database implementation notes

- Treat database rows as pages with body blocks, not as flat records.
- Separate database schema/properties/views from page body content.
- Inline database block should reference a database/view; full-page database is a page-level rendering of the same database entity.
- Implement table/list/board/calendar/gallery views as projections over page rows and property values.
- Be explicit about large collection behavior. Notion warns new pages in databases over 1,000 items may not appear at the end because of sorting/indexing; a clone should define insertion semantics under filters/sorts.

### Synced blocks and templates/buttons

- Use source/copy references for synced blocks. Edits to any copy should resolve to the source transaction, with permission checks against the source.
- Unsync should materialize independent blocks and break references.
- Deleting the original needs a clear cascade policy; Notion has surprising behavior for more than 10 copies, so a clone should provide strong warnings and recoverability.
- Buttons should be validated workflows. Store action lists, variables, confirmations, target references, permissions, and error states. Execute as server-side transactions where possible to avoid partial client-side side effects.

### Link previews, bookmarks, and embeds

- Build a paste-intent resolver that offers `link`, `mention`, `bookmark`, `embed`, `preview`, and `database sync` where appropriate.
- Bookmark unfurl can be best-effort public metadata; link preview should be authenticated and provider-driven.
- Store unfurled display data separately from canonical URL and provider account.
- Respect permissions: page viewers may see preview data after an author authenticates, matching Notion's documented behavior, so warn users before insertion.
- Support async refresh, provider errors, access denied, content not found, account switching, and deletion webhooks.

### Accessibility considerations

- Do not make drag handles mouse-only. Provide keyboard alternatives for move up/down, indent/outdent, move to page, create column, and reorder database rows/columns.
- Expose block type and nesting level to assistive tech; lists, toggles, tables, and databases need correct roles/labels.
- Ensure slash/mention menus are accessible comboboxes with keyboard navigation, `Esc` dismiss, focus restoration, and screen reader announcements.
- Provide visible focus states for block selection and handles.
- Ensure color commands do not rely only on color; preserve contrast for block backgrounds and mentions.
- Mobile/touch targets for handles, `+`, `•••`, checkboxes, toggles, and drag affordances must meet touch size guidance.

### Edge cases to test

- Typing `/` as literal text and dismissing with `Esc`.
- Markdown transformations in empty blocks, non-empty blocks, after undo, and inside code/equation contexts.
- IME composition with slash, `@`, `[[`, and Markdown triggers.
- Pasting multi-block content into text selections and block selections.
- Cross-block partial selection, especially browser differences similar to Notion's Firefox caveat.
- Deleting/moving a parent with selected nested children.
- Indent/outdent at top of document, under non-child-supporting blocks, and across heterogeneous selected blocks.
- Columns on mobile collapse order and empty-column deletion.
- Simple table row/column resizing, header toggles, and unsupported multi-cell paste.
- Database row creation under active filters/sorts and large collections.
- Link preview auth failures, account switching, private Slack/GitHub/Jira resources, and unsupported URLs.
- Synced block source deletion, unsync single/all, permissions, and large copy counts.
- Button action partial failure, missing target database/property, lost third-party auth, and permission denial.
- AI accept/discard/retry preserving selection, comments, mentions, and undo history.

## Gaps and unknowns

- **Collaboration algorithm:** Public docs do not say whether Notion uses OT, CRDTs, server-side locking, operational logs, or another method for collaborative editing.
- **Internal storage:** The public API exposes blocks/pages/databases but not internal ordering keys, transaction logs, undo stacks, offline queues, or private move/reorder endpoints.
- **Exact command ranking:** Docs mention recent/most-used blocks in the slash menu but do not specify ranking, personalization, or search scoring.
- **Selection internals:** Public behavior reveals block/text/cell selections, but not how selections are represented, persisted, or mapped across concurrent edits.
- **Normalization details:** API constraints reveal many schema rules, but the full editor normalization logic for lists, toggles, columns, tables, synced blocks, and databases is not public.
- **Mobile parity:** Help docs list several mobile limitations, but exact per-block mobile editing behavior can change and should be tested in the app before cloning.
- **Link preview providers:** Supported platforms and provider-specific fields change over time. The current Help Center list should be treated as a moving integration registry, not hard-coded forever ([Link previews](https://www.notion.com/help/link-previews)).
- **AI internals:** Public docs describe user-facing AI affordances and review flows, but not prompting, retrieval, diff representation, safety filters, or transaction semantics.
- **API/version drift:** Current API docs include newer concepts such as data sources and API version `2026-03-11`; clone research should pin doc versions if implementing API compatibility ([Database object](https://developers.notion.com/reference/database); [Retrieve block children](https://developers.notion.com/reference/get-block-children)).
