# 31 — Plugin Cookbook: Patterns and Idioms

This file collects battle-tested ProseMirror plugin patterns. Each recipe shows
the minimal viable implementation, design rationale, and the pitfalls people hit
when they implement these for the first time.

The mental model to keep in mind throughout:

- A **plugin** is configuration — it owns plugin state, prop callbacks, and an
  optional `view`/`PluginView`.
- Plugin state is updated **only** in `apply(tr, prevState, oldEditorState, newEditorState)`.
- The DOM-aware part lives in the `view` — it gets `update(view, prevState)`
  callbacks every time the editor state changes, and a `destroy` hook.
- Decorations are the cheap, non-destructive way to overlay UI; **never** mutate
  the document for a purely visual concern.

---

## 1. Placeholder Plugin (empty-doc hint)

Render greyed-out hint text (`"Type something…"`) when the doc is empty.

```ts
import { Plugin } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

export function placeholder(text: string) {
  return new Plugin({
    props: {
      decorations(state) {
        const { doc } = state;
        const isEmpty =
          doc.childCount === 1 &&
          doc.firstChild!.isTextblock &&
          doc.firstChild!.content.size === 0;

        if (!isEmpty) return null;

        const placeholderEl = document.createElement("span");
        placeholderEl.className = "ProseMirror-placeholder";
        placeholderEl.textContent = text;
        // Critical: contenteditable=false so it doesn't accept caret.
        placeholderEl.contentEditable = "false";

        // side: 1 → widget rendered AFTER the position; the cursor sits
        // BEFORE it, which is what we want for a placeholder.
        return DecorationSet.create(doc, [
          Decoration.widget(1, placeholderEl, { side: 1 }),
        ]);
      },
    },
  });
}
```

**Design choices**

- We compute decorations directly inside `props.decorations` (no plugin state)
  because emptiness is cheap to test and ProseMirror caches the props result by
  identity reference of `state`.
- Position `1` is the start of the first textblock. For a custom doc schema
  (e.g. starts with a heading) compute it dynamically via `doc.resolve(0)`.
- `side: 1` tells ProseMirror the widget *comes after* the position — so the
  caret stays to the left of the placeholder, which is required for typing to
  feel natural.

**Pitfalls**

- Forgetting `contenteditable=false` makes the browser try to put the caret
  *inside* the widget — typing produces split text nodes the DOMObserver
  can't reconcile.
- CSS `display: inline-block; pointer-events: none` is recommended; otherwise
  clicks on the placeholder steal focus and produce odd selections.
- Don't use `Decoration.inline` here — there is no content to decorate.

---

## 2. Mention / Autocomplete (`@`-trigger)

A plugin that watches the selection, opens a suggestion popup when the user
types `@`, lets them arrow through results, and inserts a mention on Enter.

