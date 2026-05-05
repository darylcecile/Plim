# 32. Security

ProseMirror's architecture pushes most security-relevant decisions to *you*: the
schema you define, the `parseDOM` rules you write, the widget DOM you produce,
and the server that authorities the collab session. The library defends a
handful of well-known XSS surfaces directly, but everything else — sanitization,
CSP, authority validation, rate limiting — is application code. This chapter
maps the attack surface and the mitigations.

## 32.1 Threat model

Before writing any code, decide who can submit content and across which trust
boundary:

| Submitter | Trust | Required mitigation |
|-----------|-------|---------------------|
| Self only (single-user notes) | High | Schema validation; CSP defense-in-depth |
| Authenticated peers (team docs, comments) | Medium | Sanitize on ingest; validate on collab server; audit `toDOM` outputs |
| Anonymous / cross-org (public comments, embeds) | Low | DOMPurify on paste; sandbox iframe; strict CSP; reject `data:`/`javascript:` URLs |
| Imported documents (uploaded JSON, pasted HTML) | Low (treat as hostile) | `Node.check` after `Node.fromJSON`; HTML sanitization before `DOMParser.parseSlice` |

The PM document model is **not** itself a security boundary. A `Node` whose
attrs contain `<script>` strings is structurally valid; the danger is what your
`toDOM` and your server do with it.

## 32.2 XSS surfaces inside ProseMirror

### 32.2.1 `toDOM` returning attacker-controlled `DOMOutputSpec`

The classical exploit: a node's attrs contain a JSON array that, when reflected
into a `toDOM` spec, *becomes* the spec. PM 1.x added an explicit guard. See
`prosemirror-model/src/to_dom.ts:164–191`:

```ts
const suspiciousAttributeCache = new WeakMap<any, readonly any[] | null>()

function suspiciousAttributesInner(attrs) {
  let result = null
  function scan(value) {
    if (value && typeof value == "object") {
      if (Array.isArray(value)) {
        if (typeof value[0] == "string") {
          if (!result) result = []
          result.push(value)            // any [string, ...] reachable through attrs
        } else {
          for (let i = 0; i < value.length; i++) scan(value[i])
        }
      } else {
        for (let prop in value) scan(value[prop])
      }
    }
  }
  scan(attrs)
  return result
}
```

`renderSpec` then checks (`to_dom.ts:204–207`):

```ts
if (blockArraysIn && (suspicious = suspiciousAttributes(blockArraysIn)) &&
    suspicious.indexOf(structure) > -1)
  throw new RangeError("Using an array from an attribute object as a DOM spec. " +
                       "This may be an attempted cross site scripting attack.")
```

What this catches: a `toDOM` implementation like
`toDOM: node => node.attrs.spec` where `spec` was supplied by a peer over the
wire. The `WeakMap` cache makes the scan amortized O(1) per render.

What this does **not** catch: a `toDOM` that splats attrs into HTML attributes
without escaping, e.g. ``toDOM: node => `<div onclick="${node.attrs.x}">` ``
fed through `innerHTML`. PM never builds DOM that way internally — it always
walks the spec array and sets attributes through `setAttribute` — but custom
NodeViews and widget specs that take shortcuts will defeat the guard.

**Rule:** never construct DOM from attribute strings via `innerHTML`. Always
return spec arrays, or build DOM with `createElement` + `setAttribute`.

### 32.2.2 `parseDOM` `getAttrs` callbacks

```ts
parseDOM: [{tag: "a[href]", getAttrs: el => ({href: el.getAttribute("href")})}]
```

Anything `getAttrs` returns lands in the resulting `Mark`/`Node` attrs and is
later re-serialized by `toDOM`. If the schema doesn't filter `javascript:` URLs
here, they survive a paste-and-render round trip.

```ts
getAttrs(el) {
  const href = (el as HTMLAnchorElement).getAttribute("href") || ""
  if (/^\s*(javascript|data|vbscript):/i.test(href)) return false  // reject node
  return {href}
}
```

Returning `false` from `getAttrs` rejects the match; PM tries the next rule or
falls through to a text node.

### 32.2.3 Widget decorations

`Decoration.widget(pos, dom, spec)` accepts a DOM node *built by user code*.
PM inserts that node into the editor verbatim. If the application built that
node via `el.innerHTML = userInput`, the XSS is already on the page before PM
ever sees it. Mitigation:

- Build widgets with `document.createElement` and `textContent`.
- Or sanitize input through DOMPurify (or an equivalent) before constructing
  the node.
