# 26 — Operational Performance Guide

This is the *operational* companion to [21 §G](./21-rendering-pipeline-end-to-end.md)'s
asymptotic table. Where 21 §G tells you the Big-O of each layer, this file
tells you how to *measure* a real session, where the hot paths live in
practice, and how to keep a typing loop under one frame on a 60Hz display.

> Frame budget reminder. 60fps = **16.7 ms / frame**. PM aims for the entire
> `dispatch → state.apply → view.update → DOM commit` round-trip to fit in
> a single frame on a typing keystroke (the main thread is blocked between
> `keydown` and `beforeinput` on most browsers, so anything over ~10 ms is
> visibly janky). The measurements below assume that as the target.

---

## A. Profiling a typing session in Chrome DevTools

### A.1 The minimal tracing harness

PM has no built-in tracing. You wrap `dispatchTransaction` and inject
`performance.mark`/`performance.measure` spans yourself. The pattern below
gives you four spans per keystroke that you can read out of the Performance
panel as a flame chart.

```ts
// Wrap the view's dispatch so every transaction is bracketed.
const view = new EditorView(mount, {
  state,
  dispatchTransaction(tr) {
    performance.mark("pm:apply:start");
    const next = view.state.apply(tr);
    performance.mark("pm:apply:end");
    performance.measure("pm:state.apply", "pm:apply:start", "pm:apply:end");

    performance.mark("pm:update:start");
    view.updateState(next);
    performance.mark("pm:update:end");
    performance.measure("pm:view.update", "pm:update:start", "pm:update:end");
  },
});
```

To also see the `domchange` half of the loop (DOM → doc), patch
`DOMObserver.flush`. It is not exported, so the easiest hook is monkey-
patching `view.domObserver.flush` after construction:

```ts
const obs = (view as any).domObserver;
const realFlush = obs.flush.bind(obs);
obs.flush = () => {
  performance.mark("pm:domchange:start");
  realFlush();
  performance.mark("pm:domchange:end");
  performance.measure("pm:domchange", "pm:domchange:start", "pm:domchange:end");
};
```

The four spans you should see for every keystroke, in order:

1. `pm:domchange` — covers `MutationObserver` flush, `parseBetween`, diff,
   and the synthetic `tr.insertText` ([15 §3–§5](./15-domobserver-and-domchange.md)).
2. `pm:state.apply` — `state.apply(tr)` — every plugin field's `apply`,
   plus the `appendTransaction` fixed-point loop
   (`prosemirror-state/src/state.ts:148`).
3. `pm:view.update` — `EditorView.updateState` → `docView.update` reconcile
   ([09 §3](./09-view-and-viewdesc.md)).
4. (Browser commit + paint) — not under your control, but visible in the
   "Layout" / "Paint" tracks of the Performance panel.

A healthy editor on a mid-range laptop, on a 50KB document, produces a
flame chart where the four bars stack to **2–4 ms** of total main-thread
work per keystroke. Anything over **8 ms** means a plugin or NodeView is
doing too much per transaction.

### A.2 What the Performance panel hides

Three things to be aware of when reading the trace:

- **`MutationObserver` callbacks are batched.** A burst of edits in the same
  microtask collapses into one `flush()`. If you're seeing far fewer
  `pm:domchange` spans than keystrokes, that's why ([15 §2 flushSoon]
  (./15-domobserver-and-domchange.md)).
- **Idle costs.** `requestIdleCallback` work scheduled by your plugins
  shows up on a different track ("Animation Frame Fired" / "Idle Callback").
  Make sure to filter the user-timing track to PM-prefixed entries to see
  the editor's main-thread cost cleanly.
- **Composition gates everything.** If `view.composing` is true the docView
  freezes ([14 §5](./14-ime-composition.md)) and your `pm:view.update`
  spans will be near-zero — that's *correct*, not fast.

### A.3 Recording a representative session

Type ~50 characters into a paragraph mid-document while recording. Expect:

- One `pm:domchange` per character on Chrome/Safari, one per *word* on
  Firefox (it batches `characterData` mutations more aggressively).
