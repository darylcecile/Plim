# 30 — Document persistence

A ProseMirror document is an immutable tree of `Node` values. Persisting it means picking a serialization format, deciding when to write, planning for conflicts, and choosing how much to store at once. This file walks the practical patterns: the JSON shape, size and compression numbers, partial loading, autosave, optimistic concurrency, diff-based stores, search indexing, soft-delete, and browser storage.

## The `Node.toJSON()` shape

From `prosemirror-model/src/node.ts` line 319:

```ts
toJSON(): any {
  let obj: any = {type: this.type.name}
  for (let _ in this.attrs) { obj.attrs = this.attrs; break }
  if (this.content.size) obj.content = this.content.toJSON()
  if (this.marks.length) obj.marks = this.marks.map(n => n.toJSON())
  return obj
}
```

A produced JSON object looks like:

```json
{
  "type": "doc",
  "content": [
    {"type": "heading", "attrs": {"level": 1}, "content": [
      {"type": "text", "text": "Title"}
    ]},
    {"type": "paragraph", "content": [
      {"type": "text", "text": "Hello "},
      {"type": "text", "marks": [{"type": "strong"}], "text": "world"}
    ]}
  ]
}
```

Key details:

- **`type`** is always present.
- **`attrs`** is omitted if empty (the `for...in` early-break is precisely that test). Defaults are *not* serialized as no-attrs — the attrs object as stored on the node already includes defaults, so they show up unless the iteration sees zero keys, which only happens when the node type declared no attrs at all.
- **`content`** is omitted if the node is empty. `toJSON` on a `Fragment` returns an array.
- **`marks`** is omitted if empty (length-zero check). Mark `toJSON` returns `{type, attrs?}`.
- **Text nodes** add a `text: "..."` field; their content is implicit in the string.

The shape is JSON-roundtrip-safe by `Node.fromJSON`. Don't add fields — `fromJSON` ignores them today, but you've now coupled persisted data to undocumented behavior. Keep extra metadata in an envelope:

```json
{"schemaVersion": 3, "createdAt": "...", "doc": { /* node.toJSON() */ }}
```

## Size: JSON vs HTML vs binary

Empirical numbers from prose-heavy docs (think: blog post ~5k words, mixed marks, a few headings/lists/links):

- **HTML:** baseline (call it 1×).
- **JSON (`Node.toJSON`):** **3–5× the HTML**. The `{"type":"text","text":"..."}` envelope costs roughly 25 bytes per text run; HTML pays only for tags. A long paragraph of unmarked text is one text node in JSON (cheap), but heavily-marked text with frequent mark transitions multiplies the overhead.
- **JSON gzipped:** comparable to or *smaller* than raw HTML — gzip eats the repeated `"type":"text"` keys efficiently. Typical: **0.5–1× HTML size, 4–8× smaller than raw JSON**.
- **CBOR / msgpack:** **50–70% of raw JSON**, no gzip needed. Useful when you want a compact format that's still parseable without decompression (e.g., over a binary protocol).
- **CBOR + gzip:** marginal further reduction over gzipped JSON; not usually worth the complexity unless you're storing millions of docs.

Practical takeaway: gzip JSON for storage, send JSON over HTTP with `Content-Encoding: gzip`, and don't worry about binary formats unless profiling shows JSON parsing is your bottleneck (it rarely is for docs under 100 KB raw).

## Round-trip via DOM (HTML for human/third-party readability)

When the storage layer needs to be readable by tooling that doesn't know your schema — email clients, RSS readers, static site generators — store HTML, not JSON.

```ts
import {DOMSerializer, DOMParser} from "prosemirror-model"

function toHtml(doc: Node, schema: Schema): string {
  const div = document.createElement("div")
  div.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(doc.content))
  return div.innerHTML
}

function fromHtml(html: string, schema: Schema): Node {
  const div = document.createElement("div")
  div.innerHTML = html
  return DOMParser.fromSchema(schema).parse(div)
}
```

The round-trip is *lossy* by design: anything not represented in `toDOM`/`parseDOM` is dropped. Custom attrs without a DOM mapping vanish. Decorations, selection state, plugin state — none persist. For a CMS where the source of truth is "what the user sees", this is fine. For a structured document store with semantic attrs, use JSON and serve HTML on demand.

## Partial loading: section atoms + lazy NodeView

For long docs (legal contracts, books, multi-thousand-page wikis), loading the entire JSON tree at once is wasteful. The pattern:

1. Persist the doc as a tree of *sections*. Each section is its own document or sub-tree.
2. The summary doc loaded into the editor contains lightweight `section` atoms — leaf nodes that record `{id, title, headerOnly}`.
3. Render each `section` atom as a `NodeView` whose constructor lazy-fetches the full body via API and replaces itself with the loaded subtree on demand.

