# 01 — Architecture Overview

A high-detail map of the ProseMirror codebase: what each package owns, how
data flows from a key press to a re-rendered DOM, why the model is immutable,
and how the editor recovers when the browser mutates the DOM behind its back.

All citations use the form `package/src/file.ts:line` and refer to the cloned
sources under `/tmp/prosemirror-research/`.

---

## 1. Package Landscape

ProseMirror is intentionally split into ~12 packages. Each package has a
narrow responsibility and the dependency graph is acyclic. This is what makes
it possible to swap the view layer, run the model on a server, or compose a
custom build.

### 1.1 Dependency Graph (declared in `package.json` files)

```
                    ┌────────────────────────────┐
                    │      prosemirror-model     │   (no PM deps; needs orderedmap)
                    │   Node Fragment Mark Slice │
                    │  Schema ResolvedPos DOMIO  │
                    └─────────────┬──────────────┘
                                  │
                ┌─────────────────┼─────────────────┐
                │                 │                 │
        ┌───────▼───────┐  ┌──────▼───────┐  ┌──────▼─────────┐
        │  transform    │  │ schema-basic │  │ schema-list    │
        │ Step Mapping  │  │              │  │                │
        │ Transform     │  └──────────────┘  └────────┬───────┘
        └───────┬───────┘                             │
                │                                     │
        ┌───────▼─────────────────────────────────────┤
        │              prosemirror-state              │
        │ EditorState Plugin Transaction Selection    │
        └───┬─────────────────┬──────────────┬────┬───┘
            │                 │              │    │
   ┌────────▼─────┐   ┌───────▼──────┐  ┌────▼────▼────┐
   │  commands    │   │   keymap     │  │  inputrules  │
   └──────────────┘   └──────────────┘  └──────────────┘
            │
   ┌────────▼─────────────────────────┐
   │        prosemirror-view          │  also depends on model + transform
   │ EditorView ViewDesc DOMObserver  │
   │ Decoration NodeView input.ts     │
   └────────┬─────────────────────────┘
            │
   ┌────────▼─────────┐    ┌─────────────────┐
   │  history         │    │  collab         │   (depends on state only)
   └──────────────────┘    └─────────────────┘
            │
   ┌────────▼──────────────────┐
   │  prosemirror-example-setup│
   └───────────────────────────┘
```

Verified from each package's `package.json` `dependencies` field. Notable
non-obvious edges:

- `prosemirror-state/package.json` lists `prosemirror-view` as a dep, but at
  the source level only types are imported (e.g. `EditorView` reference type
  on `Command`). The runtime dependency is one-way: view → state.
- `prosemirror-history` depends on `view` so it can scroll the cursor into
  view after an undo (`prosemirror-history/src/history.ts` imports
  `EditorView`).
- `prosemirror-collab` depends only on `state` — it does not need view; it is
  a pure transaction rebasing engine.

### 1.2 Per-Package Responsibilities & Public Surface

#### prosemirror-model — the immutable document
- **Responsibility.** Define what a document *is*. No editing, no DOM events.
- **Files (`prosemirror-model/src/`):** `node.ts`, `fragment.ts`, `mark.ts`,
  `schema.ts`, `replace.ts`, `resolvedpos.ts`, `from_dom.ts`, `to_dom.ts`,
  `content.ts`, `diff.ts`, `comparedeep.ts`, `dom.ts`, `index.ts`.
- **Public API surface (re-exported from `index.ts`):**
  `Node`, `TextNode`, `Fragment`, `Mark`, `Slice`, `ReplaceError`, `Schema`,
  `NodeType`, `MarkType`, `ContentMatch`, `NodeRange`, `ResolvedPos`,
  `DOMParser`, `DOMSerializer`, `ParseRule`, `NodeSpec`, `MarkSpec`,
  `AttributeSpec`, `SchemaSpec`.
- **Invariant.** Every method that "modifies" returns a new `Node`/`Fragment`.
  Original nodes are referenced by sibling structures.

#### prosemirror-transform — atomic edits & mapping
- **Responsibility.** Express any document mutation as a sequence of
  invertible, JSON-serializable `Step`s, and translate positions across them.
- **Files:** `transform.ts`, `step.ts`, `replace.ts`, `replace_step.ts`,
  `mark.ts`, `mark_step.ts`, `attr_step.ts`, `map.ts`, `structure.ts`.