- Treat `Decoration.widget` like `dangerouslySetInnerHTML` — it's a sharp
  edge by design (PM doesn't introspect the node).

### 32.2.4 Mark `href` and other URL attributes

The PM basic-schema mark `link` does not filter URLs. Any schema that accepts
`href`, `src`, `srcset`, `poster`, `formaction`, `xlink:href`, `data`, etc.
must validate the scheme on both ingest paths:

1. `parseDOM` → `getAttrs` (paste / loadHTML)
2. `Schema.nodeFromJSON` (network / collab snapshot) — see §32.5

Allowlist schemes (`http`, `https`, `mailto`, relative); reject everything
else.

### 32.2.5 Custom NodeView `dom`

A NodeView returns its own DOM root. That DOM is rendered as-is. Same rule as
widgets: don't `innerHTML` untrusted strings into it.

## 32.3 Trusted Types

When the page enforces `Content-Security-Policy: require-trusted-types-for 'script'`,
any `innerHTML` assignment from a plain string throws `TypeError: This document
requires 'TrustedHTML' assignment`. PM hits this exactly once: when parsing
clipboard HTML.

`prosemirror-view/src/clipboard.ts:212–222`:

```ts
let _policy: any = null

function maybeWrapTrusted(html: string): string {
  let trustedTypes = (window as any).trustedTypes
  if (!trustedTypes) return html
  if (!_policy)
    _policy = trustedTypes.defaultPolicy ||
              trustedTypes.createPolicy("ProseMirrorClipboard", {createHTML: (s: string) => s})
  return _policy.createHTML(html)
}
```

PM's built-in policy is **identity** — it does no sanitization. The reason it
exists at all is to satisfy the browser's Trusted Types check on the detached
document used to parse clipboard HTML. **Hardening means replacing PM's policy
with a sanitizing one before PM creates its own:**

```ts
import DOMPurify from "dompurify"

if ((window as any).trustedTypes && !(window as any).trustedTypes.defaultPolicy) {
  (window as any).trustedTypes.createPolicy("default", {
    createHTML: (s: string) => DOMPurify.sanitize(s, {RETURN_TRUSTED_TYPE: true})
  })
}
```

When `defaultPolicy` is set, PM's `maybeWrapTrusted` will reuse it (the `||`
short-circuit on line 220), so DOMPurify runs on every clipboard paste with no
PM-specific configuration. Alternatively, install a named `ProseMirrorClipboard`
policy *before* PM's first paste — the `_policy = null` cache means PM will
create its own only if none exists.

The `parseDOM` path for clipboard goes:

```
clipboardEvent → readHTML(html) → maybeWrapTrusted → elt.innerHTML = trusted →
  DOMParser walk → Schema.parseDOM rules → Slice
```

Any sanitization layered into the policy runs *before* PM's parser sees the
DOM, which is the right layer: PM's parser already drops unknown tags, but it
will faithfully preserve attributes that match a schema rule.

## 32.4 Content Security Policy

Recommended directives for an app embedding ProseMirror:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'nonce-{RANDOM}';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: https:;
  connect-src 'self' wss://collab.example.com;
  frame-src 'none';
  object-src 'none';
  base-uri 'self';
  require-trusted-types-for 'script';
  trusted-types ProseMirrorClipboard default;
```

Notes:

- `script-src 'self' 'nonce-…'`: no `unsafe-inline`. PM ships no inline
  scripts.
- `style-src`: PM injects a small stylesheet for `ProseMirror-selectednode`
  and `ProseMirror-gapcursor`. With strict CSP, ship those rules in your own
  CSS bundle and drop `'unsafe-inline'`.
- `connect-src`: scope to your collab WebSocket and step endpoints.
- `img-src 'self' data:`: drop `data:` if you don't need pasted base64
  images; otherwise an attacker can DoS the doc with megabyte-sized data
  URLs (also a memory issue, not just security).
- `trusted-types`: declare `ProseMirrorClipboard` (PM's named policy) plus
  `default` if you install the default sanitizer above.

## 32.5 Collab authority validation

**The server is the only place schema validity can be enforced.** A malicious
client can craft a `Step` JSON that, when applied, produces a node with
`type: "image"` and `attrs: {src: "javascript:…"}`. If the server broadcasts
that step to other clients, every viewer is exploited.

Required server-side checks before broadcasting any step:

```ts
const step = Step.fromJSON(schema, json)        // parseable?
const result = step.apply(currentDoc)            // applies cleanly?
if (result.failed) reject()
result.doc.check()                               // schema-valid result? (calls AttributeSpec.validate)
if (clientVersion !== currentVersion) {          // step-fork attack
  rebaseOrReject()
}
```

Additional protections:

- **Version pinning**: refuse steps whose claimed `version` doesn't match the
  server's current version (or perform server-side rebasing); a client that
  manipulates `version` can fork the document.
- **Rate limiting**: a bot can submit thousands of single-character steps per
  second to flood peers. Cap per-user step rate *and* per-second total step
  size.
- **Author identity**: bind every accepted step to the authenticated user
  server-side. Don't trust client-supplied author IDs.
- **Step size cap**: reject steps whose `slice` JSON exceeds N KB; a single
  `ReplaceStep` can carry an arbitrarily large slice.
- **Audit log**: persist accepted steps with `(user, version, timestamp,
  bytes)` for forensic replay.

## 32.6 `AttributeSpec.validate`

`prosemirror-model/src/schema.ts:548–563` defines the security-relevant API
for hardening attrs against attacker JSON:

```ts
export interface AttributeSpec {
  default?: any
  validate?: string | ((value: any) => void)
}
```

`validate` is invoked from two places (schema.ts:46, and `Node.check`):

```ts
if (attr.validate) attr.validate(values[name])
```

Two forms:

```ts
// String form: pipe-separated primitive types
{validate: "string"}
{validate: "string|null"}
{validate: "number|undefined"}

