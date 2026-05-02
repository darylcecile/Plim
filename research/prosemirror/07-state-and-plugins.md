# 07 — `EditorState`, `Transaction`, and the Plugin System

> Source: `prosemirror-state/src/{state,plugin,transaction}.ts`
> Cross-ref: `prosemirror-view` (consumes state via `EditorView.updateState`) and `prosemirror-model` (provides `Node`, `Mark`, `Schema`).

This file covers the persistent `EditorState` data structure, how transactions mutate it functionally, and the plugin pipeline that runs on every `apply`. Selection mechanics — `Selection.atStart`/`atEnd`/`near`/`findFrom`, the polymorphic `replace`, bookmarks, `tr.setSelection`'s contract, and how the `selection` field is maintained — live in `08-selection.md`.

---

## 1. `EditorState` — the immutable shape

`EditorState` is a *persistent* object. It is never mutated in place: every change produces a new instance via `apply(tr)`. The class itself is deliberately tiny — almost everything lives in fields installed on the instance dynamically.

```ts
// state.ts:90–115
export class EditorState {
  constructor(readonly config: Configuration) {}

  declare doc: Node
  declare selection: Selection
  declare storedMarks: readonly Mark[] | null

  get schema(): Schema { return this.config.schema }
  get plugins(): readonly Plugin[] { return this.config.plugins }
  ...
}
```

Note the `declare` keyword — TypeScript does not emit field initializers. The actual property writes happen in `EditorState.create` and `applyInner` (see §3, §4). Plugin state fields land on the instance under their plugin key.

### Built-in fields

Four built-in fields are always present (`state.ts:21–41`):

| Field | `init` | `apply` |
|---|---|---|
| `doc` | `config.doc ?? config.schema.topNodeType.createAndFill()` | `tr.doc` |
| `selection` | `config.selection ?? Selection.atStart(instance.doc)` | `tr.selection` |
| `storedMarks` | `config.storedMarks ?? null` | `(state.selection as TextSelection).$cursor ? tr.storedMarks : null` |
| `scrollToSelection` | `0` | `tr.scrolledIntoView ? prev + 1 : prev` |

`scrollToSelection` is a **monotonically increasing counter, not a boolean** (`state.ts:37–40`). Every time `tr.scrollIntoView()` was called, the new state's counter is `prev + 1`; otherwise it is carried unchanged. The view detects the request by *comparing* the new counter against the one it last serviced — `prosemirror-view` keeps a stored value and runs its scroll logic when `newState.scrollToSelection !== oldState.scrollToSelection`. A counter (not a flag) is required because two transactions in a row could both request a scroll into the same selection; a boolean would lose the second request after the view consumed the first.

The `storedMarks` apply is subtle: marks are dropped unless the new selection is a *cursor* (collapsed `TextSelection`). See §4 for the full lifecycle and the `ensureMarks` / `addStoredMark` / `addStep` interactions.

### `EditorStateConfig`

```ts
// state.ts:65–81
export interface EditorStateConfig {
  schema?: Schema          // required if no doc
  doc?: Node               // required if no schema
  selection?: Selection
  storedMarks?: readonly Mark[] | null
  plugins?: readonly Plugin[]
}
```

`schema` is derived from `doc.type.schema` when a `doc` is supplied.

---

## 2. `Configuration` — what survives across transactions

The shared, immutable backbone of a state lives in a private `Configuration` object referenced by `state.config`. When a state is "applied", a new `EditorState` instance is allocated but **the same `Configuration` reference is reused** — so the schema, plugin list, and field descriptors are shared by identity.

```ts
// state.ts:45–61
class Configuration {
  fields: FieldDesc<any>[]
  plugins: Plugin[] = []
  pluginsByKey: {[key: string]: Plugin} = Object.create(null)

  constructor(readonly schema: Schema, plugins?: readonly Plugin[]) {
    this.fields = baseFields.slice()
    if (plugins) plugins.forEach(plugin => {
      if (this.pluginsByKey[plugin.key])
        throw new RangeError("Adding different instances of a keyed plugin (" + plugin.key + ")")
      this.plugins.push(plugin)
      this.pluginsByKey[plugin.key] = plugin
      if (plugin.spec.state)
        this.fields.push(new FieldDesc<any>(plugin.key, plugin.spec.state, plugin))
    })
  }
}
```

Key points:

- `fields` is an ordered array of `FieldDesc<T>`. The four base fields come first (in the order `doc`, `selection`, `storedMarks`, `scrollToSelection`), followed by one entry per plugin **that declares a `state` field**, in plugin-array order.
- `pluginsByKey` is the lookup table used by `PluginKey.get` (`plugin.ts:138`) — keys are strings of the form `"name$N"` (see §6).
- Plugin keys are checked for duplicates: adding two distinct `Plugin` instances that share a `PluginKey` throws.
- A `FieldDesc` (`state.ts:11–19`) wraps `init`/`apply` with `bind(fn, plugin)`, so plugin field functions always run with `this === plugin`.

> **Critical ordering consequence.** Because `fields` is a flat ordered array (built-ins first, then plugins-with-state in plugin-array order), and because every `apply` runs through that array sequentially in `applyInner` (§5), **a plugin's `apply` can read built-ins (`doc`, `selection`, `storedMarks`, `scrollToSelection`) and the already-updated state of any plugin earlier in the plugins array — but only the *old* value of any plugin later in the array.** In practice this means: if plugin B depends on plugin A's state, B must come after A in the `plugins` array passed to `EditorState.create`. Get this wrong and B silently sees stale values one transaction late. Same rule applies to `init` (`state.ts:185–191`).

### `FieldDesc`

```ts
// state.ts:11–19
class FieldDesc<T> {
  init: (config: EditorStateConfig, instance: EditorState) => T
  apply: (tr: Transaction, value: T, oldState: EditorState, newState: EditorState) => T
  constructor(readonly name: string, desc: StateField<any>, self?: any) {
    this.init = bind(desc.init, self)
    this.apply = bind(desc.apply, self)
  }
}
```

`name` is `"doc" | "selection" | "storedMarks" | "scrollToSelection"` for built-ins or the plugin key string for plugin fields. That `name` is the actual property key used on the `EditorState` instance — i.e. plugin state is stored at `state[plugin.key]` (`plugin.ts:88`).

---

## 3. `EditorState.create` and `reconfigure`

### `create`

