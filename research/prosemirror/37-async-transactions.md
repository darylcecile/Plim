# 37 — Async Transactions: Patterns for Network-Backed Edits

ProseMirror transactions are **synchronous**. `view.dispatch(tr)` returns
`void`, and by the time it returns `view.state` has already advanced. There is
no `await dispatch(...)`, no transaction queue, no "transaction in flight"
state. The state machine is, by design, instantaneous.

This collides with three common requirements:

1. **Server lookups** — pasted URL needs an oEmbed fetch before rendering.
2. **Image / file uploads** — the user dropped a file; we need a URL before we
   know the final node attrs.
3. **AI completion / streaming** — tokens arrive over time and need to be
   spliced into the document at a position that may have moved.

This file documents the standard patterns, the race conditions you will hit,
and worked examples.

---

## The Core Problem

Suppose the user drops an image at position 42. The naive approach:

```ts
const file = event.dataTransfer.files[0];
const url = await uploadImage(file);                         // ← async
view.dispatch(view.state.tr.insert(42, schema.nodes.image.create({ src: url })));
```

Three things break:

1. **Position 42 may not exist anymore.** The user typed; collab inserted text;
   the doc shrank. Position 42 in the *old* document is at position 89 (or
   nowhere) in the *new* one.
2. **No visual feedback.** During the upload, the user has no indication that
   anything is happening. They might drop the same file three times.
3. **Cancellation.** If the user undoes or navigates away, the upload promise
   still resolves and we dispatch a transaction into a destroyed view.

Every async-transaction pattern is a variation on solving (1), (2), and (3).

---

## Pattern 1: Placeholder Atom Node + Position Mapping

Insert a real node into the doc as a placeholder. Track its identity via
attrs. On resolve, find the current position by doc traversal.

```ts
import { EditorView } from "prosemirror-view";
import { NodeSpec } from "prosemirror-model";

// schema.nodes.imagePlaceholder
export const imagePlaceholder: NodeSpec = {
  attrs: { id: { default: "" } },
  inline: true,
  group: "inline",
  atom: true,
  toDOM: (node) => [
    "span",
    { class: "image-placeholder", "data-id": node.attrs.id },
    "Loading…",
  ],
};

export async function insertImage(view: EditorView, file: File) {
  const id = crypto.randomUUID();
  const { schema, tr } = view.state;
  const placeholder = schema.nodes.imagePlaceholder.create({ id });
  view.dispatch(tr.replaceSelectionWith(placeholder));

  let url: string;
  try {
    url = await uploadImage(file);
  } catch (err) {
    removePlaceholder(view, id);
    throw err;
  }

  // Re-read state; the doc has likely changed.
  const pos = findPlaceholder(view.state.doc, id);
  if (pos == null) return; // user undid / removed it.

  const image = schema.nodes.image.create({ src: url });
  view.dispatch(view.state.tr.replaceWith(pos, pos + 1, image));
}

function findPlaceholder(doc: any, id: string): number | null {
  let found: number | null = null;
  doc.descendants((node: any, pos: number) => {
    if (node.type.name === "imagePlaceholder" && node.attrs.id === id) {
      found = pos;
      return false;
    }
  });
  return found;
}

function removePlaceholder(view: EditorView, id: string) {
  const pos = findPlaceholder(view.state.doc, id);
  if (pos == null) return;
  view.dispatch(view.state.tr.delete(pos, pos + 1));
}
```

**Pros**

- Survives collab — peers see the placeholder too, can remove it if needed.
- Survives undo/redo — the placeholder is a real node in history.
- The "find placeholder" step is bullet-proof: no position math, no mapping
  bookkeeping.

**Cons**

- Schema bloat: you need a placeholder type for every async-inserted node
  type.
- Doc traversal is O(n) per resolve — fine for ≤10k nodes, may need indexing
  beyond that.
- The placeholder lives in the doc, so it is collab-visible. Sometimes you
  want it local-only (see Pattern 2).

---

## Pattern 2: Decoration-Only Placeholder + Plugin State

Don't add a node. Just add a widget decoration tracked in plugin state.