```ts
import { Plugin, PluginKey, EditorState, Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

type MentionState =
  | { active: false }
  | { active: true; range: { from: number; to: number }; query: string };

const key = new PluginKey<MentionState>("mention");

function detect(state: EditorState): MentionState {
  const { $from } = state.selection;
  if (!state.selection.empty) return { active: false };

  // Look back from cursor to find @ in current text node.
  const textBefore = $from.parent.textBetween(
    Math.max(0, $from.parentOffset - 60),
    $from.parentOffset,
    null,
    "\ufffc",
  );
  const m = /(?:^|\s)@(\w*)$/.exec(textBefore);
  if (!m) return { active: false };

  const from = $from.pos - m[1].length - 1; // include the '@'
  return { active: true, range: { from, to: $from.pos }, query: m[1] };
}

export const mention = new Plugin<MentionState>({
  key,
  state: {
    init: () => ({ active: false }),
    apply(tr, prev, _old, newState) {
      // Recompute when doc or selection changes; otherwise reuse.
      if (!tr.docChanged && !tr.selectionSet) return prev;
      return detect(newState);
    },
  },
  props: {
    handleKeyDown(view, event) {
      const s = key.getState(view.state);
      if (!s?.active) return false;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        suggester.move(event.key === "ArrowDown" ? 1 : -1);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const choice = suggester.current();
        if (!choice) return false;
        commitMention(view, s.range, choice);
        return true;
      }
      if (event.key === "Escape") {
        suggester.hide();
        return true;
      }
      return false;
    },
  },
  view(view) {
    return new MentionView(view);
  },
});

class MentionView {
  dom: HTMLDivElement;
  constructor(private view: EditorView) {
    this.dom = document.createElement("div");
    this.dom.className = "mention-popup";
    document.body.appendChild(this.dom);
    this.update(view);
  }
  update(view: EditorView) {
    const s = key.getState(view.state);
    if (!s?.active) {
      this.dom.style.display = "none";
      return;
    }
    const coords = view.coordsAtPos(s.range.from);
    this.dom.style.display = "block";
    this.dom.style.top = `${coords.bottom}px`;
    this.dom.style.left = `${coords.left}px`;
    suggester.render(this.dom, s.query);
  }
  destroy() {
    this.dom.remove();
  }
}

function commitMention(
  view: EditorView,
  range: { from: number; to: number },
  choice: { id: string; label: string },
) {
  const node = view.state.schema.nodes.mention.create({
    id: choice.id,
    label: choice.label,
  });
  const tr = view.state.tr.replaceRangeWith(range.from, range.to, node);
  view.dispatch(tr.insertText(" ").scrollIntoView());
}
```

**Design choices**

- The plugin **state machine** has only two shapes (`active: false` or
  `active: true` with a range). Keeping all derived data — query string,
  insertion range — in plugin state means the `view` only renders, it never
  recomputes from `view.state` ad hoc.
- Detection runs in `apply`, not in a DOM event listener. This guarantees the
  state is correct after collab transforms or programmatic edits, not just
  after typing.
- Range is computed against `parentOffset` so it survives mapping through
  subsequent transactions (you should still map it if you delay insertion).

**Pitfalls**

- Using `view.state.doc.textBetween(...)` over the full doc is slow on large
  documents. Always scope to the current textblock.
- If you store the *DOM* of the popup in plugin state, you've leaked the view
  into state. Plugin state must be JSON-serializable for collab/history; keep
  it pure data.
- Fire commands via `view.dispatch`, not by mutating the DOM. Otherwise the
  DOMObserver will fight you.

---

## 3. Decorations-as-Cache (spell check, syntax highlight)

Expensive per-document analysis (spell check, regex highlight, AST coloring)
should be computed once in `apply` and stored in plugin state as a
`DecorationSet`. The set is *mappable* — you don't recompute on every keystroke.

```ts
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

const key = new PluginKey<DecorationSet>("spellcheck");

export const spellcheck = new Plugin<DecorationSet>({
  key,
  state: {
    init: (_, state) => buildDecos(state.doc),
    apply(tr, set, _old, newState) {
      if (!tr.docChanged) return set;

      // Cheap path: map existing decorations through the step.
      let mapped = set.map(tr.mapping, tr.doc);

      // Then incrementally re-run analysis on dirty ranges.
      const dirty: Array<[number, number]> = [];
      tr.mapping.maps.forEach((stepMap) => {
        stepMap.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
          dirty.push([newStart, newEnd]);
        });
      });

      // Remove decorations inside dirty ranges, then add freshly computed ones.
      for (const [from, to] of dirty) {
        const inRange = mapped.find(from, to);
        mapped = mapped.remove(inRange);
        mapped = mapped.add(newState.doc, analyzeRange(newState.doc, from, to));
      }
      return mapped;
    },
  },
  props: {
    decorations(state) {
      return key.getState(state);
    },
  },
});

function buildDecos(doc: any): DecorationSet {
  return DecorationSet.create(doc, analyzeRange(doc, 0, doc.content.size));
}

function analyzeRange(doc: any, from: number, to: number): Decoration[] {
  const out: Decoration[] = [];
  doc.nodesBetween(from, to, (node: any, pos: number) => {
    if (!node.isText) return;
    for (const m of node.text.matchAll(/\b\w{20,}\b/g)) {
      out.push(
        Decoration.inline(pos + m.index!, pos + m.index! + m[0].length, {
          class: "spell-error",
        }),
      );
    }
  });
  return out;
}
```

