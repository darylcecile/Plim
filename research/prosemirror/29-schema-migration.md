# 29 — Schema migration & evolution

ProseMirror schemas are *strict* by design — `Node.fromJSON` throws on anything it doesn't recognize, `nodeType.create` throws on missing required attrs, and `node.check()` throws if content doesn't satisfy the content expression. This strictness is a feature: it protects the editor from corrupt state at runtime. It is also the source of every schema-migration headache. This file maps the failure modes and the mitigation patterns.

## Why schemas change

Real products evolve their schema. Common drivers:

- **Renames.** `code_block` → `codeBlock` to match a project naming convention. `image` → `inlineImage` after introducing a separate `blockImage`.
- **New attrs.** Add `language` to `code_block`. Add `width` to `image`. Add `id` to `heading` for anchor links.
- **Expanded content expressions.** A `figure` that used to allow `image caption` now allows `(image | video) caption`.
- **New nodes/marks.** Add `mention`, `mathInline`, `taskList`, `highlight`.
- **Removed nodes/marks.** Drop a deprecated `legacy_table` after migrating data to the new table schema.
- **Changed attr semantics.** `heading.level` was 1–6, now arbitrary integer with a `style` attr controlling rendering.

Every one of these changes can break documents persisted under the old schema. The fix is to *plan for migration* before shipping the first schema, not after.

## Versioning persisted JSON

The single best decision you can make on day one: wrap every persisted document in an envelope that carries the schema version.

```ts
type StoredDoc = {
  schemaVersion: number,
  schemaName: string,        // e.g., "doc-schema"
  doc: any                   // result of node.toJSON()
}
```

Storing the bare `node.toJSON()` is the trap. You will eventually need to migrate, and you will not know which version any given record is on. Tagging each record makes migration a pure function `(StoredDoc) -> StoredDoc` you can run lazily on read.

A loader becomes:

```ts
function loadDoc(stored: StoredDoc, schema: Schema): Node {
  const migrated = migrate(stored, CURRENT_VERSION)
  return Node.fromJSON(schema, migrated.doc)
}

function migrate(stored: StoredDoc, target: number): StoredDoc {
  let cur = stored
  while (cur.schemaVersion < target) {
    cur = MIGRATIONS[cur.schemaVersion](cur)
  }
  return cur
}
```

`MIGRATIONS` is a sparse array of `(stored) => stored` functions, one per version increment, each transforming the JSON tree before it's handed to `fromJSON`. Migrations operate on plain JSON — no schema is involved — which is exactly what you want, because the *current* schema can't parse the *old* JSON anyway.

## `Node.fromJSON` failure modes

From `prosemirror-model/src/node.ts` line 333:

```ts
static fromJSON(schema: Schema, json: any): Node {
  if (!json) throw new RangeError("Invalid input for Node.fromJSON")
  let marks = undefined
  if (json.marks) {
    if (!Array.isArray(json.marks)) throw new RangeError("Invalid mark data for Node.fromJSON")
    marks = json.marks.map(schema.markFromJSON)
  }
  if (json.type == "text") { /* ... */ }
  let content = Fragment.fromJSON(schema, json.content)
  let node = schema.nodeType(json.type).create(json.attrs, content, marks)
  node.type.checkAttrs(node.attrs)
  return node
}
```

The throw points:

1. **`schema.nodeType(json.type)`** — throws if the node name is unknown. Renaming `code_block` to `codeBlock` blows up here.
2. **`schema.markFromJSON`** — same for unknown marks.
3. **`type.create(json.attrs, content, marks)`** — content fails the schema's content expression, e.g., paragraph receiving a block child after you tightened the expression.
4. **`type.checkAttrs(node.attrs)`** — required attr missing, or attr value fails its `validate` function.

All of these are unrecoverable at runtime: PM does not partially load a doc. You either pre-migrate or you wrap `fromJSON` in `try`/`catch` and fall back. The catch path is uncomfortable — you've already lost structure — so prefer pre-migration.

## Reparse-from-DOM as a migration path

When JSON migration is too painful (large attr-shape changes, removed nodes that need contextual replacement), serialize the old doc to HTML using the *old* schema, then parse it with the *new* schema. The DOMParser's tolerance — it skips unknown tags, falls back to text, applies parse rules in order — turns it into a forgiving migration layer.