```ts
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

interface Slot { id: string; pos: number }

const key = new PluginKey<{ set: DecorationSet }>("asyncSlots");

export const asyncSlots = new Plugin<{ set: DecorationSet }>({
  key,
  state: {
    init: () => ({ set: DecorationSet.empty }),
    apply(tr, prev) {
      let set = prev.set.map(tr.mapping, tr.doc);
      const meta = tr.getMeta(key) as
        | { add?: Slot; remove?: string }
        | undefined;
      if (meta?.add) {
        const el = document.createElement("span");
        el.className = "async-slot";
        el.textContent = "…";
        set = set.add(tr.doc, [
          Decoration.widget(meta.add.pos, el, { id: meta.add.id, side: 1 }),
        ]);
      }
      if (meta?.remove) {
        const found = set.find(undefined, undefined, (s) => s.id === meta.remove);
        set = set.remove(found);
      }
      return { set };
    },
  },
  props: {
    decorations: (state) => key.getState(state)!.set,
  },
});

export async function insertAsync(
  view: EditorView,
  task: () => Promise<NodeJSON>,
) {
  const id = crypto.randomUUID();
  view.dispatch(
    view.state.tr.setMeta(key, {
      add: { id, pos: view.state.selection.from },
    }),
  );

  const result = await task();

  const set = key.getState(view.state)!.set;
  const deco = set.find(undefined, undefined, (s) => s.id === id)[0];
  if (!deco) return; // user cancelled by removing slot

  const node = view.state.schema.nodeFromJSON(result);
  const tr = view.state.tr
    .replaceWith(deco.from, deco.from, node)
    .setMeta(key, { remove: id });
  view.dispatch(tr);
}

export function cancelSlot(view: EditorView, id: string) {
  view.dispatch(view.state.tr.setMeta(key, { remove: id }));
}
```

**Pros**

- No schema changes. Local-only by default — peers don't see the placeholder.
- Decoration position is mapped through every transaction automatically.
- Cancellation is trivial: just remove the decoration.

**Cons**