- **Public API:** `Transform` (`prosemirror-transform/src/transform.ts:28`),
  `Step` (`step.ts:16`), `StepResult`, `ReplaceStep`, `ReplaceAroundStep`,
  `AddMarkStep`, `RemoveMarkStep`, `AttrStep`, `DocAttrStep`, `Mapping`
  (`map.ts:172`), `StepMap` (`map.ts:72`), `MapResult`, `Mappable`,
  `replaceStep`, `replaceRange`, `replaceRangeWith`, `deleteRange`, plus
  helpers `wrap`, `lift`, `setBlockType`, `join`, `split`, `findWrapping`,
  `liftTarget`, `canSplit`.

#### prosemirror-state — immutable editor state + plugin system
- **Files:** `state.ts`, `transaction.ts`, `selection.ts`, `plugin.ts`,
  `index.ts`.
- **Public API:** `EditorState` (`state.ts:90`), `EditorStateConfig`,
  `Transaction` (`transaction.ts:42`, extends `Transform`), `Selection`,
  `TextSelection`, `NodeSelection`, `AllSelection`, `SelectionRange`,
  `SelectionBookmark`, `Plugin` (`plugin.ts:71`), `PluginSpec`, `PluginKey`,
  `StateField`, `Command`.
- **Public *types* only:** references to `EditorView` for the `Command` and
  `PluginView` signatures.

#### prosemirror-view — DOM renderer + input
- **Files:** `index.ts` (the `EditorView`), `input.ts`, `domobserver.ts`,
  `domchange.ts`, `viewdesc.ts`, `decoration.ts`, `selection.ts`,
  `clipboard.ts`, `domcoords.ts`, `capturekeys.ts`, `dom.ts`, `browser.ts`.
- **Public API surface (`prosemirror-view/src/index.ts:1-32`):**
  `EditorView`, `Decoration`, `DecorationSet`, `DecorationAttrs`,
  `DecorationSource`, `NodeView`, `MarkView`, `ViewMutationRecord`,
  `EditorProps`, `DirectEditorProps`, `DOMEventMap`, `NodeViewConstructor`,
  `MarkViewConstructor`, plus the internal `__parseFromClipboard` /
  `__endComposition` test hooks.
- **Mutability.** Unlike the other packages, the view *is mutable*: it owns
  DOM nodes, listeners, MutationObservers, and the in-place ViewDesc tree.

#### prosemirror-commands
- Pure functions of type `Command = (state, dispatch?, view?) => boolean`.
- Highlights from `commands.ts`: `deleteSelection`, `joinBackward`,
  `joinForward`, `selectNodeBackward`, `selectNodeForward`, `splitBlock`,
  `splitBlockKeepMarks`, `liftEmptyBlock`, `createParagraphNear`, `lift`,
  `joinUp`, `joinDown`, `selectAll`, `chainCommands`, `toggleMark`,
  `wrapIn`, `setBlockType`, `baseKeymap` etc.

#### prosemirror-keymap
- Single export `keymap(bindings)` (`prosemirror-keymap/src/keymap.ts:76`)
  builds a `Plugin` that turns keyboard events into `Command` invocations,
  plus `keydownHandler` for ad-hoc use.

#### prosemirror-inputrules
- Regex-driven on-type transforms (e.g. `--` → em dash, `1. ` → ordered list).
- Public exports include `inputRules`, `InputRule`, `wrappingInputRule`,
  `textblockTypeInputRule`, `smartQuotes`, `emDash`, `ellipsis`, `undoInputRule`.

#### prosemirror-history
- Provides the `history()` plugin and `undo`/`redo` commands.
- Backed by a rope (`rope-sequence`) of `Item`s grouped into a `Branch`
  (`prosemirror-history/src/history.ts:24`). Stores inverted steps and
  their associated `Mapping`s so undo can rebase against subsequent edits.

#### prosemirror-collab
- The reference OT engine. `collab(config)` plugin (`collab.ts:70`),
  `receiveTransaction(state, steps, clientIDs, opts)` (`collab.ts:102`),
  `sendableSteps(state)` (`collab.ts:162`), `getVersion(state)` (`collab.ts:182`).
- Implements rebasing through `Mapping` only — it never re-parses the DOM.