```ts
import {DOMSerializer, DOMParser} from "prosemirror-model"

function migrateViaDom(oldDoc: Node, oldSchema: Schema, newSchema: Schema): Node {
  const html = DOMSerializer.fromSchema(oldSchema)
    .serializeFragment(oldDoc.content)
  const div = document.createElement("div")
  div.appendChild(html)
  return DOMParser.fromSchema(newSchema).parse(div)
}
```

Caveats:
- This only works if both schemas have compatible `toDOM`/`parseDOM` on the overlapping nodes.
- You lose anything not represented in HTML: custom attrs without a DOM mapping vanish.
- Marks attached to text via `parseDOM` rules in the new schema may pick up stray HTML decoration from the old.

In practice, reparse-from-DOM is the migration path for *display-equivalent* changes (`code_block` rendered as `<pre><code>` in both schemas, just renamed). For semantic changes you need explicit JSON rewriting.

## Field compat: defaults absorb missing keys

An attr declared with a default is forgiving:

```ts
attrs: { language: { default: null } }
```

Old documents that lack `language` parse fine — `Node.fromJSON` calls `type.create(json.attrs, ...)`, and `create` fills in defaults for any missing attr. Required attrs (no default) throw. The rule:

> **Always declare a default for new attrs.** Make required attrs the exception, not the norm.

This single discipline removes 80% of migration pain. Adding `language: {default: null}` to `code_block` requires zero migration; existing docs deserialize unchanged.

The same logic for `validate`: prefer permissive validators that accept the migration period's intermediate states. A strict `validate: v => typeof v === "string"` will throw on `null`-defaulted attrs — write `validate: v => v == null || typeof v === "string"`.

## Adding a new mark

If the mark has no required attrs and isn't part of any existing node's content expression in a *required* sense, you don't need migration. Existing docs simply lack the mark. New edits add it. Loading a 6-month-old doc into a schema with a new `highlight` mark Just Works.

The footgun: if you add the mark to a node's `marks: "..."` whitelist that previously was `marks: ""` (no marks allowed), nothing breaks because the whitelist only restricts on *write*. But if you *narrow* the whitelist — `marks: "_"` (all) → `marks: "em strong"` — old docs containing other marks will fail `node.check()`. Narrowing whitelists is a breaking change.

## Removing a node type

The most painful migration. Old docs may contain the node; the new schema can't represent it. Three strategies:

1. **Surrogate replacement.** Walk the JSON tree, replace the doomed type with a fallback:

   ```ts
   function stripLegacyTable(json: any): any {
     if (json.type === "legacy_table") {
       const text = extractText(json)
       return {type: "paragraph", content: [{type: "text", text}]}
     }
     if (json.content) {
       return {...json, content: json.content.map(stripLegacyTable)}
     }
     return json
   }
   ```

   The paragraph-fallback pattern preserves text, drops structure. Acceptable for archive content, lossy for active docs.

2. **Promote children.** If the doomed node was a wrapper, splice its content up:

   ```ts
   if (json.type === "legacy_wrapper") {
     return json.content ?? []  // caller flattens
   }
   ```

   Requires the parent to allow the children directly — verify against the new content expression.

3. **Refuse to load + offer export.** For docs you can't safely migrate, surface a UI: "this document uses an unsupported feature, download as HTML." A defensible product decision when fidelity matters more than universality.

## Renaming a node type

Pure renames (`code_block` → `codeBlock`, no attr changes) are cheap with a pre-`fromJSON` rewrite:

```ts
const RENAME = {code_block: "codeBlock", ordered_list: "orderedList"}

function rewriteNames(json: any): any {
  if (json == null) return json
  const next = {...json}
  if (RENAME[json.type]) next.type = RENAME[json.type]
  if (json.content) next.content = json.content.map(rewriteNames)
  if (json.marks) next.marks = json.marks.map(m => RENAME[m.type] ? {...m, type: RENAME[m.type]} : m)
  return next
}
```

Run this in the migration step before `Node.fromJSON`. Don't try to alias names in the schema itself — PM's `nodes` and `marks` ordered maps don't support aliasing, and the resulting confusion at the step/serializer level isn't worth it.