**Design choices**

- `DecorationSet.map` is O(log n) per decoration; mapping the whole set on
  every transaction is fine for tens of thousands of decorations.
- Recomputing only inside `tr.mapping.maps[*]`'s changed ranges lets you do
  large docs cheaply.
- For **truly** expensive work (real spell check, syntax via tree-sitter), put
  the analysis in `view`'s `update` and use `requestIdleCallback` — store the
  raw AST in plugin state and only build the `DecorationSet` lazily.

**Pitfalls**

- Forgetting to call `set.map(tr.mapping, tr.doc)` makes decorations point at
  stale positions and they render in the wrong place after any edit.
- Using `Decoration.inline` across a node boundary is a no-op above the
  leaf level; iterate text nodes specifically.
- `DecorationSet.create(doc, [])` is O(n) over the doc tree — call it once at
  init, not on every keystroke.

---

## 4. Async Fetch + Replace

You need to insert content that depends on a network call (oEmbed, AI
completion, image URL). The pattern: insert a placeholder *atom* + decoration,
do the fetch, dispatch a replace transaction that uses the mapping to find
where the placeholder ended up.

```ts
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

const key = new PluginKey("asyncReplace");

interface Pending {
  id: string;
  pos: number;
}

const plugin = new Plugin<{ set: DecorationSet }>({
  key,
  state: {
    init: () => ({ set: DecorationSet.empty }),
    apply(tr, prev) {
      let set = prev.set.map(tr.mapping, tr.doc);
      const meta = tr.getMeta(key) as
        | { add?: Pending; remove?: string }
        | undefined;
      if (meta?.add) {
        const widget = document.createElement("span");
        widget.className = "loading-spinner";
        widget.textContent = "…";
        set = set.add(tr.doc, [
          Decoration.widget(meta.add.pos, widget, { id: meta.add.id }),
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

export function asyncInsert(view: EditorView, fetcher: () => Promise<string>) {
  const id = crypto.randomUUID();
  const pos = view.state.selection.from;

  view.dispatch(view.state.tr.setMeta(key, { add: { id, pos } }));

  fetcher().then((html) => {
    // Find the decoration's *current* position via the plugin state.
    const set = key.getState(view.state)!.set;
    const deco = set.find(undefined, undefined, (s) => s.id === id)[0];
    if (!deco) return; // user removed it / undid

    const tr = view.state.tr;
    const slice = parseHTML(view.state.schema, html);
    tr.replaceWith(deco.from, deco.from, slice);
    tr.setMeta(key, { remove: id });
    view.dispatch(tr);
  });
}
```

**Pitfalls**

- Capturing `view.state` at fetch start and using it on resolve → stale state.
  Always reread `view.state` inside the `.then`.
- Storing the original `pos` in a closure → wrong after the user types. Use the
  `DecorationSet.find` round-trip (plugin state has been mapped through every
  transaction since).
- Not handling `deco === undefined` → the user undid the placeholder, you'd
  insert into a random position.

See `37-async-transactions.md` for a deep dive on race conditions and patterns.

---

## 5. Collab Cursor / Presence

Render remote peers' cursors as carets with name flags. Peer state arrives
over the network; you ingest via `tr.setMeta` and convert to decorations.