// Function form: throw on invalid
{
  validate(value) {
    if (typeof value !== "string") throw new RangeError("href must be string")
    if (!/^(https?:|mailto:|\/)/.test(value)) throw new RangeError("href: bad scheme")
  }
}
```

The function form is the recommended hardening point for URL-bearing attrs.
It runs on `Node.fromJSON` (collab snapshot ingest, undo serialization) *and*
on `Node.check` (you should call this after assembling a doc from any
untrusted source). Schemas that accept `href`, `src`, `style`, `class` should
all set `validate`.

What `validate` does **not** do: it doesn't run on `parseDOM` ingest. The
`getAttrs` callback is the analogous hook for that path; you typically want
both.

## 32.7 Defense against malicious paste

PM's clipboard parser is a thin wrapper over `DOMParser` plus the schema's
`parseDOM` rules. It will:

- Drop tags with no matching parse rule (so `<script>` typically drops because
  no schema rule matches it).
- Keep attributes that schema rules collect via `getAttrs`.

It does **not** strip event handlers, `<iframe>`, `<object>`, or
`javascript:`/`data:` URLs unless you write that into the schema. For
untrusted paste sources, layer DOMPurify *before* PM via the Trusted Types
default policy (§32.3) or in a `clipboardParser` wrapper:

```ts
new EditorView(node, {
  state,
  clipboardParser: {
    parseSlice(html, opts) {
      const clean = DOMPurify.sanitize(html, {
        FORBID_TAGS: ["script", "iframe", "object", "embed", "form"],
        FORBID_ATTR: ["onerror", "onload", "onclick", /* ... */ ],
      })
      return DOMParser.fromSchema(schema).parseSlice(clean, opts)
    }
  }
})
```

Disallow `data:` URLs in `img`/`iframe` by default in your schema's
`getAttrs`; allow them only on a known-safe shape (e.g. `image/png` with size
caps).

## 32.8 Sandboxing untrusted documents

For embeds that render content from arbitrary third parties (public comment
threads, document previews from unknown senders), don't run them in your
origin at all. Render in an `<iframe sandbox="allow-scripts" srcdoc="…">` on
a separate origin (e.g. `embed.example-usercontent.com`), and `postMessage`
across the boundary. This neutralizes XSS into a same-origin issue scoped to
a throwaway origin and keeps cookies/localStorage for the main app
inaccessible.

Cross-origin paste: the browser already blocks reading the system clipboard
without a user gesture and a focused editable element. PM doesn't bypass
that — its paste handler runs from the synthetic `paste` event. Don't add
asynchronous `navigator.clipboard.readText()` code paths unless the user
explicitly asked for them.

## 32.9 Document upload integrity

When accepting a JSON document from the network (collab snapshot, import,
saved draft):

```ts
let doc
try {
  doc = Node.fromJSON(schema, json)
  doc.check()                         // walks tree, runs AttributeSpec.validate
} catch (e) {
  return reject("invalid document")
}
```

`Node.fromJSON` validates *structure* (right node types, valid content
expressions). `Node.check` additionally runs `AttributeSpec.validate` on
every attr. Run both. Never trust a JSON shape because it parsed.

For collab specifically: the server should call `step.apply(doc)` and
re-`check()` the resulting doc. A client may submit a step that is
structurally a valid `Step` but produces a doc with attrs that fail
`validate`; only `check()` after `apply()` catches that.

## 32.10 Logging hygiene

Don't log raw doc JSON to a server logger in production. Documents contain:

- Free-form user text (PII, secrets pasted by accident).
- Image/file URLs that may be presigned with credentials in the query string.
- Comments and selections that reveal user intent.

If you need observability, log step *types* and counts, doc size, and event
timing — not contents. For incident replay, persist docs to your encrypted
primary store, not to ephemeral logs.

## 32.11 Threat model checklist

Use this when shipping a PM-based feature:

- [ ] Who submits content? (self / authed peers / anonymous)
- [ ] Trust boundary between submitter and reader?
- [ ] Every URL-bearing attr has `validate` (model-level) **and** `getAttrs`
      filter (paste-level)?
- [ ] No widget/NodeView builds DOM from `innerHTML`?
- [ ] `toDOM` never reflects a raw spec array out of attrs?
- [ ] Trusted Types default policy installed with DOMPurify?
- [ ] CSP forbids `unsafe-inline` script; defines `trusted-types`?
- [ ] Collab server runs `Step.fromJSON` → `apply` → `check` on every step?
- [ ] Collab server pins versions and rate-limits per user?
- [ ] Step size cap?
- [ ] Anonymous/public content rendered in a sandbox iframe on a separate
      origin?
- [ ] Doc JSON is *not* in production logs?