#### prosemirror-schema-basic / -schema-list
- Concrete schemas: paragraph/heading/blockquote/code-block/horizontal_rule/
  hard_break/image; bullet/ordered/list_item; em/strong/code/link marks.
- Show the canonical pattern of `NodeSpec.toDOM` / `parseDOM` round-tripping.

#### prosemirror-example-setup
- Convenience bundle wiring keymap + inputrules + history + dropcursor +
  gapcursor + menubar. Reference for "what does a real editor look like."

---

## 2. The Fundamental Design Split

ProseMirror is split into three layers with sharply different mutability
contracts. This split is the single most important architectural decision in
the codebase.

### 2.1 Layer 1 — Model (immutable, pure data)

`Node`, `Fragment`, `Mark`, `Slice`, `Schema`, `ResolvedPos`. These types are
**deeply immutable** value objects:

- `Node` constructor stores `Fragment` and `Mark[]` directly; methods like
  `cut`, `replace`, `mark`, `copy` return *new* nodes
  (`prosemirror-model/src/node.ts:22`).
- `Fragment` caches its `size` once and is shared liberally between sibling
  trees (`prosemirror-model/src/fragment.ts:10`).
- `Mark.addToSet`, `Mark.removeFromSet`, etc. return new arrays.
- `Schema` is created once and frozen; `NodeType`/`MarkType` instances are
  stable references used as identity keys.

Consequence: a document is a persistent data structure. Two snapshots can
share most of their nodes. Equality comparisons of unchanged subtrees are
O(1) reference checks.

### 2.2 Layer 2 — State (immutable + plugin slots)

`EditorState` is also immutable. It stores `doc`, `selection`, `storedMarks`,
and one extra field per registered plugin
(`prosemirror-state/src/state.ts:90-200`):

```ts
// prosemirror-state/src/state.ts:118
apply(tr: Transaction): EditorState {
  return this.applyTransaction(tr).state
}

// prosemirror-state/src/state.ts:170
applyInner(tr: Transaction) {
  if (!tr.before.eq(this.doc)) throw new RangeError("Applying a mismatched transaction")
  let newInstance = new EditorState(this.config), fields = this.config.fields
  for (let i = 0; i < fields.length; i++) {
    let field = fields[i]
    ;(newInstance as any)[field.name] = field.apply(tr, (this as any)[field.name], this, newInstance)
  }
  return newInstance
}
```

Each field's `apply(tr, value, oldState, newState)` produces the field's next
value. State transitions are *deterministic functions* of `(prevState, tr)`,
which is precisely what the history and collab plugins need.

The transition is also *cooperative*: after the initial pass, plugins'
`appendTransaction` hooks get a chance to enqueue follow-up transactions
(`state.ts:130-165`). Each appended transaction sees the not-yet-final state
and may itself trigger more appends until quiescence:

```
applyTransaction(rootTr):
  for plugin in plugins:
    if plugin.appendTransaction(unseenTrs, oldState, newState):
      newState = newState.applyInner(appendedTr)
  loop until no plugin appends new trs
```

`filterTransaction` (`state.ts:121`) gives plugins a veto right.

### 2.3 Layer 3 — View (mutable, side-effectful)

`EditorView` (`prosemirror-view/src/index.ts:30`) is a *mutable controller*.
It owns:

- `view.dom` — the contenteditable DOM root.
- `view.docView` — a `ViewDesc` tree mirroring the document, holding
  references to live DOM nodes.
- `view.input` — the `InputState` (event listener registrations, last
  keypress timestamps for heuristics, composition state).
- `view.domObserver` — the `MutationObserver` wrapper.
- `view.nodeViews` — the user-supplied custom `NodeView` constructors.

The view *consumes* `EditorState`s; it never *is* one. `view.update(props)`
and `view.updateState(state)` reconcile the DOM in place.

```ts
// prosemirror-view/src/index.ts:69 (constructor, condensed)
this.state = props.state
this.dom = ...
this.editable = getEditable(this)
this.nodeViews = buildNodeViews(this)
this.docView = docViewDesc(this.state.doc, computeDocDeco(this),
                           viewDecorations(this), this.dom, this)
this.domObserver = new DOMObserver(this,
  (from, to, typeOver, added) => readDOMChange(this, from, to, typeOver, added))
this.domObserver.start()
initInput(this)
this.updatePluginViews()
```

That ordering is meaningful: the docView (DOM-attached ViewDesc tree) must
exist before the DOMObserver starts, and input handlers are registered only
after the DOM is mounted.