```ts
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

const key = new PluginKey("presence");

interface Peer {
  id: string;
  name: string;
  color: string;
  anchor: number;
  head: number;
}

export const presence = new Plugin<{ peers: Map<string, Peer>; set: DecorationSet }>({
  key,
  state: {
    init: () => ({ peers: new Map(), set: DecorationSet.empty }),
    apply(tr, prev, _old, newState) {
      const peers = new Map(prev.peers);
      const update = tr.getMeta(key) as { peer?: Peer; remove?: string } | undefined;

      // Map existing peer positions through doc changes.
      for (const [id, p] of peers) {
        peers.set(id, {
          ...p,
          anchor: tr.mapping.map(p.anchor),
          head: tr.mapping.map(p.head),
        });
      }
      if (update?.peer) peers.set(update.peer.id, update.peer);
      if (update?.remove) peers.delete(update.remove);

      const decos: Decoration[] = [];
      for (const p of peers.values()) {
        const flag = document.createElement("span");
        flag.className = "presence-caret";
        flag.style.borderLeftColor = p.color;
        const label = document.createElement("span");
        label.className = "presence-label";
        label.style.background = p.color;
        label.textContent = p.name;
        flag.appendChild(label);
        decos.push(Decoration.widget(p.head, flag, { side: 1, key: p.id }));

        if (p.anchor !== p.head) {
          const [from, to] = p.anchor < p.head ? [p.anchor, p.head] : [p.head, p.anchor];
          decos.push(
            Decoration.inline(from, to, {
              style: `background:${p.color}33`,
            }, { key: `${p.id}-sel` }),
          );
        }
      }
      return { peers, set: DecorationSet.create(newState.doc, decos) };
    },
  },
  props: {
    decorations: (state) => key.getState(state)!.set,
  },
});
```

**Design choices**

- The widget `key` option is critical — without it, ProseMirror tears down and
  rebuilds the caret DOM on every transaction, causing flicker.
- We map peer positions through `tr.mapping` so remote carets stay in the right
  place even when the local user edits.
- `side: 1` keeps remote carets stable when text is inserted at their head.

**Pitfalls**

- Building decorations from scratch in `apply` is fine for ≤50 peers; for
  larger collab sessions, only rebuild the changed peer's decoration.
- Don't forget to remove peers on disconnect (`update.remove`); orphaned carets
  pile up and confuse users.

---

## 6. Word Count Plugin (minimal)

```ts
const key = new PluginKey<{ words: number }>("wordcount");

export const wordcount = new Plugin<{ words: number }>({
  key,
  state: {
    init: (_, state) => ({ words: count(state.doc) }),
    apply: (tr, prev, _, newState) =>
      tr.docChanged ? { words: count(newState.doc) } : prev,
  },
});

function count(doc: any): number {
  let words = 0;
  doc.descendants((node: any) => {
    if (node.isText) {
      words += node.text.trim().split(/\s+/).filter(Boolean).length;
    }
  });
  return words;
}

// Read from outside: key.getState(view.state)!.words
```

For very large docs (>50k words), debounce the recount with a `view` plugin
that schedules a `requestIdleCallback`.

---

## 7. Custom NodeView with React

Render a complex node (e.g. callout, code block with language picker) using
React, while still letting ProseMirror manage the editable inner content.

