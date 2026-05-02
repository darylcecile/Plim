# 35. ProseMirror in Context: Editor Comparison

This chapter situates ProseMirror among its peers. The comparison is
opinionated — there *are* better and worse choices for specific use cases —
but each claim ties to an architectural fact, not a marketing line.

## 35.1 ProseMirror

- **Document model.** Persistent (immutable) tree of `Node` instances.
  Children live in `Fragment`s; inline content carries an array of `Mark`s.
  Every node is validated against a `Schema` whose content expressions are
  compiled to a finite-state automaton (`prosemirror-model/src/content.ts`).
  Identity is structural: two nodes with the same shape `eq()`.
- **Transform.** Atomic `Step` subclasses (`ReplaceStep`, `AddMarkStep`,
  `AttrStep`, …). Each step is invertible (`step.invert(doc)`) and produces
  a `Mapping` describing how positions changed. `Transform` is the mutable
  builder; `Transaction` is a `Transform` plus selection/scroll/meta.
- **Plugins.** A plugin contributes `state` (a reducer over its own slice),
  `props` (view-level hooks like `handleKeyDown`, `decorations`), and
  optional `view()` constructor. Plugins compose via `EditorState.create`;
  ordering matters for `appendTransaction`.
- **Collab.** First-class. `prosemirror-collab` provides client-side step
  buffering and rebasing via the `Mapping` machinery; servers are trivial
  (linearize and broadcast). OT-style — diverging clients rebase their
  local steps over the authoritative history. CRDT integration (Yjs)
  exists via `y-prosemirror`.
- **Rendering.** `EditorView` wraps a `contenteditable` element. PM watches
  it with `MutationObserver` (`prosemirror-view/src/domobserver.ts`),
  intercepts user input (`input.ts`, `capturekeys.ts`), translates DOM
  changes back into transactions, and selectively patches only the
  `ViewDesc` subtrees that actually changed.
- **Strengths.**
  - Schema enforcement is real: invalid documents are unrepresentable.
  - Collab is mature; production deployments have run for ~9 years.
  - Plugin composition is the cleanest in the field.
  - Browser-quirk coverage (IME, Android, RTL) is empirically excellent.
  - Headless: no React/Vue dependency, embeds anywhere.
- **Weaknesses.**
  - `contenteditable` complexity leaks: every browser has its own bugs and
    PM has a workaround file (`browser.ts`) full of feature detection.
  - Single selection only (no multi-cursor like CodeMirror).
  - Steep learning curve; you must internalize positions, slices,
    mapping, and content expressions before non-trivial features work.
  - A11y is mostly "it's a contenteditable, screen readers handle it" —
    custom NodeViews can break that without warning.
  - Mobile virtual keyboards require care; predictive text battles are
    real.

## 35.2 Slate

- **Model.** JSON-shaped: nodes are plain objects with `type`, `children`,
  and arbitrary properties. Operations (`insert_text`, `remove_text`,
  `set_node`, `split_node`, …) are first-class.
- **Transform.** `Editor.apply(op)` mutates an immutable draft (Immer
  under the hood in v0.x; Slate v0.5+ uses its own immutable approach).
  Operations are JSON-serializable.
- **Plugins.** `withX(editor)` higher-order pattern: plugins are functions
  that wrap and override editor methods. No formal plugin manifest;
  composition order is whoever wraps last wins.
- **Collab.** Not built in. Operations *are* OT-friendly (they look like
  Quill deltas), but a working collab stack means stitching together a
  community package (`slate-yjs`, `slate-collaborative`).
- **Rendering.** `slate-react` renders to React; uses `contenteditable`
  but reconciles via React's diff. Non-React renderers exist but are
  community projects.
- **Strengths.**
  - React idiom: components, hooks, props.
  - Simpler mental model — operations look like Redux actions.
  - JSON is human-readable in dev tools.
- **Weaknesses.**
  - Less battle-tested IME; Android-specific bugs surface more often.
  - Schema is enforced via "normalizers" (functions that fix the doc) —
    weaker than PM's structural guarantee.
  - Tied to React; no clean headless story.
  - `contenteditable` fights remain; you've still got two synchronization
    layers (React → DOM, then `contenteditable` → React).