- Not collab-broadcastable without extra plumbing (peers can't see "Bob is
  uploading something here").
- A widget decoration occupies zero document width, so the user can type
  *through* the placeholder. If you want to reserve space, use Pattern 1.

---

## Pattern 3: Optimistic Insert with Pending Mark

Insert the *real* content immediately, marked as pending. On server confirm,
remove the mark; on reject, undo the insert.

```ts
// schema.marks.pending: { class: "pending" }

export async function optimisticInsert(view: EditorView, content: Slice) {
  const startTrId = ++txCounter;
  const { tr, schema } = view.state;
  const pending = schema.marks.pending.create({ trId: startTrId });
  tr.replaceSelection(content);
  // Mark the just-inserted range as pending.
  const mappedFrom = tr.selection.from - content.size;
  tr.addMark(mappedFrom, tr.selection.from, pending);
  view.dispatch(tr);

  try {
    await confirmWithServer(content);
    // Find pending mark by trId; remove it.
    const range = findPendingRange(view.state.doc, startTrId);
    if (!range) return;
    view.dispatch(
      view.state.tr.removeMark(range.from, range.to, schema.marks.pending),
    );
  } catch (err) {
    // Undo the insert, but only the insert — not subsequent user edits.
    const range = findPendingRange(view.state.doc, startTrId);
    if (range) {
      view.dispatch(view.state.tr.delete(range.from, range.to));
    }
  }
}

function findPendingRange(doc: any, trId: number): { from: number; to: number } | null {
  let from: number | null = null;
  let to: number | null = null;
  doc.descendants((node: any, pos: number) => {
    const m = node.marks.find(
      (m: any) => m.type.name === "pending" && m.attrs.trId === trId,
    );
    if (m) {
      if (from == null) from = pos;
      to = pos + node.nodeSize;
    }
  });
  return from != null && to != null ? { from, to } : null;
}
```

**Pros**

- User sees their content immediately; latency is hidden.
- Works great for chat-like UX (paste, send, confirm).

**Cons**

- Reverting on failure is fragile if the user has typed *inside* the inserted
  content. You'd undo their edits too.
- History interaction: the pending insert is in undo stack. If the user undoes
  before confirm arrives, you have to detect that and skip the confirm
  transaction.

---

## Race Conditions

### Out-of-Order Resolution

User triggers two AI completions in quick succession. Request A fires, request
B fires, B resolves before A. If both write to the same slot, B's content gets
overwritten by A's stale result.

**Fix:** sequence number guard.

```ts
const requests = new Map<string, { seq: number }>();
let globalSeq = 0;

async function aiComplete(view: EditorView, prompt: string) {
  const id = crypto.randomUUID();
  const seq = ++globalSeq;
  requests.set(id, { seq });

  const result = await callAI(prompt);

  const current = requests.get(id);
  if (!current || current.seq !== seq) return; // superseded
  requests.delete(id);
  // dispatch …
}
```

### Cancellation via AbortController

Wire cancellation into the plugin's `view.destroy` so closing the editor
aborts in-flight requests.

```ts
class AsyncPluginView {
  controllers = new Set<AbortController>();

  startUpload(file: File) {
    const ctrl = new AbortController();
    this.controllers.add(ctrl);
    fetch("/upload", { method: "POST", body: file, signal: ctrl.signal })
      .then(/* … */)
      .finally(() => this.controllers.delete(ctrl));
  }

  destroy() {
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
  }
}
```

When the user removes a placeholder (e.g. via undo), the plugin should also
abort the corresponding controller. Hook that into the `apply` step that
detects the placeholder disappearing.

### Double-Resolve

A retry layer (fetch with retry-on-network-error) can call your `.then`
twice if not careful. Always guard:

```ts
let resolved = false;
fetcher().then((url) => {
  if (resolved) return;
  resolved = true;
  // …
});
```

Or use `AbortController` inside the retry logic so you only ever have one
in-flight request per slot.

---

## Collab Interactions

In a collab session, the placeholder strategy you choose has consequences:

- **Pattern 1 (atom node)**: peers see the placeholder. Good for "Alice is
  uploading an image". On resolve, only the originator should dispatch the
  replace — peers receive the replace via the collab stream. To enforce this,
  store the originator's client ID in the placeholder attrs and check before
  dispatching.

- **Pattern 2 (decoration)**: decorations are local-only. Peers see nothing
  during the upload, then suddenly see the resolved node arrive. To make peers
  see "Alice is uploading", broadcast a presence-style message separately
  (see plugin cookbook §5).

- **Pattern 3 (optimistic + pending mark)**: the pending content goes
  through the collab stream. Peers see it immediately, including the pending
  mark (style it so they know it's not yet confirmed). On rejection, the
  originator dispatches a delete; the collab stream propagates that to peers.

**Originator check** (Pattern 1):

```ts
async function uploadAndReplace(view: EditorView, file: File, clientId: string) {
  const id = crypto.randomUUID();
  // ... insert placeholder with { id, clientId } ...
  const url = await upload(file);
  // Re-find by id; only act if we own this placeholder.
  const node = findPlaceholderNode(view.state.doc, id);
  if (!node || node.attrs.clientId !== clientId) return;
  // ... dispatch replace ...
}
```

---

## Worked Example 1: Image Drop Upload

Full code from drop to final image, with placeholder, mapping, cancellation,
and originator check.

```ts
import { Plugin, PluginKey } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { Schema, NodeSpec } from "prosemirror-model";

// --- Schema additions ---
export const imagePlaceholderSpec: NodeSpec = {
  attrs: { id: { default: "" }, clientId: { default: "" } },
  inline: true,
  group: "inline",
  atom: true,
  toDOM: (n) => [
    "span",
    { class: "img-placeholder", "data-id": n.attrs.id },
    ["span", { class: "spinner" }],
  ],
};

// --- Plugin ---
const uploadKey = new PluginKey<{ controllers: Map<string, AbortController> }>(
  "imageUpload",
);

export const imageUploadPlugin = (clientId: string) =>
  new Plugin<{ controllers: Map<string, AbortController> }>({
    key: uploadKey,
    state: {
      init: () => ({ controllers: new Map() }),
      apply: (_, prev) => prev, // controllers managed by view
    },
    props: {
      handleDrop(view, event) {
        const files = Array.from(event.dataTransfer?.files ?? []).filter(
          (f) => f.type.startsWith("image/"),
        );
        if (!files.length) return false;
        event.preventDefault();

        const coords = view.posAtCoords({
          left: event.clientX,
          top: event.clientY,
        });
        if (!coords) return true;
        const insertPos = coords.pos;

        for (const file of files) {
          startUpload(view, clientId, insertPos, file);
        }
        return true;
      },
    },
    view() {
      return {
        destroy() {
          const state = uploadKey.getState((this as any).view?.state);
          state?.controllers.forEach((c) => c.abort());
        },
      };
    },
  });

function startUpload(
  view: EditorView,
  clientId: string,
  pos: number,
  file: File,
) {
  const id = crypto.randomUUID();
  const { schema } = view.state;
  const placeholder = schema.nodes.imagePlaceholder.create({ id, clientId });
  view.dispatch(view.state.tr.insert(pos, placeholder));

  const ctrl = new AbortController();
  uploadKey.getState(view.state)!.controllers.set(id, ctrl);

  uploadImage(file, ctrl.signal)
    .then((url) => {
      finishUpload(view, id, clientId, url);
    })
    .catch((err) => {
      if (err.name === "AbortError") return;
      console.error("upload failed", err);
      removePlaceholder(view, id);
    })
    .finally(() => {
      uploadKey.getState(view.state)?.controllers.delete(id);
    });
}

function finishUpload(
  view: EditorView,
  id: string,
  clientId: string,
  url: string,
) {
  const result = locatePlaceholder(view.state.doc, id);
  if (!result) return; // gone — user removed it
  if (result.node.attrs.clientId !== clientId) return; // not ours (collab)

  const image = view.state.schema.nodes.image.create({ src: url });
  view.dispatch(
    view.state.tr.replaceWith(result.pos, result.pos + 1, image),
  );
}

function locatePlaceholder(doc: any, id: string) {
  let out: { node: any; pos: number } | null = null;
  doc.descendants((node: any, pos: number) => {
    if (
      node.type.name === "imagePlaceholder" &&
      node.attrs.id === id
    ) {
      out = { node, pos };
      return false;
    }
  });
  return out;
}

function removePlaceholder(view: EditorView, id: string) {
  const r = locatePlaceholder(view.state.doc, id);
  if (!r) return;
  view.dispatch(view.state.tr.delete(r.pos, r.pos + 1));
}

async function uploadImage(file: File, signal: AbortSignal): Promise<string> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/upload", { method: "POST", body: fd, signal });
  if (!res.ok) throw new Error(`upload ${res.status}`);
  const { url } = await res.json();
  return url;
}
```

**What this handles**

- Multiple concurrent uploads — each gets its own `id` and AbortController.
- User-initiated cancellation — undo of the placeholder triggers
  `locatePlaceholder` returning null, so no replace is dispatched. (To also
  abort the in-flight fetch, watch for placeholder disappearance in
  `appendTransaction` and call `controller.abort()`.)
- View destroy — aborts all pending uploads.
- Collab — `clientId` check prevents two clients both replacing the same
  placeholder.

**What this does NOT handle (left as exercise)**

- Progress reporting (use `XMLHttpRequest` or fetch streams; update placeholder
  attrs with progress %).
- Server-side dedup of repeat uploads.

---

## Worked Example 2: AI Streaming Completion

Tokens arrive over a `ReadableStream`. We dispatch a transaction per chunk,
appending text to a tracked range.

```ts
export async function streamComplete(view: EditorView, prompt: string) {
  const id = crypto.randomUUID();
  const startPos = view.state.selection.from;

  // Plugin state holds { id → { from, to } } for each in-flight stream.
  view.dispatch(
    view.state.tr.setMeta(streamKey, {
      add: { id, from: startPos, to: startPos },
    }),
  );

  const ctrl = new AbortController();
  const res = await fetch("/api/complete", {
    method: "POST",
    body: JSON.stringify({ prompt }),
    signal: ctrl.signal,
  });
  if (!res.body) return;

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    const slot = streamKey.getState(view.state)!.slots.get(id);
    if (!slot) {
      ctrl.abort(); // user cancelled
      return;
    }

    const tr = view.state.tr.insertText(value, slot.to);
    // Update the tracked range to include the new text.
    tr.setMeta(streamKey, {
      update: { id, from: slot.from, to: slot.to + value.length },
    });
    view.dispatch(tr);
  }

  // Final cleanup — strip pending mark, etc.
  view.dispatch(view.state.tr.setMeta(streamKey, { complete: id }));
}
```

The plugin's `apply` step *maps `from` and `to` through `tr.mapping`* on every
transaction:

```ts
apply(tr, prev) {
  const slots = new Map(prev.slots);
  for (const [id, { from, to }] of slots) {
    slots.set(id, {
      from: tr.mapping.map(from, -1),
      to: tr.mapping.map(to, 1),
    });
  }
  // ... handle add/update/complete metas ...
}
```

The `-1` / `1` bias ensures that if the user types *into* the streaming range,
the range expands to include their text rather than collapsing.

**Pitfalls**

- Calling `view.dispatch` from inside the read loop is fine, but if you batch
  many tokens per second, throttle to ~30fps to avoid layout thrash.
- If the user starts typing *inside* the streamed text, decide your UX: do you
  pause streaming? Abort? Keep streaming after their cursor? Each is valid;
  pick one and document it.

---

## Pitfall Catalog

### 1. Stale closures over `view.state`

```ts
// ❌ wrong — captures state at fetch time
const old = view.state;
fetch(url).then(() => {
  view.dispatch(old.tr.insert(/*…*/));  // ← old.tr is from stale state
});

// ✅ right
fetch(url).then(() => {
  view.dispatch(view.state.tr.insert(/*…*/));
});
```

`tr` from a stale state will throw `RangeError: Position N out of range` (or,
worse, silently insert at a wrong position) the moment any other transaction
has happened in between.

### 2. Race with user undo

User triggers async insert → user hits Cmd-Z before resolve → resolve fires →
re-inserts content the user just undid.

**Fix:** check that the placeholder still exists. Pattern 1's
`findPlaceholder` returning null naturally handles this. Pattern 2's
`set.find(...)` likewise.

### 3. Double-resolve

Callbacks invoked twice (auto-retry, hot reload, fragment of a Promise.race).
Set a `resolved` flag or use `Promise.allSettled` boundaries.

### 4. Forgetting to update plugin state when user removes placeholder

If you only track placeholders in plugin state via `setMeta`, and the user
deletes the placeholder via Backspace, plugin state still thinks it exists.
Solve by also detecting deletion in `apply`:

```ts
apply(tr, prev, _o, newState) {
  let { slots } = prev;
  if (tr.docChanged) {
    const liveIds = new Set<string>();
    newState.doc.descendants((n) => {
      if (n.type.name === "imagePlaceholder") liveIds.add(n.attrs.id);
    });
    slots = new Map([...slots].filter(([id]) => liveIds.has(id)));
  }
  // ... apply metas ...
}
```

### 5. Dispatching after view destroy

If the editor unmounts while a request is in flight, `view.dispatch` will
throw. Always wrap:

```ts
fetcher().then((res) => {
  if ((view as any).isDestroyed) return;
  view.dispatch(/*…*/);
});
```

There is no public `isDestroyed` in core PM; track it yourself by setting a
flag in the plugin's `view().destroy`.

### 6. Tx ordering with collab

Collab's `sendableSteps` only ships *committed* steps. If you dispatch a
"placeholder insert" then `await` a network call, peers might see the
placeholder before you finish; that's usually desired. But if you `await`
*before* the placeholder dispatch, the placeholder ships *after* the resolved
content — you'll see flicker. Always dispatch the placeholder first,
synchronously.

### 7. Mapping bias mistakes

When mapping a range that the user might be typing into:

- `tr.mapping.map(pos, -1)` → bias left (range start)
- `tr.mapping.map(pos, 1)` → bias right (range end)

Get this wrong and inserted text either falls outside your range or doubles
in length on every keystroke.

---

## Summary Decision Table

| Need                                    | Recommended pattern              |
| --------------------------------------- | -------------------------------- |
| Image / file upload                     | 1 (atom placeholder)             |
| oEmbed lookup on paste                  | 1 (atom placeholder)             |
| Local-only inline `…` while loading     | 2 (decoration)                   |
| Chat-style "send and pray"              | 3 (optimistic + pending)         |
| AI streaming                            | 2 (decoration) + per-chunk tx    |
| Multi-user "Bob is uploading"           | 1 + presence broadcast           |
| Reversible by undo                      | 1 (history captures node)        |
| Reversible by user explicit cancel      | 2 (decoration) — easy remove     |

When in doubt, prefer Pattern 1: putting the placeholder in the document is
the safest, most observable, most collab-friendly default. Reach for Pattern 2
when you specifically want local-only state, and for Pattern 3 only when the
UX of optimistic insertion truly matters.