```tsx
import { Node } from "prosemirror-model";
import { EditorView, NodeView } from "prosemirror-view";
import { createRoot, Root } from "react-dom/client";

class CalloutView implements NodeView {
  dom: HTMLDivElement;
  contentDOM: HTMLDivElement;
  private root: Root;

  constructor(
    private node: Node,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    this.dom = document.createElement("div");
    this.dom.className = "callout-shell";
    this.contentDOM = document.createElement("div");
    this.contentDOM.className = "callout-content";

    this.root = createRoot(this.dom);
    this.render();
  }

  private render() {
    this.root.render(
      <CalloutChrome
        kind={this.node.attrs.kind}
        onChange={(kind) => {
          const pos = this.getPos();
          if (pos == null) return;
          this.view.dispatch(
            this.view.state.tr.setNodeMarkup(pos, undefined, {
              ...this.node.attrs,
              kind,
            }),
          );
        }}
        contentRef={(el) => el?.appendChild(this.contentDOM)}
      />,
    );
  }

  update(node: Node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  // PM should not interpret React's DOM mutations as content changes.
  ignoreMutation(m: MutationRecord) {
    // Allow mutations to the contentDOM (PM-managed); ignore the rest.
    return !this.contentDOM.contains(m.target as Node);
  }

  // Don't let click in chrome become a selection inside contentDOM.
  stopEvent(event: Event) {
    return !this.contentDOM.contains(event.target as Node);
  }

  destroy() {
    // React 18 unmount must be queued — PM destroys synchronously.
    queueMicrotask(() => this.root.unmount());
  }
}
```

**Design choices**

- `contentDOM` is the PM-managed region; React renders **around** it but mounts
  it via a callback ref, never owns it.
- `ignoreMutation` returning `true` for chrome means React re-renders don't
  trigger DOMObserver re-parsing.
- `update()` returns true *only if* the node type matches; otherwise PM
  recreates the NodeView, which you want for type changes.

**Pitfalls**