### 2.4 Why this split?

- **Model is immutable** so any subsystem (history, collab, lint plugins,
  serializers, server-side rendering) can hold references without fear of
  spooky action at a distance.
- **State is immutable** so transitions are reproducible — undo just keeps
  old state references; collab can replay transactions from any base.
- **View is mutable** because the DOM itself is mutable and re-creating it
  on every keystroke would lose selection, focus, IME context, scroll
  position, and battery life. The view's job is *minimal-diff
  reconciliation*.

---

## 3. Unidirectional Data Flow

The core flow is: **DOM event → input handler → command/transaction →
new state → view.update() → DOM diff**.

### 3.1 ASCII Lifecycle

```
              ┌────────────────────────────────────────────┐
              │                  Browser                   │
              │  keydown / mousedown / paste / IME / etc.  │
              └───────────────────┬────────────────────────┘
                                  │ DOM event
                                  ▼
   ┌───────────────────────────────────────────────────────┐
   │ prosemirror-view/src/input.ts                         │
   │   dispatchEvent(view, event)        (input.ts:100)    │
   │   • runCustomHandler  (plugin handleDOMEvents)        │
   │   • built-in handlers (mousedown, keydown, paste, …)  │
   │   • capturekeys.ts for arrow keys / backspace         │
   └───────────────────┬───────────────────────────────────┘
                       │ command(state, dispatch?, view?)
                       ▼
   ┌───────────────────────────────────────────────────────┐
   │ prosemirror-commands or user code                     │
   │   build a Transaction (extends Transform)             │
   │   tr.replaceSelectionWith(...) / tr.setSelection(...) │
   │   dispatch(tr)                                        │
   └───────────────────┬───────────────────────────────────┘
                       │ tr
                       ▼
   ┌───────────────────────────────────────────────────────┐
   │ EditorView.dispatch  (prosemirror-view/src/index.ts:511) │
   │   if props.dispatchTransaction: hand off to host       │
   │   else: view.updateState(view.state.apply(tr))         │
   └───────────────────┬───────────────────────────────────┘
                       │ newState
                       ▼
   ┌───────────────────────────────────────────────────────┐
   │ EditorState.applyTransaction  (state.ts:130)          │
   │   • filterTransaction (plugins veto)                  │
   │   • applyInner (each StateField.apply)                │
   │   • appendTransaction loop until fixpoint             │
   └───────────────────┬───────────────────────────────────┘
                       │ newState
                       ▼
   ┌───────────────────────────────────────────────────────┐
   │ EditorView.updateStateInner  (view/src/index.ts:152)  │
   │   • domObserver.stop()    (avoid feedback loop)        │
   │   • docView.update(doc, outerDeco, innerDeco, view)    │
   │   • selectionToDOM                                     │
   │   • domObserver.start()                                │
   │   • updatePluginViews(prevState)                       │
   └───────────────────┬───────────────────────────────────┘
                       │ DOM mutated
                       ▼
                    Browser repaints
```

Citations for the major hops:

- `input.ts:100` — `dispatchEvent(view, event)`.
- `index.ts:483` — `EditorView.dispatchEvent` (test hook delegating to the
  module function).
- `index.ts:511` — `EditorView.prototype.dispatch` assignment:
  ```ts
  EditorView.prototype.dispatch = function(tr) {
    let dispatchTransaction = this._props.dispatchTransaction
    if (dispatchTransaction) dispatchTransaction.call(this, tr)
    else this.updateState(this.state.apply(tr))
  }
  ```
- `state.ts:130` — `applyTransaction` plugin loop.
- `index.ts:148-360` — `updateState` / `updateStateInner` reconcile.

### 3.2 Why "unidirectional"?

Plugins, commands and node views never mutate the model directly. They
*describe* a desired transition (a `Transaction`) and let the state machine
produce the next `EditorState`. The view's job is then to make the DOM
reflect that new state. No back-channel from view → state exists *except*
through dispatching a new transaction. This is what makes things like
time-travel debugging, server rendering, and history feasible.

---

## 4. "DOM is not the source of truth"

The contenteditable DOM is, in ProseMirror's worldview, a **rendering target
that occasionally lies to you**. Browsers asynchronously mutate the DOM in
response to IME, autocorrect, swipe-typing, drag-drop, and built-in
contenteditable behaviors. ProseMirror's model is the source of truth; the
DOM is reconciled toward it.