## 35.3 Lexical

- **Model.** Keyed graph. Every node has a unique `__key`; the editor
  state is a flat map of keys to nodes plus parent/child references.
  This is *not* a JSON tree at the API level — it's traversed via
  `getRootNode().getChildren()` etc.
- **Transform.** Imperative `editor.update(() => { … })` blocks. Inside
  the callback, you call methods on node objects; on commit, Lexical
  produces a new immutable state.
- **Plugins.** Listeners (`registerCommand`, `registerNodeTransform`,
  `registerUpdateListener`) — event-bus-shaped. React idiom layered on
  top via `@lexical/react`.
- **Collab.** Yjs adapter (`@lexical/yjs`); CRDT, not OT.
- **Rendering.** Custom reconciler. Lexical doesn't trust the browser —
  on each update, it diffs its own node graph against the previous one
  and applies a minimal DOM patch, then verifies the DOM matches what
  it expected. (PM does similar selective patching but trusts more
  intermediate states.)
- **Strengths.**
  - Performance: the keyed-graph model and aggressive reconciliation
    skip work PM doesn't.
  - Modern API; born after the lessons of Draft.js.
  - Facebook-supported (used in FB/Messenger/Workplace).
- **Weaknesses.**
  - Younger; smaller plugin ecosystem.
  - Schema model is per-`NodeType` class hierarchy, which is more
    code-shaped than declarative.
  - Collab is Yjs-only in practice.

## 35.4 Quill