- Re-creating the React root on every `update` will leak. Reuse `this.root`.
- Calling `root.unmount()` synchronously inside `destroy` triggers a React 18
  warning ("Attempted to synchronously unmount a root while React was already
  rendering"). Queue it.
- Letting React render content that overlaps `contentDOM` (e.g. portals) makes
  the DOMObserver report the React content as edits — restrict React output to
  chrome only.

---

## 8. Embed (iframe) Atom NodeView

For atom nodes (no editable content): YouTube embed, Tweet, file widget.

```ts
class EmbedView implements NodeView {
  dom: HTMLDivElement;
  // No contentDOM → atom node.

  constructor(node: Node) {
    this.dom = document.createElement("div");
    this.dom.className = "embed";
    const iframe = document.createElement("iframe");
    iframe.src = node.attrs.src;
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
    this.dom.appendChild(iframe);
  }

  // The iframe's DOM is opaque to PM.
  ignoreMutation() {
    return true;
  }

  // Don't let clicks inside the iframe try to set a selection.
  stopEvent() {
    return true;
  }

  // Atom nodes don't update their innards from PM's perspective; allow
  // recreation if attrs change meaningfully.
  update(newNode: Node) {
    return newNode.attrs.src === (this.dom.firstChild as HTMLIFrameElement).src;
  }
}
```

**Pitfalls**

- Forgetting `stopEvent: () => true` lets a click inside the iframe place the
  caret *adjacent* to the embed — confusing.
- If the iframe needs to resize, do it via `attrs.height` set by a transaction,
  not direct DOM mutation.

---

## 9. Read-only Toggle via Plugin

```ts
const readonlyKey = new PluginKey<{ enabled: boolean }>("readonly");

export const readonly = new Plugin<{ enabled: boolean }>({
  key: readonlyKey,
  state: {
    init: () => ({ enabled: false }),
    apply(tr, prev) {
      const meta = tr.getMeta(readonlyKey) as { enabled: boolean } | undefined;
      return meta ?? prev;
    },
  },
  props: {
    editable: (state) => !readonlyKey.getState(state)!.enabled,
  },
});

// Toggle:
view.dispatch(view.state.tr.setMeta(readonlyKey, { enabled: true }));
```

The `editable` prop is consulted on every state change; PM toggles
`contenteditable` accordingly. No DOM mutation by you.

---

## 10. Linkify on Paste

```ts
const URL_RE = /https?:\/\/[^\s<>"]+/g;

export const linkifyPaste = new Plugin({
  props: {
    handlePaste(view, event, slice) {
      const text = event.clipboardData?.getData("text/plain");
      if (!text || !URL_RE.test(text)) return false;

      // Only act on paste of *plain text* with a URL.
      if (event.clipboardData?.types.includes("text/html")) return false;

      const link = view.state.schema.marks.link;
      if (!link) return false;

      let pos = view.state.selection.from;
      const tr = view.state.tr.replaceSelectionWith(
        view.state.schema.text(text, [link.create({ href: text })]),
        false,
      );
      view.dispatch(tr.scrollIntoView());
      return true;
    },
  },
});
```

**Pitfalls**

- Returning `true` always swallows paste — only do it when you've handled.
- Don't auto-linkify text containing both URL and other text without splitting
  into multiple text nodes; users find it surprising.

---

## 11. Smart Input Rules

Beyond the standard quote rule:

```ts
import { InputRule, inputRules } from "prosemirror-inputrules";

const enDash = new InputRule(/--$/, "–");
const emDash = new InputRule(/–-$/, "—"); // typing `---` produces — via two steps
const ellipsis = new InputRule(/\.\.\.$/, "…");

const localeQuotes = (locale: "en" | "de" | "fr") => {
  const open = locale === "de" ? "„" : locale === "fr" ? "« " : "“";
  const close = locale === "de" ? "“" : locale === "fr" ? " »" : "”";
  return [
    new InputRule(/(?:^|[\s\(])(")$/, (state, match, start, end) => {
      return state.tr.replaceWith(end - 1, end, state.schema.text(open));
    }),
    new InputRule(/"$/, close),
  ];
};

export const smartRules = (locale: "en" | "de" | "fr") =>
  inputRules({ rules: [enDash, emDash, ellipsis, ...localeQuotes(locale)] });
```

**Pitfalls**

- Don't make rules that match cross-block boundaries — input rules only see
  the current textblock.
- Be careful with rules that fire on `space` — they collide with markdown-style
  rules (`# ` for heading) if patterns overlap.

---

## 12. Cursor Parking (block invalid caret positions)

Some schemas have positions where the caret is technically valid but visually
broken (e.g. between two atom embeds with no textblock between them). A plugin
can detect and snap.

```ts
export const cursorParking = new Plugin({
  appendTransaction(_, oldState, newState) {
    const { $from } = newState.selection;
    if (!newState.selection.empty) return null;
    if (!$from.parent.isTextblock) {
      // We're in a non-textblock context — find nearest textblock.
      let pos = $from.pos;
      const tr = newState.tr;
      const next = newState.doc.resolve(Math.min(pos + 1, newState.doc.content.size));
      if (next.parent.isTextblock) {
        return tr.setSelection(TextSelection.create(tr.doc, next.pos));
      }
    }
    return null;
  },
});
```

**Design choices**

- `appendTransaction` is the right hook — it fires *after* the user transaction
  but is part of the same atomic state update, so the caret never visibly
  appears in the bad spot.

**Pitfalls**

- Don't `appendTransaction` unconditionally; you can create infinite loops if
  two plugins both correct each other.
- Returning `null` is the no-op signal; returning the unchanged transaction is
  also fine but more work.

---

## 13. Outline / Minimap Plugin

Build a side panel listing headings. Recompute on doc change.

```ts
interface Heading { level: number; text: string; pos: number }

const outlineKey = new PluginKey<{ headings: Heading[] }>("outline");

export const outline = new Plugin<{ headings: Heading[] }>({
  key: outlineKey,
  state: {
    init: (_, state) => ({ headings: extract(state.doc) }),
    apply(tr, prev, _o, newState) {
      return tr.docChanged ? { headings: extract(newState.doc) } : prev;
    },
  },
  view(view) {
    const panel = document.createElement("ul");
    panel.className = "outline-panel";
    document.querySelector("#sidebar")!.appendChild(panel);

    const render = () => {
      const { headings } = outlineKey.getState(view.state)!;
      panel.innerHTML = "";
      for (const h of headings) {
        const li = document.createElement("li");
        li.style.paddingLeft = `${h.level * 12}px`;
        li.textContent = h.text;
        li.addEventListener("click", () => {
          view.dispatch(
            view.state.tr
              .setSelection(TextSelection.create(view.state.doc, h.pos + 1))
              .scrollIntoView(),
          );
          view.focus();
        });
        panel.appendChild(li);
      }
    };
    render();
    return {
      update: render,
      destroy: () => panel.remove(),
    };
  },
});

function extract(doc: any): Heading[] {
  const out: Heading[] = [];
  doc.descendants((node: any, pos: number) => {
    if (node.type.name === "heading") {
      out.push({ level: node.attrs.level, text: node.textContent, pos });
    }
  });
  return out;
}
```

**Pitfalls**

- Recomputing the entire outline on every keystroke is fine up to ~10k nodes;
  beyond that, diff against `prev.headings` and only re-render changed entries.
- Listening for clicks on the panel requires `view.focus()` after dispatch,
  otherwise the caret blinks but typing goes to the panel.

---

## 14. Hover Toolbar (floating selection menu)

```ts
class HoverToolbarView {
  dom: HTMLDivElement;
  constructor(private view: EditorView) {
    this.dom = document.createElement("div");
    this.dom.className = "hover-toolbar";
    this.dom.innerHTML = `
      <button data-cmd="bold"><b>B</b></button>
      <button data-cmd="italic"><i>I</i></button>
      <button data-cmd="link">🔗</button>
    `;
    document.body.appendChild(this.dom);
    this.dom.addEventListener("mousedown", this.onClick);
    this.update(view);
  }

  private onClick = (e: MouseEvent) => {
    e.preventDefault(); // keep editor focus
    const cmd = (e.target as HTMLElement).closest("[data-cmd]")?.getAttribute("data-cmd");
    if (cmd === "bold") toggleMark(this.view.state.schema.marks.strong)(this.view.state, this.view.dispatch);
    if (cmd === "italic") toggleMark(this.view.state.schema.marks.em)(this.view.state, this.view.dispatch);
    this.view.focus();
  };

  update(view: EditorView) {
    const { from, to, empty } = view.state.selection;
    if (empty) {
      this.dom.style.display = "none";
      return;
    }
    const start = view.coordsAtPos(from);
    const end = view.coordsAtPos(to);
    const left = (start.left + end.left) / 2;
    const top = start.top - 40;
    this.dom.style.display = "block";
    this.dom.style.left = `${left}px`;
    this.dom.style.top = `${top}px`;
  }

  destroy() {
    this.dom.removeEventListener("mousedown", this.onClick);
    this.dom.remove();
  }
}

export const hoverToolbar = new Plugin({
  view: (view) => new HoverToolbarView(view),
});
```

**Pitfalls**

- `mousedown` with `preventDefault` is required — `click` fires after the
  editor has lost selection, and using `click` makes commands operate on the
  wrong range.
- Don't read `view.state.selection` in a `setTimeout` — by the time the
  callback fires, the user may have selected something else.
- `view.coordsAtPos` returns viewport-relative coords. If your toolbar is
  inside a scroll container, adjust for the container's `getBoundingClientRect`.

---

## Cross-cutting Idioms

1. **Always carry your handle in plugin state**, not in DOM attributes — DOM
   attributes won't survive collab/replace transactions.
2. **Map positions through `tr.mapping`** when storing them; never store raw
   numbers across transactions.
3. **Use `appendTransaction` for invariant enforcement**, `apply` for state
   derivation, and `view.update` for DOM rendering. Mixing the layers is the
   #1 source of subtle bugs.
4. **Plugin keys are mandatory** any time another plugin or external code might
   want to read your state. They make state lookup O(1) and avoid order-
   dependence issues.
5. **Test plugins against collab transactions**: dispatch transactions whose
   `docChanged` is true but whose `getMeta(yourKey)` is undefined — your
   `apply` should still produce sensible state.