- `pm:state.apply` linear in *the number of plugins*, not the document
  size — every `StateField.apply` runs once per transaction
  (`prosemirror-state/src/state.ts:148`).
- `pm:view.update` proportional to the changed *subtree* size, not the doc
  size (see [21 §G.3 Reconciliation locality](./21-rendering-pipeline-end-to-end.md)).

If `pm:view.update` grows with document size during a single-character
edit, you have a docView dirty-propagation bug — see §G below.

---

## B. Hot paths in PM and how to identify them

The rough cost ranking, hottest first, on a typing-heavy workload:

1. **`DOMObserver.flush` → `parseBetween` → `findDiff`.**
   Local DOM parse; cost is proportional to the dirty range, usually one
   paragraph. ([15 §5](./15-domobserver-and-domchange.md), [11 §6.2](./11-dom-parser.md))
2. **Plugin `state.apply` chain.**
   N plugins × M steps. Each plugin's `apply` runs even if it does nothing.
   Watch for plugins that re-derive state from the whole doc on every
   transaction (`prosemirror-state/src/state.ts:148`).
3. **`docView.update` (reconciliation).**
   Walks the changed subtree. Most expensive sub-call is `syncToMarks` for
   inline-mark-heavy content. ([09 §3](./09-view-and-viewdesc.md))
4. **`Mapping.map` + `DecorationSet.map`.**
   Linear in the number of step maps; the Mapping itself is cheap, but
   plugins that call `mapping.map(pos)` inside a loop over *all*
   decorations turn this into O(decorations × steps).
5. **`Node.eq` deep compares** (see §D).

To identify which one *you* are paying for, sample-profile in the
Performance panel and look at the bottom-up view filtered to
`prosemirror-*` frames. The four function names that should dominate are
`update`, `flush`, `apply`, and `parseBetween`. Anything else in the top
ten is suspicious.

---

## C. Large-document strategies

PM's reconciler is locality-bound, but several costs *do* scale with
document size: initial render, `state.apply` over plugins that walk the
whole doc, and decoration sets that span the entire doc.

### C.1 Virtualization via NodeView (lazy mount)

The trick: make a custom NodeView for top-level block containers that
mounts no children when offscreen, and re-mounts when scrolled in. PM's
NodeView contract makes this safe because the *document model* keeps the
content; only the DOM is lazy.

```ts
class LazySectionView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement | null = null;
  private mounted = false;
  private io: IntersectionObserver;

  constructor(public node: Node, public view: EditorView, public getPos: () => number | undefined) {
    this.dom = document.createElement("section");
    this.dom.style.minHeight = `${node.attrs.estimatedHeight}px`; // CLS-free
    this.io = new IntersectionObserver(([e]) => e.isIntersecting && this.mount());
    this.io.observe(this.dom);
  }

  mount() {
    if (this.mounted) return;
    this.mounted = true;
    this.contentDOM = document.createElement("div");
    this.dom.appendChild(this.contentDOM);
    // PM will populate contentDOM on next reconcile; force one:
    this.view.dispatch(this.view.state.tr.setMeta("force-relayout", true));
  }

  destroy() { this.io.disconnect(); }
}
```

**Caveats.** A section that has never been mounted will still receive
`update` calls from the reconciler — return `true` from `update` while
unmounted to short-circuit. And selection inside an unmounted section
will fail; you must `mount()` synchronously when `getPos()` overlaps the
selection range (subscribe to selection changes via a plugin view).

### C.2 Decoration windowing

`DecorationSet.create(doc, decos)` scales linearly with `decos.length`,
and the resulting set's `map` cost scales with the count of decorations
*near* the changed region, not all of them — but the *creation* and
*GC* cost still scale with `decos.length`. Solution: only build
decorations for the visible viewport.

```ts
const windowedDecos = new Plugin({
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set, oldState, newState) {
      const win = visibleRange(view); // {from, to} from coordsAtPos
      const decos = computeDecorations(newState.doc, win.from, win.to);
      return DecorationSet.create(newState.doc, decos);
    },
  },
  props: {
    decorations(state) { return this.getState(state); },
  },
});
```

