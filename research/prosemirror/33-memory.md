# 33 — Memory Management

Companion to [26-performance.md](./26-performance.md). Where 26 covers
*time*, this file covers *space*: when nodes/views/decorations are
allocated, when they become unreachable, what stays alive across a
typing session, and the leak-shaped traps that real PM apps fall into.

> Mental model. PM is *immutable*. Every transaction allocates new
> `Node`/`Fragment`/`Mapping`/`EditorState` instances. Old instances
> become garbage *iff* nothing else holds a reference. Most "memory
> leaks" in PM editors are a plugin or NodeView holding the old state
> alive on purpose (`history`) or by accident (closure capture).

---

## A. The lifecycles, in one table

| Object              | Allocated by                                      | Freed when                                                              |
|---------------------|---------------------------------------------------|--------------------------------------------------------------------------|
| `Node` / `Fragment` | every `Step.apply` that touches its subtree       | no path from a live `EditorState` references it (history pins old docs)  |
| `Mark` / `Attrs`    | shared aggressively across docs                   | last `Node` referencing it is freed                                      |
| `EditorState`       | every `state.apply(tr)`                           | the next `view.updateState` *and* nothing else holds it                  |
| `Transaction`       | `state.tr` + every `tr.step()`                    | after `dispatch` returns; usually one tick                               |
| `Mapping` / `StepMap` | every transform + history rebase                | with their owning state/branch                                          |
| `EditorView`        | `new EditorView(...)`                             | `view.destroy()` is called (manual)                                     |
| `ViewDesc` / `NodeViewDesc` / `MarkViewDesc` | reconciler in `docView.update` | replaced by reconciler, OR `docView.destroy()` recursively                |
| Custom NodeView     | `nodeViews[type](node, view, getPos)`             | `destroy()` invoked by ViewDesc tree (`prosemirror-view/src/viewdesc.ts:657`) |
| `DecorationSet`     | plugin's `decorations` prop or explicit `create`  | with the plugin state slot that owns it                                 |
| `Decoration` (spec) | application code                                  | last `DecorationSet` referencing it is freed                            |
| Plugin state value  | `StateField.init` or `StateField.apply`           | replaced on next transaction (or `view.destroy`)                        |

Two non-obvious entries are worth emphasising:

- **Old `EditorState`s are not freed automatically.** History (§B), undo
  bookmarks, async fetches that captured `state` in a closure, devtools,
  and your own plugin views can all pin a stale state forever. The state
  graph is intentionally garbage-collectable, but only if you don't
  capture it.
- **`docView` is *replaced*, not mutated.** The reconciler builds a new
  ViewDesc subtree where the doc differs and reuses the rest by
  reference. Old subtrees become unreachable and are GC'd in the next
  cycle. Your *NodeView's* `destroy()` is the only callback you get
  (`viewdesc.ts:657`) — use it.

---

## B. History rope: linear in depth × avg-step-cost

`prosemirror-history` keeps two `Branch`es (undo + redo) of `Item`s, each
holding the inverted step + its `Mapping` + an optional `SelectionBookmark`
(`prosemirror-history/src/history.ts:24` for `Branch`, `:220` for `Item`).
Items live in a `RopeSequence` for O(log n) append/split.

The retained-bytes formula:

```
history_bytes ≈ depth × (avg_inverted_step_size + avg_mapping_size + avg_bookmark_size)
            ≈ depth × ~200–800 bytes per item (typing) … several KB (paste)
```

Default `depth` is **100** (`history.ts:392`):

```ts
config = {depth: config.depth || 100,
          newGroupDelay: config.newGroupDelay || 500};
```

Empirically, for a typing-heavy workload:

- Each typing item is ~200 bytes (one-character `ReplaceStep`, its
  inverse, a small mapping, a `TextSelection` bookmark).
- A paste of 10KB of HTML can push a single item to ~30KB.

So a 100-deep history of typing is ~20KB, but a 100-deep history that
includes a few large pastes is ~300KB. The history *also* holds, via
the inverted steps' `Slice`s, references to the old document fragments,
which is how undo restores them — those fragments cannot be GC'd.

### B.1 Tuning `depth`

```ts
import { history } from "prosemirror-history";
const plugin = history({ depth: 50, newGroupDelay: 500 });
```