## Collab implications

Collaboration surfaces schema mismatches in the cruelest way: silently. Two clients running different schema versions exchange steps; a step that touches a node the other client doesn't recognize will either:

- Throw on `Step.fromJSON` if the step's serialized form references unknown types (only for steps that include schema-aware payloads, e.g., `ReplaceStep` with a slice containing a new node).
- *Apply successfully* on a client that has a more permissive schema and produce divergent state — silent fork.

PM has no built-in version negotiation. The defense:

1. **Strict version check on connect.** Both client and server announce `schemaVersion`. The server refuses sessions where versions disagree, or downgrades the canonical doc if all clients are on the older version, or upgrades if all are on the newer one. Mixed versions are not allowed in a single session.

2. **Never deploy schema changes without bumping version and forcing reconnect.** An in-place schema swap in a long-running collab session corrupts the doc.

3. **Lock the wire format.** The collab protocol should ship `{version, schemaVersion, steps}`. The server validates `schemaVersion` matches its expectation before accepting steps. A client running stale code is told to reload.

For products that need to support rolling deploys with mixed clients, the only safe option is to make schema changes *strictly additive and backward-compatible* (new attrs with defaults, new nodes/marks that don't replace old ones) and bump version only on breaking changes that force a coordinated migration window.

## Worked example: heading levels 1–6 → flexible level attr

**Old schema:**

```ts
heading: {
  attrs: {level: {default: 1}},
  content: "inline*",
  toDOM: n => [`h${n.attrs.level}`, 0],
  parseDOM: [1,2,3,4,5,6].map(l => ({tag: `h${l}`, attrs: {level: l}}))
}
```

Suppose product wants level 7+ for nested deep TOCs. Schema unchanged structurally — `level` was already an attr — but rendering needs to change (`<h6>` for any level ≥ 6, with a CSS class encoding the actual level).

**New schema:**

```ts
heading: {
  attrs: {
    level: {default: 1, validate: v => Number.isInteger(v) && v >= 1 && v <= 12}
  },
  content: "inline*",
  toDOM: n => {
    const lvl = n.attrs.level
    const tag = `h${Math.min(lvl, 6)}`
    return [tag, {class: `level-${lvl}`}, 0]
  },
  parseDOM: [
    {tag: "h1", attrs: {level: 1}},
    // ...
    {tag: "h6", getAttrs: el => ({level: parseInt((el as HTMLElement).className.match(/level-(\d+)/)?.[1] ?? "6")})}
  ]
}
```

**Migration:** none required for existing docs — `level` was already there, defaults to 1, validate accepts 1–6. Schema version bumps because rendering changed (third-party readers seeing `<h6 class="level-9">` need to know to interpret `class`). Collab clients on the old code render level 7 as `h6` without the class — not a fork (doc is identical), just a UI regression on stale clients. Acceptable.

The lesson: if you predicted the evolution, the migration is free. If `level` had been six different node types (`h1`, `h2`, ..., `h6`), this same change would have required a full type-renaming migration across every persisted doc.

## Versioning attrs: prefer additive changes

Treat the attrs object as a bag-of-fields with defaults. Rules:

- **Add new attrs with `default`.** Free, backward-compatible.
- **Never remove an attr without a migration that strips it from old JSON** — old docs will pass it to `create`, which silently drops unknown attrs (the spec doesn't error on extras, but `checkAttrs` doesn't know to clean them either). Unused attrs sitting in JSON aren't *wrong* but they bloat storage and confuse downstream consumers.
- **Don't change an attr's semantics in place.** If `width` was a CSS string and now must be a number, introduce `widthPx` and migrate, then drop `width`. The two-phase deploy lets you support both during the transition.
- **Don't change defaults silently.** Old docs that omitted the attr now get the new default — which may be wrong for them. Better: write the old default explicitly during migration, then change the schema default for new docs.
- **Keep validate functions permissive during transitions.** A strict validator combined with a sloppy old data shape causes `checkAttrs` to throw. Loosen, migrate, then tighten in a follow-up release.

The meta-rule: schemas are append-only. Every change you can express as "add a new thing" rather than "change an existing thing" pays back tenfold in operational simplicity. The schema is the contract between every doc your system has ever produced and the code that has to read them.