```ts
// state.ts:185–191
static create(config: EditorStateConfig) {
  let $config = new Configuration(
    config.doc ? config.doc.type.schema : config.schema!,
    config.plugins
  )
  let instance = new EditorState($config)
  for (let i = 0; i < $config.fields.length; i++)
    (instance as any)[$config.fields[i].name] = $config.fields[i].init(config, instance)
  return instance
}
```

Fields are initialised **in order**, so a plugin field's `init` can read built-in fields (`doc`, `selection`) and the state of any plugin declared earlier — but **not** later plugins. This is documented on `StateField.init` (`plugin.ts:96–100`).

### `reconfigure`

```ts
// state.ts:199–210
reconfigure(config: { plugins?: readonly Plugin[] }) {
  let $config = new Configuration(this.schema, config.plugins)
  let fields = $config.fields, instance = new EditorState($config)
  for (let i = 0; i < fields.length; i++) {
    let name = fields[i].name
    ;(instance as any)[name] = this.hasOwnProperty(name)
      ? (this as any)[name]
      : fields[i].init(config, instance)
  }
  return instance
}
```

Semantics:
- Fields with names that exist on the old state (the four built-ins, plus any plugin whose key string survives) are **carried over by reference**.
- New plugins (new key) get `init`-ed against the new config (the *plugins-only* object — note `config` here lacks `doc`/`selection`).
- Removed plugins simply drop their field; their state is GC-eligible.

This is the canonical way to add/remove plugins at runtime without losing the document.