But the model can never *fully* prevent the browser from mutating the DOM
(disabling contenteditable would lose IME, accessibility, native selection
gestures). So ProseMirror watches the DOM with a `MutationObserver` and
translates observed mutations *back* into transactions.

### 4.1 The `DOMObserver` (`prosemirror-view/src/domobserver.ts`)

Constructor (`domobserver.ts:39-82`) registers a `MutationObserver` on the
editor root with these options (see `observeOptions` near top of file):
`childList`, `subtree`, `attributes`, `characterData`, `characterDataOldValue`.

```ts
// domobserver.ts:48
this.observer = window.MutationObserver &&
  new window.MutationObserver(mutations => {
    for (let m of mutations) this.queue.push(m)
    if (browser.ie && ...) this.flushSoon()
    else if (browser.safari && view.composing && ...) {
      view.input.badSafariComposition = true
      this.flushSoon()
    } else {
      this.flush()
    }
  })
```

It also listens to `selectionchange` on the document
(`connectSelection`, `domobserver.ts:101`) so cursor moves caused by the
browser (e.g. clicking, drag-selecting) round-trip into the model.

`updateStateInner` calls `this.domObserver.stop()` before mutating the DOM
and `start()` afterwards (visible at `view/src/index.ts:148-360`); this
ensures ProseMirror's *own* DOM changes are not interpreted as user edits.

### 4.2 `readDOMChange` (`prosemirror-view/src/domchange.ts:81`)

When the observer flushes, it computes the affected DOM range and calls back
into the view with `(from, to, typeOver, added)`. `readDOMChange`:

1. If `from < 0`, this was a pure selection change → build a selection-only
   transaction (`domchange.ts:84-99`).
2. Resolve `from`/`to` to the *shared depth* in the doc tree
   (`domchange.ts:103-105`) so the diff window encloses whole node
   boundaries.
3. `parseBetween(view, from, to)` reparses the live DOM into a `Slice` using
   `DOMParser` against the schema.
4. `findDiff(oldFragment, newFragment, ...)` (`prosemirror-model/src/diff.ts`)
   computes the minimal `(start, endA, endB)` change region.
5. Build a `replace` transaction (or, for IME, a composition-aware one) and
   dispatch it.
6. Special-case Android GBoard / iOS Enter key heuristics
   (`domchange.ts:120-130`) where a synthetic Enter must be fired instead
   of the literal DOM mutation.

This is the answer to "how does typing work?" — the browser mutates the DOM,
the observer fires, the view reparses the affected slice, diffs against the
known doc, and dispatches a replace transaction. The view's *own*
`updateStateInner` then re-renders, but because the DOM already reflects the
new state, the reconciler's diff is mostly a no-op.

### 4.3 Bidirectional Sync Diagram

```
            ┌────────────────────────────────┐
            │           EditorState          │   (immutable, doc + selection)
            └──────────────┬─────────────────┘
                           │
      reconcile (push)     │      readDOMChange (pull)
                           │
             ┌─────────────▼───────────────┐
             │  ViewDesc tree (in memory)  │
             │  one-to-one with doc nodes  │
             └─────────────┬───────────────┘
                           │   owns DOM ranges
                           ▼
       ┌────────────────────────────────────────────┐
       │             contenteditable DOM            │
       │  (browser may mutate at any time)          │
       └────────────────┬───────────────────────────┘
                        │ MutationRecord / selectionchange
                        ▼
       ┌────────────────────────────────────────────┐
       │  DOMObserver  →  readDOMChange             │
       │  parseBetween → findDiff → tr.replace      │
       │  view.dispatch(tr)  ─── back to top        │
       └────────────────────────────────────────────┘
```

Push side (state → DOM):
- `view.updateState(newState)` (`view/src/index.ts:149`)
- `updateStateInner` → `docView.update(...)` (calls into
  `viewdesc.ts:ViewDesc.update`)
- `selectionToDOM` after the doc is reconciled.

Pull side (DOM → state):
- `MutationObserver` callback → `domObserver.flush()` →
  `handleDOMChange(from, to, typeOver, added)` →
  `readDOMChange(view, ...)` (`domchange.ts:81`)
- Selection-only changes go through the same `readDOMChange` with `from = -1`.