Pair this with a scroll-listener `view.dispatch(tr)` (debounced 16ms) so
the window slides as the user scrolls. The downside is decorations don't
exist outside the window — fine for highlights, broken for spell-check
underlines you want to count globally.

### C.3 Splitting documents into sections

The most aggressive strategy: don't have one PM doc at all. Have one PM
*EditorView* per section. Cross-section selection becomes the host
application's problem, not PM's. This is how the PM website's reference
manual is built — one editor per code block.

The break-even point is somewhere around **500KB of source**. Below that,
one editor with virtualized NodeViews wins on UX (intra-document selection,
copy, find/replace). Above it, separate editors scale better than any
single-editor optimisation.

---

## D. When `Node.eq` is expensive

`Node.eq` (`prosemirror-model/src/node.ts:119`) is:

```ts
eq(other: Node) {
  return this == other || (this.sameMarkup(other) && this.content.eq(other.content));
}
```

The `this == other` short-circuit is the fast path. Without it, `eq`
recurses into `Fragment.eq` → `Node.eq` for every child, paying
`compareDeep` on `attrs` along the way (`node.ts:130`). On a
1000-paragraph doc that's 1000+ `compareDeep` calls.

**Rule of thumb.** Whenever you cache anything keyed by a node, key it by
*identity* (`WeakMap<Node, …>`), not by `eq`. PM's own internals do this
everywhere — `resolveCache` is a `WeakMap<Node, ResolveCache>`
(`prosemirror-model/src/resolvedpos.ts:257`).

If you must compare two nodes structurally (e.g., to decide whether a
decoration spec changed), prefer a hash you compute once and store on the
spec, not a recursive `eq`. The reconciler already short-circuits via
identity (`viewdesc.ts:755` — `node.eq(this.node)` is gated by
`this.node === node` upstream in `matchesNode`).

---

## E. `DecorationSet.find` cost and avoiding linear scans

`DecorationSet.find(start, end, predicate)`
(`prosemirror-view/src/decoration.ts:311`) is *not* a binary search. It
walks every local decoration in the range's overlapping subtree
(`findInner` at `decoration.ts:317`) and applies the predicate to each.

That's O(local-decos-in-range), which is fine for "what decos are at the
caret?" but **terrible** if used as a primary index. Common antipatterns:

- Calling `find()` inside a `map`/`forEach` over every position in a range
  → O(range × local) instead of O(local).
- Using `find()` to locate a specific decoration by ID. Maintain your own
  `Map<id, {from, to}>` in plugin state instead, mapped by the
  transaction's mapping ([06 §3](./06-position-mapping.md)).

If you need fast "is this position inside any deco of type X?", store an
interval tree in plugin state and rebuild it in `apply` only when
`tr.docChanged || tr.getMeta("decos-changed")`.

---

## F. Plugin state: structural sharing patterns

Plugin state survives `state.apply` because every transaction creates a
new `EditorState` — but `StateField.apply` returns the *same* reference
when nothing changed, and PM treats that as "no change" for the new state
slot. This is the single most important plugin-perf invariant:

```ts
// BAD — allocates every transaction.
apply(tr, prev) {
  return { ...prev, lastChange: tr.time };
}

// GOOD — returns prev when nothing actually changed.
apply(tr, prev) {
  if (!tr.docChanged && !tr.selectionSet) return prev;
  return { ...prev, lastChange: tr.time };
}
```

Persistent maps (immutable.js, mori, or hand-rolled HAMT) are the
canonical way to keep plugin state with O(log n) updates and full
structural sharing. The decoration tree itself is exactly this pattern —
`DecorationSet.map` (`decoration.ts:333`-ish) returns the same set when
the mapping is empty, and shares unchanged children otherwise
([10 §6](./10-decorations.md)).

---

## G. Dirty-only render verification

Internally, PM marks ViewDescs with one of four dirty levels
(`prosemirror-view/src/viewdesc.ts:132`):

```ts
const NOT_DIRTY = 0, CHILD_DIRTY = 1, CONTENT_DIRTY = 2, NODE_DIRTY = 3;
```

After `view.updateState`, *every* dirty bit should be back to `NOT_DIRTY`.
If you suspect a NodeView is forcing full re-renders, walk the docView
post-update and assert:

```ts
function assertClean(desc: any, path = "doc") {
  if (desc.dirty !== 0) console.warn("dirty leftover:", path, desc.dirty);
  desc.children.forEach((c: any, i: number) => assertClean(c, `${path}/${i}`));
}
assertClean((view as any).docView);
```

A NodeView that returns `false` from `update` will mark itself
`NODE_DIRTY` and force PM to rebuild it from scratch — this is the
single biggest cause of "PM feels slow on every keystroke" reports.

The fix: have `update(node, decos, innerDecos)` return `true` whenever
the new node has the same type as the old one and the visible attrs
haven't changed; mutate the existing DOM instead of rebuilding.

---

## H. Long-task budgets and `scheduler.postTask`

PM does its work synchronously inside `dispatch` because the typing loop
must commit to the DOM before the browser's next paint, and yielding
introduces visible jank. But *plugin-induced* work doesn't have the same
constraint — spell-check, link previews, autocomplete fetches, etc.

The right pattern is a two-phase plugin:

```ts
const linkPreview = new Plugin({
  state: {
    init: () => ({ pending: new Set<string>(), previews: new Map() }),
    apply(tr, prev) {
      const next = { ...prev };
      // SYNCHRONOUS: just collect what *needs* fetching.
      tr.doc.descendants((node) => {
        if (node.type.name === "link" && !next.previews.has(node.attrs.href))
          next.pending.add(node.attrs.href);
      });
      return next;
    },
  },
  view(view) {
    // ASYNCHRONOUS: scheduler.postTask for non-critical fetches.
    return {
      update(view, prev) {
        const { pending } = linkPreview.getState(view.state)!;
        for (const href of pending) {
          (window as any).scheduler?.postTask(
            () => fetchPreview(href).then((p) => view.dispatch(view.state.tr.setMeta(linkPreview, { href, p }))),
            { priority: "background" }
          );
        }
      },
      destroy() { /* cancel in-flight fetches */ },
    };
  },
});
```

`scheduler.postTask` (Chrome 94+, Firefox via polyfill) lets you tag work
as `background` so it runs off the main typing path. Use
`requestIdleCallback` for older browsers, but watch for it never firing
in busy tabs.

### H.1 `appendTransaction` guards

The `appendTransaction` loop runs to a fixed point
(`prosemirror-state/src/state.ts:148`). A plugin that *always* appends a
transaction will spin until PM's hard limit kicks in. Always guard:

```ts
appendTransaction(trs, oldState, newState) {
  // Only act on user-driven docChange transactions.
  if (!trs.some((t) => t.docChanged) || trs.some((t) => t.getMeta("autofix"))) return null;
  const tr = newState.tr;
  // ...
  return tr.docChanged ? tr.setMeta("autofix", true) : null;
}
```

The `setMeta("autofix", true)` flag is what stops the next iteration from
re-firing your plugin.

---

## I. Avoiding O(n²) input rule scans

`prosemirror-inputrules` reads up to `MAX_MATCH = 500` characters before
the cursor on every keystroke (`prosemirror-inputrules/src/inputrules.ts:75`,
used at `:115` in `textBefore`). Each registered rule's regex is then
tested against that string. With N rules, that's O(N × 500) regex
matches per keystroke.

**Practical guidance.**

- Keep the rule count low (under ~30). Heavy editors with 100+ rules
  visibly degrade typing latency.
- Anchor regexes to the end of the string (`/…$/`). Otherwise the regex
  engine scans the whole 500-char prefix.
- If you need many rules, group them into one regex with alternation
  and a single handler that switches on the matched group. One regex
  with 30 alternatives is faster than 30 regexes.
- Don't put rules with non-trivial backtracking (`.*` followed by
  another `.*`) in the set. They turn an O(n) scan into O(n²) per
  keystroke.

---

## J. `resolveCache` (12-slot ring buffer) and when it misses

`Node.resolve(pos)` is the single most-called API in PM —
`view.coordsAtPos`, `posAtCoords`, every Selection construction, and
every plugin that inspects the cursor calls it. So PM caches resolved
positions per-doc (`prosemirror-model/src/resolvedpos.ts:236-256`):