- **Model.** [Delta](https://quilljs.com/docs/delta/): a sequence of
  ops describing the *change* to a doc, or (with `retain` ops) the full
  doc. **Not a tree.** A doc is an array like
  `[{insert: "Hello"}, {insert: "\n", attributes: {header: 1}}]`.
- **Transform.** Deltas compose via OT (`delta.compose`,
  `delta.transform`). Quill's collab story is the cleanest of the bunch
  *for flat documents*.
- **Plugins.** Modules (`Quill.register`); coarser than PM/Slate
  plugins.
- **Rendering.** Quill maintains a parallel data structure (Parchment)
  mapping the Delta to DOM. The Delta is the source of truth; the DOM is
  the output.
- **Strengths.**
  - Simple API; "give me a textarea-like rich editor" works in 10
    lines.
  - Delta is collab-friendly out of the box.
- **Weaknesses.**
  - Flat sequence model can't naturally express deep nested structure
    (tables, callouts containing lists, etc.). Quill 2.x has worked on
    this but the model fights you.
  - Custom blots/embeds are workable but feel like escape hatches.
  - Less expressive schema than PM's content expressions.

## 35.5 TipTap

- **Model/transform/collab.** ProseMirror, unchanged. TipTap is a
  framework on top.
- **Plugins.** "Extensions" — TipTap's wrapper around PM nodes, marks,
  and plugins, with a config-object DX (`addOptions`, `addAttributes`,
  `addCommands`, `addKeyboardShortcuts`).
- **Strengths.**
  - PM's robustness with much less boilerplate.
  - Strong React/Vue/Svelte bindings.
  - Reasonable defaults for the common 80% (links, lists, tables, code,
    images).
- **Weaknesses.**
  - Opinionated extension shape; complex behaviors fight the framework
    until you reach for raw PM plugins anyway.
  - Debugging spans two layers (TipTap extension → PM plugin); errors
    sometimes surface in the wrong vocabulary.
  - Some PM idioms (custom `appendTransaction` ordering, multi-plugin
    state coordination) require dropping out of the TipTap model.

## 35.6 CodeMirror 6

- **Same author** (Marijn Haverbeke). Different problem.
- **Model.** Line-based (`Text` is a piece-table-like rope of lines),
  not a tree. Decorations and syntax highlighting are layered on via
  Lezer parsers.
- **Transform.** `Transaction` with changes, selection, effects — same
  vocabulary as PM but flat.
- **Rendering.** Own reconciler; CM6 *does not* use `contenteditable`
  for the main view in the same way — it manages a `<div>` of
  prepared lines and intercepts input. Tighter control, fewer browser
  surprises.
- **Use case.** Code editing, structured editors over flat text. Not
  appropriate for prose with marks and nested blocks.

## 35.7 Comparison table

| Aspect | ProseMirror | Slate | Lexical | Quill | TipTap | CodeMirror 6 |
|--------|-------------|-------|---------|-------|--------|--------------|
| Doc model | Immutable tree of `Node`/`Mark`/`Fragment` | JSON tree | Keyed graph | Delta (flat ops) | PM | Line-based rope |
| Transform | `Step` (invertible, mappable) | `Operation` | `editor.update()` block | Delta `compose` | PM | `Transaction` |
| Schema | First-class, FSA-compiled | Normalizer functions | `NodeType` classes | Formats / blots | PM | Lezer grammar |
| Collab | OT (built-in) + Yjs adapter | Community | Yjs | OT (built-in) | PM | Not focus; Yjs adapter |
| Rendering | `contenteditable` + MutationObserver + selective patch | React over `contenteditable` | Own reconciler over `contenteditable` | Parchment over DOM | PM | Own line-based reconciler |
| Plugins | `state` + `props` composition | `withX` HOC | Listener registration | Modules | Extensions over PM | `Extension` value composition |
| Mobile/IME | Excellent (most coverage) | Adequate; Android weak | Good; FB invests | Good | =PM | N/A (different domain) |
| A11y | Inherits `contenteditable`; manual for NodeViews | Same | Same; some ARIA helpers | Some built-in | =PM | Custom; CM6 has its own ARIA story |
| Headless | Yes | No (React) | React-first; core is headless | Coupled | React/Vue/Svelte | Yes |
| License | MIT | MIT | MIT | BSD-3 | MIT | MIT |
| Ecosystem | Large; mature | Large; React-heavy | Growing | Mature; flat | Large; framework-shaped | Large for code |

## 35.8 Decision guide

Pick **ProseMirror** when:

- The document has nested structure (tables, callouts containing lists,
  sectioned articles) and you want the schema to *prove* invalid docs
  can't exist.
- Real-time collab with strong consistency guarantees is required, and
  you want OT over CRDT.
- You will write custom node types with bespoke editing behavior; PM's
  `NodeView` + plugin model is unmatched here.
- You're willing to invest the learning curve.

Pick **TipTap** when:

- You want PM's runtime guarantees but the team is React/Vue-shaped and
  doesn't want to read PM source.
- The editor is "rich text + a few extensions" rather than a deeply
  custom doc tool.

Pick **Quill** when:

- The doc is essentially flat (paragraphs, headings, lists, inline
  formatting).
- You want collab to "just work" via Delta with minimal server effort.
- You don't need nested blocks or a strict schema.

Pick **Slate** when:

- The team is React-first and wants editor code that reads like the
  rest of the app.
- The schema is application-shaped (validated by code, not by a formal
  grammar).
- You can accept rougher mobile/IME behavior.

Pick **Lexical** when:

- Performance on huge documents matters more than ecosystem maturity.
- You want a modern API without contenteditable's surprises bleeding
  through.
- You're already a Yjs shop for collab.

Pick **CodeMirror 6** when:

- The content is code or structured-line text. (Don't pick CM for
  prose; don't pick PM for code.)

## 35.9 Anti-patterns

- *"We'll start with Quill and add tables later."* The Delta model
  fights nested structure; this rewrite is harder than starting with
  PM/TipTap.
- *"We'll use Slate because we want to write React."* TipTap gives you
  PM with a similar React DX and a stronger runtime.
- *"We'll use PM for our markdown editor."* For editors whose source of
  truth is markdown text and whose UI is a textarea-with-preview,
  CodeMirror 6 is the better tool.
- *"We'll roll our own."* Browser quirk coverage in PM, Lexical, and
  CM6 represents tens of thousands of person-hours. Greenfield
  contenteditable editors rediscover the same Android composition bugs
  every time.