Pick `depth` based on UX, not memory: 50 is the floor for "feels
unlimited" on a normal session, 100 is the default, 200+ is rare. If
your users paste massive blobs, lower `depth` rather than raising it —
each item can dominate.

### B.2 Closing history groups

`closeHistory(tr)` finalises the current undo group early so the next
transaction starts a fresh one. This doesn't free memory, but it keeps
group sizes bounded — a single group holding 30 minutes of typing can
balloon if the user never blurs/refocuses (the default `newGroupDelay`
of 500 ms saves you from this in practice).

---

## C. Plugin state retention across `state.apply`

Every transaction produces a new `EditorState`. Each plugin's state slot
is the value its `StateField.apply(tr, prev, oldState, newState)` returned.
Two key invariants:

1. **Returning `prev` keeps the *same reference* in the new state slot.**
   This is structural sharing: the new `EditorState` and the old one
   share that slot, so the slot's value is not double-counted in heap
   profiles.
2. **Returning a *new object that's deep-equal to `prev`* allocates a
   new object.** GC will eventually collect the old one when the old
   `EditorState` is no longer referenced — but in the meantime you have
   two copies on the heap.

The right pattern is the same as in [26 §F](./26-performance.md):

```ts
apply(tr, prev) {
  if (!tr.docChanged) return prev; // <-- structural sharing
  return recomputeFromDoc(tr.doc, prev);
}
```

Plugin state values are *not* WeakMap-keyed by transaction; they live as
long as the `EditorState` that owns them. If your plugin state is large
(say, a search index of the whole doc), and someone keeps a reference
to an old `EditorState`, your search index is pinned too. See §E for
the closure-capture trap that makes this happen.

---

## D. `view.destroy()` cleanup checklist

`EditorView.destroy()` (`prosemirror-view/src/index.ts:460`) is the
*only* cleanup point — there is no implicit teardown. The implementation:

```ts
destroy() {
  if (!this.docView) return;
  destroyInput(this);                 // removes DOM event listeners
  this.destroyPluginViews();          // calls each plugin view's destroy()
  if (this.mounted) {
    this.docView.update(this.state.doc, [], viewDecorations(this), this);
    this.dom.textContent = "";
  } else if (this.dom.parentNode) {
    this.dom.parentNode.removeChild(this.dom);
  }
  this.docView.destroy();             // recursively destroys ViewDesc tree
  (this as any).docView = null;
  clearReusedRange();
}
```

What `destroy` does for you:

- ✅ Removes every DOM event listener PM registered (`destroyInput`).
- ✅ Disconnects the `MutationObserver` (inside `destroyInput` →
  `DOMObserver.stop()`).
- ✅ Calls every plugin view's `destroy()`
  (`prosemirror-view/src/index.ts:252`).
- ✅ Recursively calls every NodeView's `destroy()`
  (`viewdesc.ts:180` for inner descs, `:657` for custom NodeView wrapping).
- ✅ Empties or detaches the editor's root DOM node.
- ✅ Sets `this.docView = null` so `view.isDestroyed` becomes `true`
  (`index.ts:478`).

What it does *not* do:

- ❌ Cancel in-flight `fetch`/`scheduler.postTask` calls your plugins
  started. You must do this in your plugin view's `destroy`.
- ❌ Free the last `EditorState`. If you held onto `view.state` outside
  the view, that reference is yours to clear.
- ❌ Free your nodeView's `IntersectionObserver`/`ResizeObserver`/etc.
  unless you call `disconnect()` in your `destroy`.

### D.1 Destruction call order matters

Plugin views are destroyed *before* the docView is torn down
(`index.ts:252` runs before the docView teardown at `:470`). This means
inside a plugin view's `destroy`, `view.state` and `view.docView` are
still valid. Inside a NodeView's `destroy`, `view.docView` may be partly
detached — don't dispatch transactions from there.

---

## E. NodeView dispose contract

The `NodeView.destroy?: () => void` hook
(`prosemirror-view/src/viewdesc.ts:90`, `:116`) is the **one** chance
your custom view gets to clean up. It's invoked from
`CustomNodeViewDesc.destroy()` (`viewdesc.ts:657`):

```ts
destroy() {
  if (this.spec.destroy) this.spec.destroy();
  super.destroy();
}
```

…where `super.destroy()` recurses into children
(`viewdesc.ts:180-187`). It is called when:

- The NodeView's underlying `Node` is replaced and the reconciler can't
  reuse the descriptor (different type, different attrs that fail the
  NodeView's `update`).
- The NodeView's `update` returns `false` (forces rebuild).
- The whole editor is being destroyed (`view.destroy()`).
- The NodeView's parent is removed.

What you *must* clean up here:

```ts
destroy() {
  this.io?.disconnect();           // IntersectionObserver
  this.ro?.disconnect();           // ResizeObserver
  this.mo?.disconnect();           // any extra MutationObserver
  this.abort?.abort();             // AbortController for in-flight fetches
  this.timer && clearTimeout(this.timer);
  this.raf && cancelAnimationFrame(this.raf);
  this.subscriptions?.forEach((u) => u()); // any pubsub
}
```

Anything you forget to disconnect here lives until the page navigates.
Across editor open/close cycles in a SPA, `IntersectionObserver`s in
particular accumulate quickly — ten per editor × ten editor sessions =
100 observers each holding a reference to a dead DOM subtree.

---

## F. Closure leaks via plugin views

The single most common PM memory leak: a plugin view that schedules
async work and captures the *initial* `view` and `state` in the closure.

```ts
// LEAK
view(view) {
  return {
    update(view) {
      setTimeout(() => {
        // captures initial `view` and uses `view.state`, which has been replaced
        // 1000 times since the timeout was scheduled. Old states are pinned.
        save(view.state.doc.toJSON());
      }, 30000);
    },
  };
}
```

Two problems: (1) the `setTimeout` is never cancelled on `destroy`, so
it can fire after the editor is gone, and (2) by capturing `view.state`,
you keep a chain of `EditorState`s alive while the timer pends.

The correct version:

```ts
view(view) {
  let timer: number | null = null;
  return {
    update(view) {
      if (timer != null) clearTimeout(timer);
      timer = window.setTimeout(() => {
        save(view.state.doc.toJSON()); // reads current state, not captured.
        timer = null;
      }, 30000);
    },
    destroy() {
      if (timer != null) clearTimeout(timer);
    },
  };
}
```

`setInterval`, `requestAnimationFrame`, `requestIdleCallback`, custom
event-bus subscriptions — all the same pattern: keep a handle, cancel
on `destroy`.

---

## G. Decoration spec retention

Decoration `spec` objects passed to `Decoration.widget(pos, dom, spec)`,
`Decoration.inline(from, to, attrs, spec)`, and `Decoration.node(...)`
are stored *by reference* on the resulting `Decoration` and live as long
as the `DecorationSet` that contains it.

Two consequences:

- **Don't mutate spec objects.** PM's `decoration.ts` compares specs by
  identity for some shortcuts (e.g., widget reuse,
  `viewdesc.ts:560`). A mutated spec breaks reconciliation.
- **Don't put large objects in `spec`.** Specs are retained one-per-
  decoration. Storing a closure that captures a few MB of analysis
  results, multiplied by 1000 decorations, costs you that × 1000.
  Store the heavy data in a side `Map<id, payload>` keyed by a small
  id, and put just the id on the spec.

When a decoration is mapped through a transaction
(`DecorationSet.map`), a new `Decoration` is allocated but it shares
the *same* spec reference. So spec retention is ~1 copy per logical
decoration, not 1 per transaction.

---

## H. WeakMap usage in `prosemirror-model`

The most important `WeakMap` in PM is `resolveCache`
(`prosemirror-model/src/resolvedpos.ts:257`):

```ts
const resolveCacheSize = 12, resolveCache = new WeakMap<Node, ResolveCache>();
```

It's keyed by `Node` identity. When a `Node` becomes unreachable, its
cache entry is collected automatically — no leak risk. Each entry is a
`ResolveCache { elts: ResolvedPos[12], i }` ([26 §J](./26-performance.md)),
about 12 × 80 bytes = ~1KB per cached doc.

Note: PM's `resolveCache` is *not* a per-doc WeakMap of size 1; it's a
per-doc *bucket* of 12 ring-buffered resolves. The `Node`s themselves
are the keys; the buckets are the values. So even a doc that lives a
long time has at most 12 cached `ResolvedPos`es pinned by the cache.

There are no per-state or per-view weak maps you need to think about
in `prosemirror-model`. `prosemirror-view` does use a `WeakMap<Node, ViewDesc>`
internally for ViewDesc lookup, but it is bound to the docView and goes
away with it.

---

## I. Memory profile of a typical editor

Approximate memory footprint of a single PM editor on a 50KB document
(~200 paragraphs, mixed inline marks, no NodeViews, default schema-basic):

| Component                                               | At rest | After 10000 keystrokes |
|---------------------------------------------------------|---------|------------------------|
| `EditorState.doc` (current `Node` tree)                | ~300 KB | ~300 KB                |
| `Mark`/`Attrs` (shared, schema-bound)                   | ~5 KB   | ~5 KB                  |
| `EditorState.plugins[*].state` (history excluded)       | ~50 KB  | ~80 KB (selection bookmarks accumulate) |
| `prosemirror-history` rope (depth=100)                  | ~30 KB  | ~30 KB (oldest items dropped) |
| `docView` ViewDesc tree (~3× DOM size)                  | ~600 KB | ~600 KB                |
| Decoration sets (e.g., syntax highlight on whole doc)   | ~150 KB | ~150 KB                |
| Browser DOM (the visible <p>, <strong>, …)              | ~400 KB | ~400 KB                |
| Total retained (heap snapshot, "Retained Size")         | ~1.6 MB | ~1.7 MB                |

Take-aways:

- The doc, history, and ViewDesc tree dominate. Each is in the same
  order of magnitude — none is a dragon.
- 10000 keystrokes do **not** linearly grow heap, because old
  `EditorState`s are GC'd as new ones replace them. The +100KB
  difference is mostly history group churn.
- If your editor's heap grows monotonically while typing, you have a
  closure leak (§F) or a plugin that accumulates without compaction.

### I.1 Diagnosing a leak

In Chrome DevTools Memory panel:

1. Take a heap snapshot at editor mount.
2. Type for a minute.
3. Take a second snapshot, filter by `EditorState`.
4. If you see >2 retained `EditorState` instances, find the retainer
   path. The culprit is almost always a plugin view's
   `setTimeout`/Promise capturing `view.state` (§F).

---

## J. History depth limits — guidance

The default `depth: 100` (`prosemirror-history/src/history.ts:392`) is
chosen for *interactive editing on a typical document*. Tune it as
follows:

- **Constrained device / mobile:** `depth: 50`. Halves history memory at
  little UX cost (50 undos is well past what users actually use).
- **Default desktop editor:** keep `depth: 100`.
- **Long-form writing app where users undo aggressively:** `depth: 200`.
  Memory cost is bounded as long as paste sizes are reasonable.
- **Collaborative editor:** `depth: 100` is fine, *but* note that
  history is local-only — collab steps from peers do *not* fill your
  undo history (`prosemirror-history` filters via the `addToHistory`
  meta).

There's also `newGroupDelay` (default 500 ms) controlling when typing
opens a new undo group. Lower values create more small groups (cheaper
per group but more total items); higher values create fewer big groups
(coarser undo granularity). 500 ms is well-chosen — only change it if
you have a UX reason.

### J.1 Compression

`Branch.compress` (`prosemirror-history/src/history.ts:179`) is invoked
when the rope grows past a threshold and merges adjacent items. This
keeps the rope size bounded even under unusual usage patterns. You
shouldn't need to think about it; it's why `Branch.addTransform` is
O(1) amortized despite the rope-of-items model
([20 §1.4, §1.9](./20-history-and-collab.md)).

---

## K. Practical leak-hunting checklist

1. **Always pair `new EditorView` with a `view.destroy()`** in the
   un-mount path of your component. React: `useEffect` return.
   Vue: `onUnmounted`. Svelte: `onDestroy`.
2. **Every plugin view that schedules async work owns a `destroy`.**
   Cancel timers, observers, fetches, subscriptions.
3. **Every custom NodeView with observers/subscriptions owns a `destroy`.**
   `IntersectionObserver`/`ResizeObserver` are the most common
   forgotten ones.
4. **Don't capture `view.state` in long-lived closures.** Read it fresh
   from `view.state` at fire time.
5. **Don't mutate decoration `spec` objects.** Allocate new ones.
6. **Don't store large payloads on decoration specs.** Use a side map
   keyed by id.
7. **Don't keep a `view` reference in module scope.** It survives HMR
   reloads and accumulates dead editors.
8. **Tune `history({ depth })` for your worst-case paste size**, not
   your average.

If you do all eight, a PM editor will hold a flat ~1.5–2 MB on a
medium document for the lifetime of a session, regardless of how much
the user types.