```ts
const resolveCacheSize = 12, resolveCache = new WeakMap<Node, ResolveCache>();

class ResolveCache {
  elts: ResolvedPos[] = [];
  i = 0;
}
```

Twelve slots, ring-buffered, keyed by *Node identity*. A miss costs
O(depth) — a full path walk down the doc.

**When the cache helps:**

- Resolving the same position twice (very common — selection sync,
  coords lookup, decorations all touch `head` and `anchor` in one tick).
- Resolving 2–10 positions in a tight cluster (visible viewport).

**When it misses (and you should care):**

- After every `state.apply` the doc is a *new* Node, so the cache is
  empty. The first 12 resolves repopulate it.
- A plugin that resolves >12 positions in one tick (e.g., walks a
  selection range and resolves each character) thrashes the cache —
  every resolve becomes a full miss.

If you're doing bulk position resolution, use `doc.descendants` (which
walks once) or `doc.nodesBetween` instead of `doc.resolve(p)` in a loop.
The cache cannot save you when you need 100 resolves in a transaction.

---

## K. `Mapping.appendMapping` cost

`Mapping.appendMapping` (`prosemirror-transform/src/map.ts:215`) walks the
incoming mapping and copies each `StepMap` into the receiver, plus a
linear scan for each map's mirror index:

```ts
appendMapping(mapping: Mapping) {
  for (let i = 0, startSize = this._maps.length; i < mapping._maps.length; i++) {
    let mirr = mapping.getMirror(i);
    this.appendMap(mapping._maps[i], mirr != null && mirr < i ? startSize + mirr : undefined);
  }
}
```

`getMirror` itself is a linear walk over the mirror array
(`map.ts:226-229`). For an N-step mapping with M mirrored pairs, the cost
is O(N × M) worst case — usually fine, but in collab rebasing where
mappings can grow into the thousands, it shows up.

Mitigation in your own code: never call `appendMapping` inside a loop
over the same source mapping; build one combined mapping at the start
and `slice()` it as needed (`map.ts:196`). PM's own `rebaseSteps` does
this — it builds one composed mapping and shares it across the rebase
loop ([20 §2.4](./20-history-and-collab.md)).

---

## L. Real-world numbers (rough anchors)

These are rough numbers from the PM reference editor on a 2023 M-class
laptop, Chrome 130, ~50KB doc with ~200 paragraphs and a syntax-
highlighting decoration plugin:

| Operation                                                       | Median  | p99     |
|-----------------------------------------------------------------|---------|---------|
| Single-character typing: `pm:domchange`                         | 0.4 ms  | 1.2 ms  |
| Single-character typing: `pm:state.apply` (5 plugins)           | 0.3 ms  | 0.9 ms  |
| Single-character typing: `pm:view.update`                       | 0.5 ms  | 2.0 ms  |
| Total dispatch round-trip (single keystroke)                    | 1.5 ms  | 5 ms    |
| Paste 100 paragraphs: `state.apply` + `view.update` end-to-end  | ~25 ms  | ~80 ms  |
| `doc.resolve(pos)` cold (cache miss, 8-deep path)               | <0.01 ms| 0.05 ms |
| `DecorationSet.map` over a 5KB range with 500 decos             | 0.1 ms  | 0.5 ms  |
| `MutationObserver` flush latency (idle to fire)                 | 0–4 ms  | 16 ms   |

**Rules of thumb you can carry into spec-time:**

- Typing latency budget: **8 ms** per keystroke for the entire PM stack.
  Above that, users notice on a 60Hz display.
- Plugin `apply`: **<0.1 ms each.** With 30 plugins you're already at
  3 ms before PM does any work.
- Decoration set construction: **<10ms** even for thousands of decos.
  If you exceed that, window them (§C.2).
- Avoid full-doc walks in hot paths. `doc.descendants` over 1000
  paragraphs is a few milliseconds — fine once, deadly per-keystroke.

If your numbers are 5–10× worse than the table above, the cause is
almost always (in order): a NodeView that returns `false` from `update`,
a plugin that rebuilds state from the whole doc on every transaction,
or an input rule with catastrophic backtracking.
