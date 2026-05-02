# 07 — `EditorState`, `Transaction`, and the Plugin System

> Source: `prosemirror-state/src/{state,plugin,transaction}.ts`
> Cross-ref: `prosemirror-view` (consumes state via `EditorView.updateState`) and `prosemirror-model` (provides `Node`, `Mark`, `Schema`).

This file covers the persistent `EditorState` data structure, how transactions mutate it functionally, and the plugin pipeline that runs on every `apply`. Selection mechanics live in `08-selection.md`.

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

`scrollToSelection` is a monotonically increasing counter — the view watches for changes to it to know when to scroll (`prosemirror-view` reads `state.scrollToSelection !== prev.scrollToSelection`). The `storedMarks` apply is subtle: marks are dropped unless the selection is a *cursor* (collapsed `TextSelection`).

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

### `toJSON` / `fromJSON`

`toJSON` (`state.ts:217–227`) serialises `doc`, `selection`, optionally `storedMarks`, and any plugin fields whose key you map via the `pluginFields` argument and whose `StateField.toJSON` is defined. `fromJSON` (`state.ts:234–265`) is symmetric and supports plugin field deserialisation through `StateField.fromJSON`.

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
- `setSelection` requires the selection to be resolved against `tr.doc` (i.e. the current in-progress doc). It clears stored marks and sets the `UPDATED_SEL` bit.
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

These delegate to the polymorphic `selection.replace` / `selection.replaceWith` (see file 08), so e.g. `AllSelection.replace` behaves correctly even when `Slice.empty` is passed.

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

2. **Mismatch guard.** `applyInner` throws "Applying a mismatched transaction" if `tr.before !== this.doc`. This catches stale transactions held across a state update.

3. **`appendTransaction` fixpoint.** The loop keeps running until **no plugin appends anything in a full pass**. Each plugin only ever sees transactions it has *not* seen before (`seen[i].n` slice). This is critical for termination: a well-behaved plugin returns `null` if its appended transaction would re-trigger itself.

4. **`seen` initialisation is lazy.** It's `null` until the first appended tr is produced. On first append at plugin index `i`:
   - plugins `j < i` are recorded as already having seen all current `trs` (oldState=newState, n=trs.length)
   - plugins `j >= i` (including `i` itself, which is then immediately overwritten) start at oldState=this, n=0
   This means a plugin appearing **after** the first appender re-runs from scratch on the next outer iteration, getting all transactions including the appended one as "new" — exactly what you want.

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
- **`state`** — see `StateField` below.
- **`key`** — a `PluginKey` for retrieval. Without one, an auto-generated unique key is used.
- **`view`** — called by `EditorView` once per state-attach; returns `PluginView` with `update(view, prevState)` and/or `destroy()`. Used for imperative DOM work that doesn't fit decorations (tooltips, scroll listeners, etc.). It's destroyed and re-created when the state's plugin set changes.
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

---

## 9. Order of plugin execution and props lookup

Within a single state:

- **`config.plugins`** is the ordered array of all installed plugins (`state.ts:46`).
- **State field `apply`** runs in `config.fields` order: built-ins first, then plugins in array order (`state.ts:174–177`).
- **`filterTransaction`** runs over plugins in array order; first `false` short-circuits (`state.ts:124–129`).
- **`appendTransaction`** runs over plugins in array order; the *outer* loop is the fixpoint over the whole array (`state.ts:144–167`).
- **Props lookup** (defined in `prosemirror-view`, but the rule originates from how `state.plugins` is iterated): the view scans `state.plugins` in order, picking the *first* plugin whose `props.<name>` is defined and (for handler-style props) returns `true`. So **earlier plugins in the array win**.
  - For accumulator-style props (e.g. `decorations`, `nodeViews`, `markViews`, `attributes`), the view *combines* across plugins instead of short-circuiting. Decorations from all plugins are unioned; nodeViews from earlier plugins shadow later ones for the same node type.

> Cross-ref: `prosemirror-view` exposes `EditorView.someProp(propName, f?)` as the canonical iterator. In older docs this was sometimes called `somePropsSorted`, but the modern API is just `someProp`, which iterates `[directProps, ...plugin props in plugin-array order]`. There is no separate sort step — *the plugin array order IS the priority order*.

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
- Built-in public string keys used by the view: `"pointer"`, `"composition"`, `"uiEvent"`, `"appendedTransaction"`, `"addToHistory"` (used by `prosemirror-history` to opt a tr in/out of undo).
- Meta is **not** mapped, **not** persisted, **not** part of state JSON. It exists only for the duration of the transaction.
- `tr.isGeneric` (`transaction.ts:199–202`) — true iff `meta` is empty. History uses this to decide whether to coalesce with a neighbour.

---

## 11. View consumption (forward link)

`prosemirror-view`'s `EditorView`:
- holds `state: EditorState`
- exposes `dispatch(tr)` that calls `view.updateState(state.apply(tr))` (or its own dispatch override)
- diffs the new state against the previous and updates the DOM, re-running `decorations` / `nodeViews` props
- watches `state.scrollToSelection` to know when to scroll
- uses `state.selection` to drive the browser selection (covered in `08-selection.md` and the upcoming `09-view-and-dom.md`).

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