Crucially, the push side wraps DOM writes between `domObserver.stop()` and
`domObserver.start()` so the reconciler does not re-trigger itself.

---

## 5. Why Immutability Matters

### 5.1 Collab rebasing (`prosemirror-collab/src/collab.ts`)

The collab plugin keeps a list of *unconfirmed* steps the local user has
applied. When the server delivers steps from another user that were based on
an earlier version, the plugin must:

1. Roll back the local steps (use their inverses).
2. Apply the remote steps.
3. Re-apply the local steps, **mapped through** the remote steps' `Mapping`
   so that positions still line up.

This entire dance only works because steps are pure data, the document is
immutable, and `Mapping` lets you translate positions across arbitrary
chains of edits (`prosemirror-collab/src/collab.ts:14` —
`rebaseSteps(steps, over, transform)`). If documents were mutable in place,
"go back to version N and try again" would be impossibly expensive.

### 5.2 History (`prosemirror-history/src/history.ts`)

`Branch` (line 24) stores a rope of `Item`s, each carrying an inverted step
plus its `StepMap`. Undo is "pop the last item, apply its inverse, *map* it
forward through any subsequent edits." Redo is the symmetric operation on
the redo branch. This composability is only sane when every step is
serializable, invertible, and pure — and when document references are
shareable.

### 5.3 Plugin composition (`prosemirror-state/src/plugin.ts`)

Each plugin contributes a `StateField<T>` whose `apply(tr, value, oldState,
newState)` is a pure function. `EditorState.applyInner` (`state.ts:170`)
walks the field list and rebuilds a new state. Because each field is
independent and pure, plugins compose without ordering hazards (other than
ones explicitly modeled by `appendTransaction` ordering).

The `appendTransaction` fixpoint loop (`state.ts:130-167`) is itself only
tractable because *new states are cheap to create* and *old states are
cheap to keep alive*. A mutable design would have to either snapshot
defensively (expensive) or forbid the loop entirely (loses expressiveness).

### 5.4 Plugin views are the escape hatch

Mutable side effects (e.g. tooltip DOM, network calls) are concentrated in
`PluginView` (`plugin.ts:49`) — created per `EditorView` instance with
`update(view, prevState)` and `destroy()` callbacks. The model and state
remain pure; only the view layer holds mutable refs.

---

## 6. Putting It All Together — Annotated Walkthrough

A user types **"a"** with no IME:

1. **DOM event.** Browser inserts character into the focused text node and
   fires an `input` event plus a `MutationRecord` on the next microtask.
2. **`input.ts` keydown path** runs first if the keyboard shortcut plugins
   chose to handle it (e.g. inputrules might intercept `' '` after `## `).
   For a plain "a", no command runs.
3. **MutationObserver fires.** `domobserver.ts` queues the record and calls
   `flush()` (or `flushSoon()` for IE/Safari quirks).
4. **`readDOMChange`** (`domchange.ts:81`) resolves the affected positions,
   reparses the local DOM slice into a `Slice` using the schema-driven
   `DOMParser`, diffs against the prior doc fragment, and constructs a
   `tr = state.tr.replace(from, to, slice)`.
5. **`view.dispatch(tr)`** calls `state.apply(tr)`:
   - `filterTransaction` lets plugins veto.
   - `applyInner` produces the new doc/selection and runs each plugin's
     `StateField.apply` (e.g. history records the inverse step,
     decoration sets get mapped through `tr.mapping`).
   - `appendTransaction` lets plugins enqueue follow-ups (e.g. autosave
     debounce, lint highlight refresh).
6. **`view.updateState(newState)`** (`index.ts:149`) reconciles:
   - Stops the DOM observer.
   - `docView.update(...)` walks the ViewDesc tree, diffing and patching
     DOM in place; node views with custom `update(node)` handlers can opt
     out of recreation.
   - Applies decorations.
   - `selectionToDOM` writes the new selection back.
   - Restarts the observer.
   - Calls each `PluginView.update(view, prevState)`.
7. **Browser repaints.** The DOM and the model agree. The next user input
   restarts the cycle.

For an IME composition, step 6 is suppressed during composition (see
`view.composing` checks at `index.ts:152` and the `clearComposition`
machinery at `input.ts:520`); the model is updated once on `compositionend`
to avoid clobbering the IME's internal state. This is where the
"`__endComposition`" test hook (`index.ts:25`) comes from.