```ts
class SectionView implements NodeView {
  dom = document.createElement("div")
  constructor(node: Node, view: EditorView, getPos: () => number) {
    this.dom.classList.add("section-stub")
    this.dom.textContent = node.attrs.title
    this.dom.addEventListener("click", async () => {
      const body = await fetch(`/sections/${node.attrs.id}`).then(r => r.json())
      const fragment = Node.fromJSON(view.state.schema, body).content
      const tr = view.state.tr.replaceWith(getPos(), getPos() + 1, fragment)
      view.dispatch(tr)
    })
  }
}
```

Pair with virtualization (only rendering visible sections, recycling DOM for off-screen ones) for the absurdly-large case. The trade-off: text search across un-loaded sections must hit the server. Plan an indexing layer (see below).

## Autosave patterns

The right hook is `dispatchTransaction` (or a plugin's `view`/`update` callback), not raw DOM events. Transactions are the canonical signal that *meaningful* state changed.

```ts
let pending: Node | null = null
let timer: ReturnType<typeof setTimeout> | null = null

const view = new EditorView(mount, {
  state,
  dispatchTransaction(tr) {
    const next = view.state.apply(tr)
    view.updateState(next)
    if (tr.docChanged) {
      pending = next.doc
      if (!timer) timer = setTimeout(flush, 2000)
    }
  }
})

async function flush() {
  timer = null
  if (!pending) return
  const doc = pending
  pending = null
  await save(doc.toJSON())
}
```

Refinements:

- **Debounce on doc change, but max-wait on first edit.** Pure debounce starves users who type continuously for a minute. Combine debounce (e.g., 2s after last edit) with a hard cap (e.g., flush every 10s of continuous typing).
- **Don't save on every keystroke.** Even local IndexedDB writes block the main thread enough to cause jank at high WPM.
- **Save the *doc*, not the transactions, by default.** Transactions stack as the buffer; flush serializes the latest doc once. The diff-based pattern below is the alternative when you genuinely need every step.
- **Skip selection-only transactions.** `tr.docChanged` is your filter. Selection moves don't need to write.
- **Coalesce in-flight saves.** If a save is already in flight when the next debounce fires, wait for the first to complete; don't fan out concurrent PUTs that race.

## Conflict on save: optimistic concurrency

The single-user multi-tab case (or multi-device) requires conflict detection even without real collab:

```ts
async function save(doc: any, version: number) {
  const res = await fetch(`/docs/${id}`, {
    method: "PUT",
    headers: {"If-Match": String(version), "Content-Type": "application/json"},
    body: JSON.stringify({version: version + 1, doc})
  })
  if (res.status === 412) {
    // someone else saved first; reload and merge
    const fresh = await fetch(`/docs/${id}`).then(r => r.json())
    return reconcile(fresh)
  }
  return res.json()
}
```

The `If-Match` header against a version number (or ETag) gives you optimistic concurrency: server rejects writes that don't match its current version. On 412, you choose:

- **Reload + force user to reapply changes** — simplest, ugly UX for active edits.
- **Three-way merge** — apply your local steps onto the fresh server doc using `prosemirror-collab`'s rebase. This is collab-lite: same primitives, no socket.
- **Branch + prompt** — store the conflicted version as a branch, ask the user.

Once you implement the rebase path, you've effectively built a collab system. At that point, switch to real `prosemirror-collab` with an authority server; ad-hoc conflict resolution accumulates bugs faster than the protocol does.

## Diff-based persistence

Instead of storing the doc, store the *step stream*. Reconstruct the doc as `initial + apply(step_1) + apply(step_2) + ...`.

```ts
const steps: any[] = []           // serialized
let baseline: any = doc0.toJSON() // checkpoint

view.someProp("dispatchTransaction", tr => {
  for (const s of tr.steps) steps.push(s.toJSON())
})
```

Reconstruction:

```ts
let doc = Node.fromJSON(schema, baseline)
let tr = new Transform(doc)
for (const j of steps) tr.step(Step.fromJSON(schema, j))
doc = tr.doc
```

Benefits:
- **Granular history.** Every keystroke recoverable. Undo across sessions.
- **Cheap incremental writes.** Append a step (a few hundred bytes) per edit instead of rewriting the whole doc.
- **Audit trail.** Who did what and when, by tagging steps with metadata.

Costs:
- **Reconstruction cost grows linearly.** Mitigate with periodic checkpoints — every N steps, snapshot the doc and start a new chain.
- **Schema migration is harder.** Steps reference node/mark types by name. Renaming a type retroactively requires rewriting the step stream too.
- **Storage overhead can exceed the doc itself** for noisy edits.

This pattern is the foundation of `prosemirror-collab` and of products like Notion that want server-side undo. It's overkill for a typical CMS.

## Compression

Numbers from a prose-heavy 50KB JSON doc:

- **Raw JSON:** 50 KB.
- **gzip default:** ~7 KB (≈7× reduction).
- **gzip max:** ~6 KB (≈8×).
- **brotli max:** ~5 KB (≈10×).

For IndexedDB, gzip with a worker and store the bytes; you'll fit ~5× more docs in the same quota. Many backends (S3, Cloudflare KV) compress transparently. Browser `Response.body.pipeThrough(new DecompressionStream("gzip"))` and `CompressionStream("gzip")` handle the client-side without a library.

## Indexing for search

Storing JSON is great for editing. It's terrible for search — full-text engines want plain strings, not nested trees.

Build a side index when you persist:

```ts
import {textBetween} from "prosemirror-model" // node.textBetween in practice

function buildSearchIndex(doc: Node) {
  return {
    fullText: doc.textBetween(0, doc.content.size, " ", " "),
    sections: collectSections(doc),       // array of {id, title, summary}
    headings: collectHeadings(doc),       // array of {level, text, pos}
    mentions: collectMentions(doc),       // for @-mentions, array of user IDs
  }
}
```

- **`fullText`** → into your search engine's text field.
- **`sections`** / **`headings`** → for "jump to section" UI.
- **`mentions`** → for notifications and access-control queries.

Re-index on save. For incremental indexing, walk only the changed range (`tr.mapping.maps` give you affected positions), but the simple "rebuild on save" approach is fine until docs exceed ~MB territory.

## Soft-delete and restore

Persisting a delete should not actually delete the doc. The pattern:

1. **Replace the doc** with a placeholder envelope: `{deletedAt: ..., deletedBy: ..., previousId: ...}`.
2. **Move the previous content** to a sibling record (`docs_archive` table) keyed by `previousId`.
3. **Restore** = swap them back, with a new `id` and the old content as the live doc.

This generalizes to versioned history: every save bumps a version, prior versions go to the archive table with TTL. Combined with the diff-based persistence pattern, you get full revision history for free — every checkpoint is a restore point.

Don't rely on the soft-delete column being respected by every query path; enforce it in views or row-level security. A DELETE that bypasses the soft-delete trigger is harder to undo than the original "real delete" you were avoiding.

## Browser storage

For client-side persistence (offline editing, draft autosave):

- **localStorage:** synchronous, 5–10 MB cap (varies by browser; Safari is the strictest at ~5 MB across all keys per origin). String-only values. Fine for a single draft; do not put a corpus here.
- **sessionStorage:** same shape, scoped to tab lifetime. Good for unsaved-draft recovery within a session.
- **IndexedDB:** asynchronous, large quotas (typically 60% of available disk on Chrome, 1 GB hard cap on Firefox by default, ~1 GB on Safari per origin). Stores binary (Blobs, ArrayBuffers) and structured-cloned objects. The right place for serious doc storage.
- **Cache API:** intended for HTTP responses; useful if you serve docs as JSON GETs and want offline replay.
- **OPFS (Origin Private File System):** newer, file-system-like, larger quotas, sync APIs in workers. Use when IndexedDB's transactional model fights you.

A reasonable client-side stack: IndexedDB via `idb` library, one object store keyed by doc id, value is a gzipped JSON blob. Cache decoded `Node` instances behind `WeakRef` so they're collectible under memory pressure:

```ts
const cache = new Map<string, WeakRef<Node>>()

async function getDoc(id: string): Promise<Node> {
  const live = cache.get(id)?.deref()
  if (live) return live
  const blob = await db.get("docs", id)
  const json = JSON.parse(await ungzip(blob))
  const doc = Node.fromJSON(schema, json.doc)
  cache.set(id, new WeakRef(doc))
  return doc
}
```

`WeakRef` lets the GC reclaim cached docs the user navigates away from without you tracking eviction policies. Pair with `FinalizationRegistry` if you need to drop the map entry on collection.

## A coherent persistence architecture

Putting it together for a typical product:

1. **Server canonical store:** versioned JSON-in-JSONB-column, with gzip compression, optimistic concurrency via `version` column, soft-delete via `deleted_at`, side index in your search engine populated on save.
2. **Client cache:** IndexedDB-backed last-known-good doc, gzipped, keyed by id, refreshed on save success.
3. **Autosave:** debounce 2s, hard-flush 10s, dispatch-transaction-driven, `If-Match` against server version, fall back to collab-style rebase on 412.
4. **History:** diff-based step log on top of canonical doc, checkpointed every 100 steps.
5. **HTML export:** computed on demand via `DOMSerializer`, not stored.
6. **Search:** `doc.textBetween` extracted on save, fed to your search engine; structured fields (headings, mentions) extracted in the same pass.

The bones are simple: JSON for storage, HTML for export, transactions for change detection, optimistic concurrency for safety, diffs when you need history. Layer them only when the workload demands it; the default of "JSON-in-a-row plus debounced save" is the right answer for most products and the foundation for everything else.