> **`reconfigure` cannot change the schema.** Note that `reconfigure` constructs the new `Configuration` with `this.schema` (the old state's schema), not from `config.doc.type.schema` like `create` does — and the `config` parameter doesn't accept `schema`/`doc`/`selection` either. To switch schemas you must build a fresh state via `EditorState.create({ schema: newSchema, doc: ..., plugins: ... })` and either re-parse the old document into the new schema or accept content loss. The view will need a fresh `updateState` (or full re-attach) since plugin views and node views are tied to the old schema's types.

### `toJSON` / `fromJSON`

`toJSON` (`state.ts:217–227`) serialises `doc`, `selection`, optionally `storedMarks`, and any plugin fields whose key you map via the `pluginFields` argument and whose `StateField.toJSON` is defined. `fromJSON` (`state.ts:234–265`) is symmetric and supports plugin field deserialisation through `StateField.fromJSON`.

The `pluginFields` parameter is `{[propName: string]: Plugin}` — you give each plugin a *string property name* under which its serialised state will appear in the JSON, then pass the **same map** to `fromJSON` so each plugin's `StateField.fromJSON` is dispatched correctly:

```ts
import { historyPlugin } from "./history"
import { uploadPlugin } from "./upload"

const pluginFields = { history: historyPlugin, upload: uploadPlugin }

// Serialise:
const json = state.toJSON(pluginFields)
// → { doc: {...}, selection: {...}, history: <historyState>, upload: <uploadState> }

// Deserialise (same map):
const restored = EditorState.fromJSON(
  { schema, plugins: [historyPlugin, uploadPlugin] },
  json,
  pluginFields
)
```

Inside `fromJSON` (`state.ts:248–258`), the loop iterates `pluginFields`, looks up the plugin instance, finds the matching `FieldDesc.name` (= `plugin.key`), and calls `plugin.spec.state.fromJSON(config, json[propName], instance)`. Plugins not present in the map are `init`-ed from scratch.

---

## 4. `Transaction` — the unit of change

`Transaction` extends `Transform` (from `prosemirror-transform`), which already knows how to track `steps`, `docs`, and a `mapping`. Transactions add the editor-level concerns: selection, stored marks, scrolling, time, and a metadata channel.

```ts
// transaction.ts:42–65
export class Transaction extends Transform {
  time: number
  private curSelection: Selection
  private curSelectionFor = 0
  private updated = 0   // bitfield: UPDATED_SEL=1, UPDATED_MARKS=2, UPDATED_SCROLL=4
  private meta: {[name: string]: any} = Object.create(null)
  storedMarks: readonly Mark[] | null

  constructor(state: EditorState) {
    super(state.doc)
    this.time = Date.now()
    this.curSelection = state.selection
    this.storedMarks = state.storedMarks
  }
  ...
}
```

You usually obtain one via `state.tr` (`state.ts:182`):

```ts
get tr(): Transaction { return new Transaction(this) }
```

### Inherited from `Transform`

- `doc: Node` — the *current* document after all steps applied so far.
- `before: Node` — the document the transaction started from.
- `steps: Step[]`, `docs: Node[]` — per-step record.
- `mapping: Mapping` — the composed position map for all steps.
- `addStep`, `replace`, `replaceWith`, `delete`, `replaceRange`, `replaceRangeWith`, `deleteRange`, `insert`, `addMark`, `removeMark`, etc.

> **`docs` vs `steps` off-by-one.** `tr.docs` is the array of *pre-step* documents — `docs[i]` is the doc that step `i` was applied to. The current `doc` is *not* in `docs`; the initial doc *is*. So `tr.docs.length === tr.steps.length` always, and the full timeline is `[...docs, doc]` of length `steps.length + 1`. `tr.before === tr.docs[0]` when at least one step has been added, otherwise `tr.before === tr.doc`.
>
> **`tr.docChanged`** is the simple `tr.steps.length > 0` test; a transaction can be `docChanged === false` while still having `selectionSet` or `storedMarksSet` true.

### Selection on a transaction

```ts
// transaction.ts:71–94
get selection(): Selection {
  if (this.curSelectionFor < this.steps.length) {
    this.curSelection = this.curSelection.map(this.doc, this.mapping.slice(this.curSelectionFor))
    this.curSelectionFor = this.steps.length
  }
  return this.curSelection
}

setSelection(selection: Selection): this {
  if (selection.$from.doc != this.doc)
    throw new RangeError("Selection passed to setSelection must point at the current document")
  this.curSelection = selection
  this.curSelectionFor = this.steps.length
  this.updated = (this.updated | UPDATED_SEL) & ~UPDATED_MARKS
  this.storedMarks = null
  return this
}

get selectionSet() { return (this.updated & UPDATED_SEL) > 0 }
```

Behaviour:
- Reading `tr.selection` lazily maps the original selection through any new steps. `curSelectionFor` is the step count at which `curSelection` is valid.
- `setSelection` requires the selection to be resolved against `tr.doc` (i.e. the current in-progress doc). It clears stored marks and sets the `UPDATED_SEL` bit. See `08-selection.md` §9 for the polymorphic `selection.map` calls invoked by the lazy getter and the per-class semantics.
- `selectionSet` lets downstream code (e.g. plugins) detect "did this transaction explicitly move the selection".

### Stored marks on a transaction

```ts
// transaction.ts:97–125
setStoredMarks(marks: readonly Mark[] | null): this {
  this.storedMarks = marks
  this.updated |= UPDATED_MARKS
  return this
}
ensureMarks(marks: readonly Mark[]): this { ... }
addStoredMark(mark: Mark): this { ... }
removeStoredMark(mark: Mark | MarkType): this { ... }
get storedMarksSet() { return (this.updated & UPDATED_MARKS) > 0 }
```

### `ensureMarks` semantics

```ts
// transaction.ts:106–110
ensureMarks(marks: readonly Mark[]): this {
  if (!Mark.sameSet(this.storedMarks || this.selection.$from.marks(), marks))
    this.setStoredMarks(marks)
  return this
}
```

The "ensure" verb is precise: `ensureMarks(target)` ensures the *effective* mark set going forward equals `target`. The effective set is `tr.storedMarks` if non-null, else the marks at the cursor (`selection.$from.marks()`). If the effective set already equals `target`, this is a **no-op** — `UPDATED_MARKS` is never set, and stored marks remain `null` if they were `null`. This is why a `ToggleMark` command that ends up matching the natural marks doesn't unnecessarily clear the "natural inheritance" mode by writing an explicit empty set.

`addStoredMark(mark)` and `removeStoredMark(mark)` are both built on top of `ensureMarks`, computing the new target by `mark.addToSet`/`removeFromSet` against the *effective* set (storedMarks if set, otherwise `selection.$head.marks()`).

Important interaction with `addStep`:

```ts
// transaction.ts:128–132
addStep(step: Step, doc: Node) {
  super.addStep(step, doc)
  this.updated = this.updated & ~UPDATED_MARKS
  this.storedMarks = null
}
```

Adding a step **clears** stored marks unless they were explicitly re-set after. This means: `tr.setStoredMarks(...).insertText("x")` does *not* preserve the stored marks past the insert — you must `setStoredMarks` again after the structural change. (Most code uses `ensureMarks` after the insert.)

### Scroll, time, meta

```ts
// transaction.ts:135–214
setTime(time: number): this { this.time = time; return this }
scrollIntoView(): this { this.updated |= UPDATED_SCROLL; return this }
get scrolledIntoView() { return (this.updated & UPDATED_SCROLL) > 0 }

setMeta(key: string | Plugin | PluginKey, value: any): this {
  this.meta[typeof key == "string" ? key : key.key] = value
  return this
}
getMeta(key: string | Plugin | PluginKey) {
  return this.meta[typeof key == "string" ? key : key.key]
}
get isGeneric() { for (let _ in this.meta) return false; return true }
```

- `setMeta`/`getMeta` accept a `string`, a `Plugin`, or a `PluginKey`. When a plugin or key is passed, the `.key` string property is used. This is the **canonical cross-plugin signalling channel**.
- View-level meta keys used by `prosemirror-view`:
  - `"pointer": true` — selection changes from mouse/touch
  - `"composition": <id>` — IME composition transactions
  - `"uiEvent": "paste" | "cut" | "drop"`
  - `"appendedTransaction": <rootTr>` — set automatically on every appended tr (see §5)
- `isGeneric` — true iff the meta dict is empty. History uses this as a heuristic for "safe to coalesce with neighbouring tr".

### Convenience replace methods

```ts
// transaction.ts:141–183
replaceSelection(slice: Slice): this { this.selection.replace(this, slice); return this }
replaceSelectionWith(node: Node, inheritMarks = true): this { ... }
deleteSelection(): this { this.selection.replace(this); return this }
insertText(text: string, from?: number, to?: number): this { ... }
```

These delegate to the polymorphic `selection.replace` / `selection.replaceWith` (see `08-selection.md` §1, §3, §5), so e.g. `AllSelection.replace` behaves correctly even when `Slice.empty` is passed.

**Worked flow — replace selected text with a different word:**

```ts
// state.selection is a TextSelection over "old"
const tr = state.tr
  .replaceSelectionWith(state.schema.text("new"), /* inheritMarks */ true)
  // Internally: selection.replaceWith(tr, node) — see selection.ts:93
  // → tr.replaceRangeWith(from, to, schema.text("new", marks))
  // → tr.steps now contains a ReplaceStep
  // → tr.selection has been re-set by selectionToInsertionEnd to a cursor
  //   right after the inserted "new" (selection.ts:454)
  .setMeta("typing", true)
  .scrollIntoView()                  // sets UPDATED_SCROLL → state.scrollToSelection ++

view.dispatch(tr)                    // → view.updateState(state.apply(tr))
```

After dispatch:
- `newState.doc` reflects the inserted text.
- `newState.selection` is a caret immediately after `"new"`.
- `newState.storedMarks` is `null` (because `addStep` cleared it; the new selection is a caret so the field's `apply` would have kept it, but it was already `null` post-`addStep`).
- `newState.scrollToSelection === oldState.scrollToSelection + 1`, signalling the view to scroll.

### `Command` type

`prosemirror-state` exports a single canonical signature for editor commands (`transaction.ts:18`):

```ts
export type Command = (
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
  view?: EditorView
) => boolean
```

Convention:
- A command **inspects** `state` (and optionally `view`) and returns `true` if it *can* apply, `false` if it can't.
- If `dispatch` is provided **and** the command can apply, it builds a transaction and calls `dispatch(tr)` *before* returning `true`.
- If `dispatch` is `undefined`, the command is being **probed** (e.g. by a menu to decide whether to enable the button). It must not dispatch and must return whether it *would* have dispatched.
- The `view` argument is provided when the command is invoked from a view-attached source (keymap handlers, menu clicks). It's optional because programmatic callers may not have a view.

Example:

```ts
const insertHr: Command = (state, dispatch) => {
  const hr = state.schema.nodes.horizontal_rule
  if (!hr) return false
  if (dispatch) dispatch(state.tr.replaceSelectionWith(hr.create()).scrollIntoView())
  return true
}

// Probe — does NOT modify anything:
if (insertHr(view.state)) menuItem.enable()

// Apply:
insertHr(view.state, view.dispatch.bind(view), view)
```

Commands are how `prosemirror-keymap`, `prosemirror-commands`, and `prosemirror-menu` plug into the editor. Chaining is built by composing: `chainCommands(a, b, c)` runs each in turn until one returns `true`.

### Stored marks lifecycle (transaction & field)

The state diagram below traces `storedMarks` through both layers (the *transaction's* `storedMarks` field, and the *resulting state's* `storedMarks` field):

```
                               state.storedMarks = M0  (caret state)
state.tr ──► tr.storedMarks = M0,    UPDATED_MARKS = 0

   ┌─ tr.addStoredMark(strong) ─────────────────────────────┐
   │  ensureMarks(strong+M0) detects diff → setStoredMarks  │
   │  tr.storedMarks = [strong, ...M0]    UPDATED_MARKS = 1 │
   └────────────────────────────────────────────────────────┘

   ┌─ tr.insertText("x") (calls replaceSelectionWith → addStep) ┐
   │  super.addStep clears: tr.storedMarks = null, ~UPDATED_M  │
   │   …but text was already inserted carrying [strong,…] (read │
   │   before clear in TextSelection.replace's marksAcross path)│
   └───────────────────────────────────────────────────────────┘

state.apply(tr) ──► applyInner ──► storedMarks field's apply runs:
   newState.selection is the caret after "x" (TextSelection, $cursor != null)
   → returns tr.storedMarks (which is now null)
   → newState.storedMarks = null

# So:
# - The single typed character carries [strong, ...M0]
# - The next character typed will inherit naturally from $from.marks()
#   (because storedMarks is null again)
```

If you want the *next several* typed characters to keep `strong`, you have to keep re-stamping after each step. The `ToggleMark` command in `prosemirror-commands` solves the "make next typed char bold even though I haven't typed anything yet" UI by dispatching a tr with **only** `addStoredMark` and **no steps** — `addStep` never fires, so the marks survive the field's `apply` because the new selection is still a caret and `tr.storedMarks` is non-null.

---

## 5. Transaction lifecycle on `state.apply(tr)`

This is the heart of the system. The full pipeline lives in `state.ts:118–179`.

### Pseudo-flow diagram

```
state.apply(tr)
    │
    ▼
state.applyTransaction(rootTr) ─── returns { state, transactions: Tr[] }
    │
    ├── filterTransaction(rootTr)  ◄── ask every plugin's spec.filterTransaction
    │       │
    │       ├── any returns false?  ──► return { state: this, transactions: [] }
    │       │                              (rootTr is dropped silently)
    │       └── all pass
    │
    ├── newState = applyInner(rootTr)
    │       │
    │       ├── verify tr.before.eq(this.doc)        (else RangeError)
    │       └── for each FieldDesc in config.fields, in order:
    │              newInstance[name] = field.apply(tr, oldVal, oldState, newInstance)
    │              ── doc, selection, storedMarks, scrollToSelection,
    │                 then plugin fields in plugin-array order
    │
    ├── trs = [rootTr]
    │
    ├── ┌─ FIXPOINT LOOP ──────────────────────────────────────┐
    │   │ for each plugin i with spec.appendTransaction:        │
    │   │    pass it the transactions it has NOT yet seen       │
    │   │    (slice from seen[i].n)                              │
    │   │    along with seen[i].state (its last "old state")    │
    │   │    and current newState                                │
    │   │                                                        │
    │   │    if it returns a tr:                                 │
    │   │       run filterTransaction(tr, ignore=i) on newState  │
    │   │           ── plugin i is excluded from filtering       │
    │   │       if filter passes:                                │
    │   │           tr.setMeta("appendedTransaction", rootTr)    │
    │   │           trs.push(tr)                                 │
    │   │           newState = newState.applyInner(tr)           │
    │   │           haveNew = true                               │
    │   │                                                        │
    │   │    seen[i] = { state: newState, n: trs.length }        │
    │   │                                                        │
    │   │ if !haveNew after a full pass through plugins ─► EXIT  │
    │   └────────────────────────────────────────────────────────┘
    │
    └─► return { state: newState, transactions: trs }
```

### The actual code

```ts
// state.ts:117–168
apply(tr: Transaction): EditorState {
  return this.applyTransaction(tr).state
}

filterTransaction(tr: Transaction, ignore = -1) {
  for (let i = 0; i < this.config.plugins.length; i++) if (i != ignore) {
    let plugin = this.config.plugins[i]
    if (plugin.spec.filterTransaction && !plugin.spec.filterTransaction.call(plugin, tr, this))
      return false
  }
  return true
}

applyTransaction(rootTr: Transaction): {state: EditorState, transactions: readonly Transaction[]} {
  if (!this.filterTransaction(rootTr)) return {state: this, transactions: []}

  let trs = [rootTr], newState = this.applyInner(rootTr), seen = null
  for (;;) {
    let haveNew = false
    for (let i = 0; i < this.config.plugins.length; i++) {
      let plugin = this.config.plugins[i]
      if (plugin.spec.appendTransaction) {
        let n = seen ? seen[i].n : 0, oldState = seen ? seen[i].state : this
        let tr = n < trs.length &&
            plugin.spec.appendTransaction.call(plugin, n ? trs.slice(n) : trs, oldState, newState)
        if (tr && newState.filterTransaction(tr, i)) {
          tr.setMeta("appendedTransaction", rootTr)
          if (!seen) {
            seen = []
            for (let j = 0; j < this.config.plugins.length; j++)
              seen.push(j < i ? {state: newState, n: trs.length} : {state: this, n: 0})
          }
          trs.push(tr)
          newState = newState.applyInner(tr)
          haveNew = true
        }
        if (seen) seen[i] = {state: newState, n: trs.length}
      }
    }
    if (!haveNew) return {state: newState, transactions: trs}
  }
}

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

### Subtleties worth highlighting

1. **`filterTransaction` is total veto.** A single `false` return drops the *entire* transaction silently. `apply` returns the same state and an empty transaction list. Callers that need to know "did this take effect" should use `applyTransaction` and check `transactions.length`, **not** compare states (the state could be `===` even for accepted no-op transactions in theory).

2. **Mismatch guard.** `applyInner` throws `"Applying a mismatched transaction"` if `tr.before !== this.doc`. This catches stale transactions held across a state update.

   > **Ramification.** Transactions cannot be **saved for later** across an apply. Once you call `state.apply(tr)`, both `tr.before` and the `state` it was built from are stale; no other state can consume that same `tr`. If a plugin's `appendTransaction` returns a `tr` it built from `oldState` (the parameter passed in) instead of `newState`, the next `applyInner` will throw because `tr.before` is the old doc, not the new one. Always build appended transactions on `newState.tr`. The same rule means user code that captures `state.tr` for an async callback must re-base on the *current* state when the callback fires (typically by re-running the command or by mapping the intent through `view.state` at dispatch time).

3. **`appendTransaction` fixpoint.** The loop keeps running until **no plugin appends anything in a full pass**. Each plugin only ever sees transactions it has *not* seen before (`seen[i].n` slice). This is critical for termination: a well-behaved plugin returns `null` if its appended transaction would re-trigger itself.

4. **`seen` initialisation is lazy.** It's `null` until the first appended tr is produced. On first append at plugin index `i`:
   - plugins `j < i` are recorded as already having seen all current `trs` (oldState=newState, n=trs.length)
   - plugins `j >= i` (including `i` itself, which is then immediately overwritten) start at oldState=this, n=0
   This means a plugin appearing **after** the first appender re-runs from scratch on the next outer iteration, getting all transactions including the appended one as "new" — exactly what you want.

   **Worked trace.** Plugins `[A, B, C]`, all with `appendTransaction`. User dispatches `rootTr`. The trace below shows the `seen` array at each step:

   ```
   Outer iter 1:
     newState ← applyInner(rootTr); trs = [rootTr]; seen = null
     ─ i=0 (A): seen=null → n=0, oldState=this
                A returns null (no append)        seen still null
     ─ i=1 (B): seen=null → n=0, oldState=this
                B returns trB!                    haveNew = true
                seen = [{newState, n=1}, {this, n=0}, {this, n=0}]   // initialise
                trs = [rootTr, trB];  newState ← applyInner(trB)
                seen[1] = {newState, n=2}                            // self-update
     ─ i=2 (C): seen[2] = {this, n=0}, n=0, oldState=this
                C is run with trs[0..]=[rootTr, trB], oldState=this, newState=newState
                C returns null                    seen[2]={newState, n=2}
   Outer iter 2 (haveNew was true):
     ─ i=0 (A): seen[0] = {newState_after_B, n=1}, n=1, oldState=newState_after_B
                A is run with trs.slice(1)=[trB], oldState=newState_after_B, newState=newState
                A returns trA!                    haveNew = true
                trs = [rootTr, trB, trA];  newState ← applyInner(trA)
                seen[0] = {newState, n=3}
     ─ i=1 (B): seen[1] = {newState_after_B, n=2}, n=2, oldState=newState_after_B
                B is run with trs.slice(2)=[trA], oldState=newState_after_B, newState=newState
                B returns null                    seen[1]={newState, n=3}
     ─ i=2 (C): seen[2] = {newState_after_B, n=2}, n=2, oldState=newState_after_B
                C is run with trs.slice(2)=[trA], oldState=newState_after_B, newState=newState
                C returns null                    seen[2]={newState, n=3}
   Outer iter 3: no plugin appended → exit, return {newState, trs=[rootTr, trB, trA]}
   ```

   Key points illustrated:
   - Each plugin's `oldState` is the state *immediately before its previous successful append's effect* (or the original `this` if it has never appended).
   - Each plugin only sees transactions it hasn't seen before (`trs.slice(seen[i].n)`).
   - The loop terminates as soon as a full pass produces no new transactions — no fairness or priority is enforced beyond array order.

5. **`filterTransaction(tr, i)` in the loop excludes plugin `i`.** A plugin can't filter its own appended transaction. All other plugins still get a chance to veto, in which case the appended tr is silently dropped (note: `seen[i]` is still updated so the plugin won't loop forever on the same un-shippable tr).

6. **`appendedTransaction` meta.** Every appended tr automatically gets `tr.setMeta("appendedTransaction", rootTr)`, letting downstream readers correlate side-effects back to the originating user transaction. The history plugin uses this to keep auto-corrections in the same undo step.

7. **`filterTransaction` does *not* run in a fixpoint.** It runs once on the root tr at entry, and once per appended tr during the loop. There is no "final approval" pass.

---

## 6. `Plugin` and `PluginSpec`

```ts
// plugin.ts:71–89
export class Plugin<PluginState = any> {
  constructor(readonly spec: PluginSpec<PluginState>) {
    if (spec.props) bindProps(spec.props, this, this.props)
    this.key = spec.key ? spec.key.key : createKey("plugin")
  }
  readonly props: EditorProps<Plugin<PluginState>> = {}
  key: string
  getState(state: EditorState): PluginState | undefined { return (state as any)[this.key] }
}
```

### `PluginSpec<PluginState>`

```ts
// plugin.ts:7–45
export interface PluginSpec<PluginState> {
  props?: EditorProps<Plugin<PluginState>>
  state?: StateField<PluginState>
  key?: PluginKey
  view?: (view: EditorView) => PluginView
  filterTransaction?: (tr: Transaction, state: EditorState) => boolean
  appendTransaction?: (transactions: readonly Transaction[],
                       oldState: EditorState,
                       newState: EditorState) => Transaction | null | undefined
  [key: string]: any
}
```

- **`props`** — view-side hooks: `handleDOMEvents`, `handleKeyDown`, `handleTextInput`, `handleClick`, `handleDoubleClick`, `handleTripleClick`, `handlePaste`, `handleDrop`, `handleScrollToSelection`, `decorations(state)`, `nodeViews`, `markViews`, `domParser`, `clipboardParser`, `clipboardSerializer`, `transformPasted`, `transformPastedHTML`, `transformPastedText`, `transformCopied`, `attributes`, `editable`, `clipboardTextSerializer`. (Defined in `prosemirror-view`'s `EditorProps`.)
  Function-valued props are bound to the plugin via `bindProps` so `this === plugin` inside the handler.

  > **Pitfall: arrow-function props don't rebind.** `bindProps` (`plugin.ts:58–67`) calls `val.bind(self)` on each function-valued prop. An arrow function ignores `bind` (its `this` is lexically captured at definition time), so `this` inside an arrow-function prop is **whatever it was at the call site of the `Plugin` constructor**, *not* the plugin instance. If you need `this === plugin` (e.g. to read `this.spec`), write a regular function:
  > ```ts
  > new Plugin({
  >   props: {
  >     handleClick(view, pos, event) {  // ✅ rebound — this === plugin
  >       return this.spec.onClick(view, pos)
  >     },
  >     handleKeyDown: (view, event) => {  // ⚠️ not rebound; `this` is undefined or outer scope
  >       /* … */
  >     }
  >   }
  > })
  > ```
  > In practice, most code captures the plugin/state via closure and never references `this` — both styles "work" then. The footgun appears only when authors deliberately rely on `bindProps`.
- **`state`** — see `StateField` below.
- **`key`** — a `PluginKey` for retrieval. Without one, an auto-generated unique key is used.
- **`view`** — called by `EditorView` once per state-attach; returns `PluginView` with `update(view, prevState)` and/or `destroy()`. Used for imperative DOM work that doesn't fit decorations (tooltips, scroll listeners, etc.). It's destroyed and re-created when the state's plugin set changes.

  See §11 for the full `PluginView` lifecycle (when `update` runs relative to DOM updates, when `destroy` runs, ordering across multiple plugin views).
- **`filterTransaction`** — see §5; veto.
- **`appendTransaction`** — see §5; chained side-effect transactions.
- **Open extension** — the `[key: string]: any` allows arbitrary spec properties readable via `plugin.spec`.

### `StateField<T>`

```ts
// plugin.ts:95–115
export interface StateField<T> {
  init: (config: EditorStateConfig, instance: EditorState) => T
  apply: (tr: Transaction, value: T, oldState: EditorState, newState: EditorState) => T
  toJSON?: (value: T) => any
  fromJSON?: (config: EditorStateConfig, value: any, state: EditorState) => T
}
```

The `apply` signature gives the plugin *both* the old and the partially-built new state. Because fields run in order, `newState` only contains the built-ins and any plugin field that was registered before this one. This is a real ordering constraint when designing dependent plugins — order them in the array so dependencies come first.

---

## 7. `PluginKey` and key collision

```ts
// plugin.ts:117–142
const keys = Object.create(null)
function createKey(name: string) {
  if (name in keys) return name + "$" + ++keys[name]
  keys[name] = 0
  return name + "$"
}

export class PluginKey<PluginState = any> {
  key: string
  constructor(name = "key") { this.key = createKey(name) }
  get(state: EditorState): Plugin<PluginState> | undefined { return state.config.pluginsByKey[this.key] }
  getState(state: EditorState): PluginState | undefined { return (state as any)[this.key] }
}
```

Mechanics:

- `createKey("history")` returns `"history$"` the first time, `"history$1"`, `"history$2"`, … on subsequent calls. The trailing `$` (or `$N`) makes generated keys unforgeable as JS identifiers from user space.
- A `PluginKey` is **module-scoped identity**. Two `new PluginKey("x")` produce *different* underlying strings (`"x$"` vs `"x$1"`). The convention is to export a single shared key from a module:
  ```ts
  export const historyKey = new PluginKey("history")
  ```
- A plugin without a `key` spec gets a unique auto-key via `createKey("plugin")` — `"plugin$"`, `"plugin$1"`, …
- **Collision rule** (`state.ts:53–54`): adding two plugins with the same `key.key` string to one state throws:
  ```
  "Adding different instances of a keyed plugin (<key>)"
  ```
  Same plugin instance twice would also throw because the second insertion would see `pluginsByKey[plugin.key]` already set.

`PluginKey.get(state)` is the standard idiom to retrieve "the plugin of type X currently active". `PluginKey.getState(state)` short-cuts directly to the plugin's stored field value.

### `PluginKey.getState` vs `Plugin.getState` — both exist, identical behaviour

```ts
// plugin.ts:88   (Plugin)
getState(state: EditorState): PluginState | undefined { return (state as any)[this.key] }
// plugin.ts:141  (PluginKey)
getState(state: EditorState): PluginState | undefined { return (state as any)[this.key] }
```

The implementations are identical — both index into `state[<key string>]`. Why have both?

- **`plugin.getState(state)`** — when you already hold the `Plugin` instance (e.g. you're inside its own `appendTransaction`, or you imported the exported singleton).
- **`pluginKey.getState(state)`** — when you don't have the instance, only the *key*. This is the common case across modules: a third-party module exports its `PluginKey` so other modules can read its state without taking a hard dependency on the plugin singleton (which may not even be installed).

The same shape applies to `Plugin.spec.key` ↔ `PluginKey.get(state)`: `key.get(state)` returns the *currently installed* plugin instance with that key (`pluginsByKey[key.key]`), or `undefined` if it isn't installed. This is the safe way to do "use feature X if it's available".

---

## 8. `appendTransaction` patterns

Common uses, all leveraging the fixpoint loop:

1. **Auto-correct / smart-input** — observe user typing, append a transaction that rewrites e.g. `"--"` → `"—"`. Return `null` if the new transactions don't include user typing or if the correction was already applied (the meta channel is the usual guard).
2. **Schema enforcement** — after every change, scan the new doc for invariants (e.g. "every `figure` must end with a `figcaption`") and append a fixing transaction. Use `tr.setMeta(myKey, "fixup")` plus a check at the top of your handler to avoid re-fixing your own fix.
3. **Cross-document sync / RTC** — append a tr that records collaborator-visible meta or selections.
4. **Linked structures** — if doc state A implies derived state B in another node (e.g. table of contents), update B in `appendTransaction` so the user's tr and the derivation are atomic from outside.

Termination guard pattern:
```ts
appendTransaction(trs, oldState, newState) {
  if (trs.some(tr => tr.getMeta(myKey))) return null
  ...
  return tr.setMeta(myKey, true)
}
```

### Worked example — autocorrect that fires but terminates

A `--` → `—` (em-dash) autocorrect plugin. The challenge: after we append a tr to do the substitution, the fixpoint loop runs us *again* on the appended tr. Without a guard, we'd loop forever (the appended tr's text would be checked, no `--` remains, return null — fine in this trivial case, but a less precise check could keep matching the cursor neighbourhood).

```ts
const autocorrectKey = new PluginKey("autocorrect")

const autocorrect = new Plugin({
  key: autocorrectKey,
  appendTransaction(trs, oldState, newState) {
    // Guard: don't react to our own work
    if (trs.some(tr => tr.getMeta(autocorrectKey))) return null
    // Only fire when content actually changed
    if (!trs.some(tr => tr.docChanged)) return null

    // Look at the cursor neighbourhood of the *new* state
    const sel = newState.selection
    if (!(sel instanceof TextSelection) || !sel.$cursor) return null
    const $cursor = sel.$cursor
    const before = $cursor.parent.textBetween(
      Math.max(0, $cursor.parentOffset - 2),
      $cursor.parentOffset
    )
    if (before !== "--") return null

    const tr = newState.tr
      .delete($cursor.pos - 2, $cursor.pos)
      .insertText("—")
      .setMeta(autocorrectKey, true)        // termination guard
      .setMeta("addToHistory", false)        // group with the user's tr in undo
    return tr
  }
})
```

**Iteration 1** (user typed the second `-`):
- `trs = [rootTr]`, none have `autocorrectKey` meta → guard passes.
- `rootTr.docChanged === true` → continue.
- We check, see `--`, return our autocorrect tr stamped with `autocorrectKey`.
- Outer loop applies it, `haveNew = true`, runs the loop again.

**Iteration 2** (we're inspecting our own appended tr):
- `trs.slice(seen[i].n)` is `[autocorrectTr]`.
- `autocorrectTr.getMeta(autocorrectKey) === true` → `trs.some(...)` is true → **return null.**
- No other plugin appends → outer loop exits.

Result: the user typed `-`, ProseMirror saw `--`, and the editor ends with `—` and a single composite undo entry. Even if our condition check were imperfect (e.g. matched empty input), the meta guard prevents re-firing.

**Common variations of the guard:**
- `tr.setMeta("addToHistory", false)` to keep the appended tr from being a separate undo step.
- Checking `oldState` against `newState` to skip when nothing semantically interesting changed.
- Using a per-document version counter in plugin state to bail when an external sync has invalidated the assumption.

---

## 9. Order of plugin execution and props lookup

Within a single state:

- **`config.plugins`** is the ordered array of all installed plugins (`state.ts:46`).
- **State field `apply`** runs in `config.fields` order: built-ins first, then plugins in array order (`state.ts:174–177`).
- **`filterTransaction`** runs over plugins in array order; first `false` short-circuits (`state.ts:124–129`).
- **`appendTransaction`** runs over plugins in array order; the *outer* loop is the fixpoint over the whole array (`state.ts:144–167`).
- **Props lookup** (defined in `prosemirror-view`, but the rule originates from how `state.plugins` is iterated): the view scans `state.plugins` in order, picking the *first* plugin whose `props.<name>` is defined and (for handler-style props) returns `true`. So **earlier plugins in the array win**.
  - For accumulator-style props (e.g. `decorations`, `nodeViews`, `markViews`, `attributes`), the view *combines* across plugins instead of short-circuiting. Decorations from all plugins are unioned; nodeViews from earlier plugins shadow later ones for the same node type.

### `EditorView.someProp(propName, f?)` — the canonical iterator

```ts
// prosemirror-view/src/index.ts:294–314
someProp<P extends keyof EditorProps, R>(propName: P, f: (value: NonNullable<EditorProps[P]>) => R): R | undefined
someProp<P extends keyof EditorProps>(propName: P): NonNullable<EditorProps[P]> | undefined
someProp(propName, f?) {
  let prop = this._props && this._props[propName], value
  if (prop != null && (value = f ? f(prop) : prop)) return value
  for (let i = 0; i < this.directPlugins.length; i++) {
    let prop = this.directPlugins[i].props[propName]
    if (prop != null && (value = f ? f(prop) : prop)) return value
  }
  let plugins = this.state.plugins
  if (plugins) for (let i = 0; i < plugins.length; i++) {
    let prop = plugins[i].props[propName]
    if (prop != null && (value = f ? f(prop) : prop)) return value
  }
}
```

Semantics:

- Iterates props in order: **direct view props** (`new EditorView(dom, { ...props, state })`), then **direct plugins** (passed via `EditorView` config, not via state), then **state plugins** (`state.plugins`) in array order.
- If `f` is provided, it's applied to each defined prop value; the first **truthy** result is returned. So for handler props (which return `true`/`false`), `someProp("handleKeyDown", f => f(view, event))` short-circuits at the first plugin that handles the event.
- If `f` is omitted, returns the first non-`undefined` prop value as-is — used to pick the first plugin's `domParser`, `clipboardSerializer`, etc.
- Returns `undefined` if no plugin produces a truthy result.

This is the engine of the priority rule above: handler props are *winner-take-all*, accumulator props each have their own loops elsewhere in the view that don't short-circuit.

### Plugin.props — accumulator vs handler props

| Prop name | Kind | Aggregation | Iterator |
|---|---|---|---|
| `handleDOMEvents` | handler (per event-name) | First truthy wins | `someProp` (per event) |
| `handleKeyDown`, `handleKeyPress`, `handleTextInput` | handler | First truthy wins | `someProp` |
| `handleClick`, `handleDoubleClick`, `handleTripleClick` | handler | First truthy wins | `someProp` |
| `handlePaste`, `handleDrop` | handler | First truthy wins | `someProp` |
| `handleScrollToSelection` | handler | First truthy wins | `someProp` |
| `decorations(state)` | accumulator | Union of all `DecorationSet`s | dedicated loop in `viewDecorations` |
| `nodeViews` | accumulator (by node type name) | First plugin defining the type wins; later ones ignored | dedicated loop |
| `markViews` | accumulator (by mark type name) | First plugin defining the type wins | dedicated loop |
| `attributes` | accumulator | Object-merge across plugins (later overwrites earlier) | dedicated loop |
| `editable(state)` | handler | All must return `true` (default `true`); single `false` makes editor read-only | dedicated `editable()` |
| `domParser`, `clipboardParser`, `clipboardSerializer`, `clipboardTextSerializer` | scalar | First defined wins | `someProp` (no `f`) |
| `transformPasted`, `transformPastedHTML`, `transformPastedText`, `transformCopied` | pipeline | All applied in order, output of one feeds the next | dedicated chain in clipboard code |

The mental model: **handlers are filters in a priority chain**, **accumulators are unioned**, **transforms are pipelines**. The plugin array order is the priority/pipeline order in every case.

> Cross-ref: `prosemirror-view` exposes `EditorView.someProp(propName, f?)` (see signature above). In older docs this was sometimes called `somePropsSorted`, but the modern API is just `someProp`, which iterates `[directProps, ...directPlugins.props, ...state.plugins.props]`. There is no separate sort step — *the plugin array order IS the priority order*.

---

## 10. Meta channel: cross-plugin communication

The meta dict on a transaction is the only sanctioned way for plugins to exchange information without sharing global mutable state.

Patterns:

```ts
// Sender
tr.setMeta(uploadPluginKey, { type: "start", id })

// Receiver, in its StateField.apply:
apply(tr, value) {
  const m = tr.getMeta(uploadPluginKey)
  if (m && m.type === "start") return { ...value, pending: [...value.pending, m.id] }
  return value
}
```

Conventions:

- Always key by `PluginKey` (or the plugin instance), never by string, unless you intentionally want a *public* channel that other modules can target without depending on your key.
- Built-in / convention string keys you may see on transactions:

  | Meta key | Set by | Read by | Meaning |
  |---|---|---|---|
  | `"pointer"` | `prosemirror-view` (mouse/touch handlers) | history, focus tracking | This selection change came from a pointer; don't treat as typing for undo/coalescing. |
  | `"composition"` | `prosemirror-view` IME path | history, dropcursor | Tagged with a composition id; transactions inside one IME composition share an id. |
  | `"uiEvent"` | `prosemirror-view` | history, custom plugins | One of `"paste" \| "cut" \| "drop"`; coarse classification of the user gesture. |
  | `"appendedTransaction"` | `state.applyTransaction` (auto, `state.ts:159`) | history, downstream observers | The root tr that triggered this appended tr; lets observers correlate cause and effect. |
  | `"addToHistory"` | application code | `prosemirror-history` | `false` to opt this tr out of undo (e.g. autocorrects, collab remote ops); omit/`true` to include. |
  | `"clearStoredMarks"` | application code | `prosemirror-history` (and similar) | Hint to drop pending stored marks even when other heuristics would keep them. |

  All of these are *string* keys — readable across modules without sharing an instance — by deliberate convention.
- Meta is **not** mapped, **not** persisted, **not** part of state JSON. It exists only for the duration of the transaction.
- `tr.isGeneric` (`transaction.ts:199–202`) — true iff `meta` is empty. History uses this to decide whether to coalesce with a neighbour.

---

## 11. View consumption (forward link)

`prosemirror-view`'s `EditorView`:
- holds `state: EditorState`
- exposes `dispatch(tr)` that calls `view.updateState(state.apply(tr))` (or its own dispatch override)
- diffs the new state against the previous and updates the DOM, re-running `decorations` / `nodeViews` props
- watches `state.scrollToSelection` to know when to scroll
- uses `state.selection` to drive the browser selection (covered in `08-selection.md` §11 and the upcoming `09-view-and-dom.md`).

### `PluginView` lifecycle in detail

```ts
// Shape of what spec.view returns:
interface PluginView {
  update?(view: EditorView, prevState: EditorState): void
  destroy?(): void
}
```

Lifecycle events (from `prosemirror-view`'s `pluginViews` machinery):

1. **Construction** — `spec.view(view)` is called once when the `EditorView` is created (or when the state's plugin list changes such that this plugin is newly present). The returned `PluginView` is stored in the view's internal `pluginViews` array.
2. **`update(view, prevState)`** — called *after* every state change, *after* the DOM has been updated. The order is:
   - `view.updateState(newState)` is called.
   - The view computes diffs and applies DOM changes (`viewDesc` updates, decorations, nodeViews).
   - The browser selection is synced (or `forceUpdate`-ed during composition).
   - Then each `pluginView.update` is invoked in plugin-array order, with `(view, prevState)` where `prevState` is the state *before* this update.

   Plugin views can inspect `view.state` (the new state) and read DOM measurements safely — the DOM is in sync at this point. They typically do imperative work that doesn't fit into decorations: positioning a tooltip from layout, attaching/detaching event listeners, reflecting state into a sidebar, etc.
3. **`destroy()`** — called when the plugin is being removed. Two triggers:
   - `view.destroy()` — every plugin view's `destroy` runs.
   - The state was reconfigured to a plugin set that no longer contains this plugin — the specific plugin view's `destroy` runs, and the others are unaffected.

   **The plugin instance is not re-used.** If the same plugin is later added back via another `reconfigure`, `spec.view(view)` is called again, producing a *new* `PluginView`. There is no "pause/resume" — destroy is final.
4. **Plugin-array reorder** — if `reconfigure` keeps the same plugin set but in a different order, every plugin view is destroyed and rebuilt (because the view tracks them positionally; the safe option is to throw them all away).

> **What this means for plugin authors.** `update` is the right place to read DOM layout (it runs post-DOM-sync). Don't dispatch transactions from `update` synchronously without a guard — you'll re-enter the view's update path. If you need to dispatch in response to layout, use `requestAnimationFrame` or set a "pending" flag in plugin state and dispatch from a deferred callback.

Plugin `view(view) => PluginView` returns are tracked by the `EditorView` and have their `update(view, prevState)` called after every state change; `destroy()` runs on un-installation or view destruction. They are the imperative escape hatch when neither decorations nor handlers are sufficient.

---

## TL;DR cheat sheet

| Thing | Where | One-liner |
|---|---|---|
| Persistent state | `state.ts:90` | `EditorState` is a record; never mutate. |
| Field registry | `state.ts:21–61` | `Configuration.fields` = base + plugin state fields. |
| Apply | `state.ts:118–168` | `filter` → `applyInner` → `appendTransaction` fixpoint. |
| Tr lifecycle | `transaction.ts:42–215` | `Transform` + selection + storedMarks + scroll + meta. |
| Plugin retrieval | `plugin.ts:129–142` | `PluginKey.get(state)`, `key.getState(state)`. |
| Cross-plugin signal | `transaction.ts:187–195` | `tr.setMeta(key, v)` / `tr.getMeta(key)`. |
| Veto | `state.ts:123–130` | `filterTransaction` returns `false`. |
| Side-effect chain | `state.ts:144–167` | `appendTransaction` fixpoint, excludes self in filter. |
| Reconfigure | `state.ts:199–210` | Keeps fields by name; `init`s only the new ones. |