---

## 7. Reference Index of Major Entry Points

| Concern                                | File:Line                                                |
|----------------------------------------|----------------------------------------------------------|
| `EditorView` constructor               | `prosemirror-view/src/index.ts:69`                       |
| `EditorView.update` / `setProps`       | `prosemirror-view/src/index.ts:125` / `:139`             |
| `EditorView.updateState` / `Inner`     | `prosemirror-view/src/index.ts:149` / `:152`             |
| `EditorView.dispatch`                  | `prosemirror-view/src/index.ts:511`                      |
| `dispatchEvent`                        | `prosemirror-view/src/input.ts:100`                      |
| `initInput`                            | `prosemirror-view/src/input.ts:46`                       |
| `DOMObserver` constructor              | `prosemirror-view/src/domobserver.ts:39`                 |
| `DOMObserver.start` / `flush`          | `prosemirror-view/src/domobserver.ts:97` / further down  |
| `readDOMChange`                        | `prosemirror-view/src/domchange.ts:81`                   |
| `EditorState.create`                   | `prosemirror-state/src/state.ts:185`                     |
| `EditorState.apply`                    | `prosemirror-state/src/state.ts:118`                     |
| `EditorState.applyTransaction`         | `prosemirror-state/src/state.ts:130`                     |
| `EditorState.applyInner`               | `prosemirror-state/src/state.ts:170`                     |
| `Plugin` class                         | `prosemirror-state/src/plugin.ts:71`                     |
| `Transaction` class                    | `prosemirror-state/src/transaction.ts:42`                |
| `Transform` class                      | `prosemirror-transform/src/transform.ts:28`              |
| `Step` abstract class                  | `prosemirror-transform/src/step.ts:16`                   |
| `Mapping` class                        | `prosemirror-transform/src/map.ts:172`                   |
| `ReplaceStep` / `ReplaceAroundStep`    | `prosemirror-transform/src/replace_step.ts:7` / `:93`    |
| `Node` class                           | `prosemirror-model/src/node.ts:22`                       |
| `Fragment`                             | `prosemirror-model/src/fragment.ts:10`                   |
| `Mark`                                 | `prosemirror-model/src/mark.ts:10`                       |
| `Slice` / `replace()`                  | `prosemirror-model/src/replace.ts:24` / `:122`           |
| `ResolvedPos`                          | `prosemirror-model/src/resolvedpos.ts:12`                |
| `Schema`                               | `prosemirror-model/src/schema.ts:572`                    |
| `NodeType` / `MarkType`                | `prosemirror-model/src/schema.ts:60` / `:281`            |
| `ViewDesc` base class                  | `prosemirror-view/src/viewdesc.ts:136`                   |
| `NodeViewDesc`                         | `prosemirror-view/src/viewdesc.ts:666`                   |
| `docViewDesc` factory                  | `prosemirror-view/src/viewdesc.ts:906`                   |
| `Decoration` / `DecorationSet`         | `prosemirror-view/src/decoration.ts:108` / `:286`        |
| `keymap` plugin builder                | `prosemirror-keymap/src/keymap.ts:76`                    |
| `history` plugin                       | `prosemirror-history/src/history.ts:391`                 |
| `collab` plugin                        | `prosemirror-collab/src/collab.ts:70`                    |
| `receiveTransaction` / `sendableSteps` | `prosemirror-collab/src/collab.ts:102` / `:162`          |

---

## 8. Take-aways for a Next-Gen Editor

1. **Keep model and state immutable.** Mutability gains nothing here;
   immutability buys you time-travel, rebasing, and trivial plugin
   composition.
2. **Steps are the OT primitive.** Anything that mutates the document must
   be expressible as a JSON-serializable, invertible step that comes with
   a position map. Without that, history and collab are infeasible.
3. **The view is the only mutable layer.** Concentrate side effects there.
   Treat the DOM as a rendering target that occasionally lies; reconcile
   with a `MutationObserver`, never trust contenteditable to be correct.
4. **Plugins are state fields plus props plus an optional view.** This
   triad covers logging, presence, autosave, lint, menu UI, and shortcuts
   without architectural changes.
5. **Keep a clear acyclic package graph.** ProseMirror's split lets you
   run the model on a server, ship a custom view, or unit-test commands
   without DOM. Replicate that boundary discipline.
