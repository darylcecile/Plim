# Plim Architecture — Actions & Triggers

> Status: **Authoritative spec, design phase**. Direct expansion of the `registeredActions` API in `api-wishlist.md` (§ Editor API) and the Action vs Plugin separation in `00-overview.md` §4.
>
> Cross-links:
> - `02-view-and-dom.md` — `EditorView.handleKeyDown` / `handleBeforeInput` / `handleClipboardEvent` route raw events into the `ActionRouter` defined here.
> - `04-input-and-paste.md` — input rules and paste rules are **plugins**, not actions; they consume `Transaction`s on the way in. Actions sit one layer above and are user-facing.
> - `05-extensions.md` — extensions register actions via `registeredActions` exactly like the wishlist's top-level form.
> - `06-history-and-snapshots.md` — `undo`/`redo` are themselves actions; their `perform` calls into `ctx.getHistory()`.

This document is normative. Anything ambiguous in `api-wishlist.md` is resolved here.

---

## Table of contents

- [A. `defineAction`](#a-defineaction)
- [B. The `triggers` namespace](#b-the-triggers-namespace)
- [C. `ActionContext` (`ctx`)](#c-actioncontext-ctx)
- [D. `ReadOnlyState` (`state`)](#d-readonlystate-state)
- [E. Validation rules](#e-validation-rules)
- [F. Cancellation flow](#f-cancellation-flow)
- [G. Priority & conflict resolution](#g-priority--conflict-resolution)
- [H. Async event bus](#h-async-event-bus)
- [I. Built-in actions catalog](#i-built-in-actions-catalog)
- [J. Action registry & lookup](#j-action-registry--lookup)
- [K. Testing](#k-testing)
- [L. Migration mapping](#l-migration-mapping-from-packagesinputsrc)

---

## A. `defineAction`

`defineAction` is the only way to author an action. It is a tiny, type-preserving factory.

```ts
// @plim/core
export function defineAction<TName extends string>(
  name: TName,
  opts: ActionDef
): Action<TName>;

export interface ActionDef {
  /**
   * One trigger or an array of triggers. The action fires when ANY trigger
   * matches and validation passes. Triggers are produced by the `triggers`
   * namespace — see § B.
   */
  trigger: Trigger | Trigger[];

  /**
   * Optional declarative gate evaluated AFTER the trigger matches.
   * Returns a `ValidationRule` built from the supplied builders. The action
   * is skipped when the rule's `evaluate(state, event)` returns false.
   * Default: no gate (always passes).
   */
  triggerValidationRules?: (builders: ValidationRuleBuilders) => ValidationRule;

  /**
   * While the action's `perform` promise is unresolved, any of these triggers
   * matching causes `ctx.signal` to abort and the action to be marked
   * cancelled. Default: `[]` (no cancellation; action runs to completion).
   */
  cancellationTriggers?: Trigger[];

  /**
   * Conflict-resolution priority. Higher wins. Default: 0.
   * Built-in actions ship with priority 0; user code can raise to override.
   */
  priority?: number;

  /**
   * Body of the action. Sync or async. Receives a frozen state view and the
   * action context. Return value is forwarded to callers of `runAction`;
   * `undefined`/`void` is fine.
   */
  perform: (state: ReadOnlyState, ctx: ActionContext) => Promise<unknown> | unknown;
}

export interface Action<TName extends string = string> {
  readonly name: TName;
  readonly triggers: readonly Trigger[];     // normalised array form
  readonly priority: number;                  // resolved (default 0)
  readonly cancellationTriggers: readonly Trigger[];
  readonly hasValidation: boolean;
  /** internal */ readonly __def: ActionDef;
}
```

`defineAction` is pure: it normalises `trigger` into a `readonly Trigger[]`, fills in defaults, freezes the result, and returns an `Action`. It does not mount anything; mounting happens when the action is passed to `PlimDriver`'s `registeredActions` (or returned from a `defineExtension`).

### Worked example — `bold` (sync, transaction-only)

```ts
import { defineAction, triggers } from '@plim/core';

export const bold = defineAction('bold', {
  trigger: triggers.keyboard.shortcut('Mod+b'),
  triggerValidationRules: ({ and }) => and([
    'selectionNotEmpty',
    'blockSupportsDecoration',
  ]),
  perform: (state, ctx) => {
    const { from, to } = state.selection;
    ctx.createTransaction()
      .toggleMark('bold', { from, to })
      .commit();
  },
});
```

This is sync — `perform` returns `undefined`. No cancellation is possible because the action settles before the next event loop turn.

---

## B. The `triggers` namespace

A `Trigger` is the contract between raw browser events and the `ActionRouter`. Every trigger exposes a `kind` (used for O(1) bucketing — see § J) and a `match` method.

```ts
export type TriggerKind =
  | 'keyboard.shortcut'
  | 'keyboard.key'
  | 'keyboard.character'
  | 'keyboard.sequence'
  | 'clipboard'
  | 'dom'
  | 'editor'
  | 'action.afterCommit';

export interface MatchResult {
  /** capture data exposed to `perform` via `ctx.getMatchData()` */
  readonly data?: Readonly<Record<string, unknown>>;
  /** if true, `event.preventDefault()` will NOT be called automatically */
  readonly allowDefault?: boolean;
}

export interface Trigger {
  readonly kind: TriggerKind;
  /** stable string used for routing-bucket key */
  readonly bucket: string;
  /**
   * Pure matcher. Returns null if not a match. The `event` is whatever the
   * source pipeline produced (KeyboardEvent, ClipboardEvent, InternalEditorEvent…).
   * `state` is the same `ReadOnlyState` that `perform` would receive.
   */
  match(event: PlimRawEvent, state: ReadOnlyState): MatchResult | null;
}

export type PlimRawEvent =
  | { type: 'keydown'; key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; isComposing: boolean; raw: KeyboardEvent }
  | { type: 'beforeinput'; inputType: string; data: string | null; isComposing: boolean; raw: InputEvent }
  | { type: 'clipboard'; action: 'cut' | 'copy' | 'paste'; clipboardData: DataTransfer | null; raw: ClipboardEvent }
  | { type: 'dom'; eventName: string; raw: Event }
  | { type: 'editor'; eventName: 'selectionChange' | 'transaction' | 'ready'; payload?: unknown }
  | { type: 'action.afterCommit'; actionName: string; result: unknown };
```

### B.1 `triggers.keyboard.shortcut(combo)`

```ts
triggers.keyboard.shortcut(combo: string): Trigger;
```

- `combo` is a `+`-separated string of modifiers and a single key, in any order.
- Recognised modifiers: `Mod`, `Cmd`, `Meta`, `Ctrl`, `Control`, `Alt`, `Option`, `Shift`.
- `Mod` normalises to `Meta` on macOS/iPadOS (detected via `navigator.platform` / `userAgentData`) and to `Ctrl` everywhere else. This is decided once per `EditorView`.
- Key part is case-insensitive (`b` ≡ `B`); `Shift+B` is canonical when shift is meant.
- Multiple modifier aliases collapse: `Cmd+Ctrl+b` is invalid (will throw at registration).
- Matches `keydown` only. Does not match `keypress`. Does not match if `isComposing` is true.

```ts
// Implementation sketch
function shortcut(combo: string): Trigger {
  const parsed = parseCombo(combo); // { mods: Set<'meta'|'ctrl'|'alt'|'shift'>, key: string }
  const normalised = normaliseModForPlatform(parsed); // Mod -> meta or ctrl
  const bucket = comboToBucket(normalised); // e.g. "meta+b"
  return {
    kind: 'keyboard.shortcut',
    bucket,
    match(ev) {
      if (ev.type !== 'keydown' || ev.isComposing) return null;
      return matchesChord(ev, normalised) ? {} : null;
    },
  };
}
```

### B.2 `triggers.keyboard.key(key)`

```ts
type KeyName =
  | 'Escape' | 'Enter' | 'Tab' | 'Backspace' | 'Delete' | 'Space'
  | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'
  | 'Home' | 'End' | 'PageUp' | 'PageDown'
  | `F${1|2|3|4|5|6|7|8|9|10|11|12}`;

triggers.keyboard.key(key: KeyName): Trigger;
```

Bare key (no modifiers required, no modifiers forbidden — modifier-state is passed through to `perform` as match data so the action can read it). Useful for `Escape` cancellation.

### B.3 `triggers.keyboard.character(ch)`

```ts
triggers.keyboard.character(ch: string): Trigger;
```

Fires after a `beforeinput` of `inputType === 'insertText'` whose `data === ch`, **after IME composition has settled**. This is the IME-correct way to react to a typed character. It does NOT fire on `keydown` for the character key — that would be wrong for dead keys, IME, paste, etc.

`ch` is a single Unicode scalar (graphemes longer than one scalar must use `dom.event` instead).

### B.4 `triggers.keyboard.sequence(combos)`

```ts
triggers.keyboard.sequence(combos: string[], opts?: { withinMs?: number }): Trigger;
```

Multi-stroke (`gg`-style). The router maintains a per-view rolling buffer of the last N keydowns within `withinMs` (default 1000). Matches when the tail of the buffer equals `combos`. Lower-priority than single-stroke matches at the same depth so that `g` alone can still resolve elsewhere — but the router holds the event for `withinMs` only when the buffer is a strict prefix of *some* registered sequence, otherwise it dispatches immediately. Nice-to-have; ships disabled by default.

### B.5 `triggers.clipboard.action(kind)`

```ts
triggers.clipboard.action(kind: 'cut' | 'copy' | 'paste'): Trigger;
```

Matches the corresponding `ClipboardEvent`. Match data includes `clipboardData` (the live `DataTransfer`). The action is responsible for `event.preventDefault()` semantics — actions on clipboard triggers are auto-`preventDefault`'d unless the action calls `ctx.allowDefault()`.

### B.6 `triggers.dom.event(eventName, target?)`

```ts
triggers.dom.event(
  eventName: string,
  target?: 'editor' | 'document' | 'window'
): Trigger;
```

Escape hatch for events not covered above (`focus`, `blur`, `dragover`, `drop`, custom events). Default `target` is `'editor'` (the contenteditable host). Matches all events of that name; the `match` returns `{}` unconditionally and validation rules do the gating.

### B.7 `triggers.editor.event(name)`

```ts
triggers.editor.event(name: 'selectionChange' | 'transaction' | 'ready'): Trigger;
```

Internal events emitted by the dispatch pipeline:
- `selectionChange` — after a transaction whose `selectionSet` is true.
- `transaction` — every committed transaction.
- `ready` — once after `whenReady` resolves.

These are how actions hook lifecycle moments declaratively (e.g. an analytics extension can `defineAction` on `transaction` rather than subscribing imperatively).

### B.8 `triggers.action.afterCommit(name)`

```ts
triggers.action.afterCommit(name: string): Trigger;
```

Fires after another action's `perform` resolves successfully. Match data: `{ result }`. Lets you chain (e.g. an "after `paste` runs, scroll to insertion" action) without monkey-patching.

---

## C. `ActionContext` (`ctx`)

`ctx` is the action's only handle to the editor. It is rebuilt per invocation; never store references to `ctx` past `perform` returning.

```ts
export interface ActionContext {
  // ─── transactions ──────────────────────────────────────────────────────
  /** Build a transaction. Chainable. `commit()` enqueues for dispatch. */
  createTransaction(): TransactionBuilder;
  /** Direct dispatch of an already-built transaction. */
  dispatch(tr: Transaction): void;

  // ─── async event bus ───────────────────────────────────────────────────
  /**
   * Emit an async event to all registered listeners. Resolves with the value
   * the (winning) listener resolves with. Rejection is treated as
   * cancellation: the action's `perform` sees the rejection bubble.
   * Honours `ctx.signal` — if cancelled before any listener settles, the
   * returned promise rejects with a `DOMException('aborted', 'AbortError')`.
   */
  triggerAsyncEvent<T = unknown>(
    eventName: string,
    payload?: unknown
  ): Promise<T>;

  // ─── lookups ───────────────────────────────────────────────────────────
  getSchema(): Schema;
  getView(): EditorView;
  getDriver(): PlimDriver;
  getRegistry(): Registry;            // block & mark spec lookup
  getHistory(): History;
  getSelection(): Selection;          // live; resolves against current state
  getCursor(): Cursor;
  getActiveMarks(): readonly Mark[];

  // ─── orchestration ─────────────────────────────────────────────────────
  /** Invoke another action programmatically. Returns its `perform` result. */
  runAction<T = unknown>(name: string, payload?: unknown): Promise<T>;

  /** Capture data attached to the trigger that fired (e.g. clipboardData). */
  getMatchData<T = Record<string, unknown>>(): T;

  // ─── visual hints ──────────────────────────────────────────────────────
  decorations: {
    add(deco: Decoration): DecorationId;
    remove(id: DecorationId): void;
  };

  // ─── cancellation ──────────────────────────────────────────────────────
  /**
   * Aborted when any of `cancellationTriggers` fires. Authors of async
   * `perform` MUST observe this signal (or pass it to fetch/etc.).
   */
  readonly signal: AbortSignal;

  /** Tell the router NOT to call event.preventDefault() for the source event. */
  allowDefault(): void;
}

export interface TransactionBuilder {
  // mark ops
  addMark(name: string, range: Range, attrs?: Attrs): this;
  removeMark(name: string, range: Range): this;
  toggleMark(name: string, range: Range, attrs?: Attrs): this;
  // block ops
  setBlockType(blockId: BlockId, type: string, attrs?: Attrs): this;
  setBlockAttrs(blockId: BlockId, attrs: Partial<Attrs>): this;
  splitBlock(at: Position): this;
  joinBackward(at: Position): this;
  joinForward(at: Position): this;
  insertBlock(spec: BlockInsertSpec, at: Position): this;
  removeBlock(blockId: BlockId): this;
  moveBlock(blockId: BlockId, to: Position): this;
  // text ops
  insertText(text: string, at: Position): this;
  replace(from: Position, to: Position, slice: Slice): this;
  // selection
  setSelection(sel: Selection): this;
  // meta
  setMeta(key: string, value: unknown): this;
  // commit
  commit(): void;
  /** Build without dispatching (rare; for composing). */
  build(): Transaction;
}
```

---

## D. `ReadOnlyState` (`state`)

```ts
export interface ReadOnlyState {
  readonly doc: Document;             // root node, frozen
  readonly selection: Selection;
  readonly cursor: Cursor;            // collapsed selection, or selection.head
  readonly schema: Schema;
  readonly storedMarks: readonly Mark[] | null;  // marks that will apply to next text
  readonly activeMarks: readonly Mark[];          // marks currently spanning the selection
  readonly blockAtCursor: Block;                  // innermost block containing cursor
  readonly parentBlock: Block | null;             // blockAtCursor.parent
  readonly isReadonly: boolean;                   // editor-level readonly flag
}
```

`state` is `Object.freeze`'d at every level a TS reader could legally reach; mutation throws in dev. The whole object is cheap to construct because everything inside is already immutable in the underlying `EditorState`.

`Cursor` is `{ blockId, offset, absolute: number }`. `Selection` is `{ anchor: Cursor, head: Cursor, from: Cursor, to: Cursor, empty: boolean }`.

---

## E. Validation rules

A `ValidationRule` is a tree:

```ts
export interface ValidationRule {
  evaluate(state: ReadOnlyState, event?: PlimRawEvent): boolean;
}

export interface ValidationRuleBuilders {
  // logical combinators
  and(rules: RuleInput[]): ValidationRule;
  or(rules: RuleInput[]): ValidationRule;
  not(rule: RuleInput): ValidationRule;
  every(rules: RuleInput[]): ValidationRule;     // alias of `and`, kept for readability
  some(rules: RuleInput[]): ValidationRule;      // alias of `or`
  // lookup
  rule(name: BuiltinRuleName, ...args: unknown[]): ValidationRule;
  // ad-hoc
  custom(fn: (state: ReadOnlyState, event?: PlimRawEvent) => boolean): ValidationRule;
}

export type RuleInput = ValidationRule | BuiltinRuleName | BuiltinRuleCall;
//   BuiltinRuleCall is e.g. ['blockSupportsMark', 'bold'] or ['cursorInBlock', 'paragraph']
```

A bare string in an array (e.g. `'selectionNotEmpty'`) is sugar for `rule('selectionNotEmpty')`. Builders are total: passing an unknown rule name throws at action-registration time, not at evaluation time.

### E.1 Built-in rule registry

Every built-in rule is a pure function `(state, event?) => boolean`.

| Name | Args | `evaluate` |
|------|------|------------|
| `selectionNotEmpty` | — | `!state.selection.empty` |
| `selectionEmpty` | — | `state.selection.empty` |
| `blockSupportsDecoration` | — | `state.blockAtCursor.spec.allowsMarks === true` |
| `blockSupportsMark(name)` | mark name | `state.blockAtCursor.spec.allowsMarks && schema.marks.get(name)?.appliesTo(state.blockAtCursor.type) !== false` |
| `startOfBlock` | — | `state.cursor.offset === 0` |
| `endOfBlock` | — | `state.cursor.offset === state.blockAtCursor.contentLength` |
| `precededByWhitespace` | — | `cursor.offset === 0 \|\| /\s/u.test(state.blockAtCursor.text.charAt(cursor.offset - 1))` |
| `precededByCharacter(re)` | RegExp | `cursor.offset > 0 && re.test(state.blockAtCursor.text.charAt(cursor.offset - 1))` |
| `cursorInBlock(name)` | block name | `state.blockAtCursor.type === name` |
| `parentBlockIs(name)` | block name | `state.parentBlock?.type === name` |
| `ancestorBlockIs(name)` | block name | `walkAncestors(state.blockAtCursor).some(b => b.type === name)` |
| `markActive(name)` | mark name | `state.activeMarks.some(m => m.type === name)` |
| `markNotActive(name)` | mark name | `!state.activeMarks.some(m => m.type === name)` |
| `inDocument` | — | `state.blockAtCursor != null` |
| `notInCodeBlock` | — | `state.blockAtCursor.type !== 'code'` |
| `notInAtomicBlock` | — | `state.blockAtCursor.spec.atomic !== true` |

### E.2 Worked example — combinator usage

```ts
defineAction('mention', {
  trigger: triggers.keyboard.character('@'),
  triggerValidationRules: ({ and, or, not, custom }) => and([
    'inDocument',
    'notInCodeBlock',
    or(['startOfBlock', 'precededByWhitespace']),
    not(['markActive', 'code']),
    custom((s) => !s.isReadonly),
  ]),
  cancellationTriggers: [
    triggers.keyboard.key('Escape'),
    triggers.keyboard.key('Space'),
  ],
  priority: 1,
  perform: (state, ctx) => ctx.triggerAsyncEvent('showMentionSuggestions'),
});
```

### E.3 Evaluation semantics

- **Lazy**. `and` short-circuits on first `false`; `or` short-circuits on first `true`.
- **Pure**. Rules MUST NOT touch the DOM, mutate, or `await`. They are called many times per second on selection change. Violations are caught in dev by a `Proxy` around `state` and a microtask-time check.
- **Stable**. Rules are evaluated against a single snapshot — even if `evaluate` reads `state.selection` then `state.cursor`, both come from the same frozen state.

---

## F. Cancellation flow

When `perform` returns a thenable, the router treats the action as **pending**. While pending:

1. The router records `{ action, ctx, abortController, mappingFromStart }` in its `pendingActions` map keyed by action instance.
2. Cancellation triggers for the action are subscribed to the relevant raw-event buckets (keyboard, etc.).
3. On any cancellation match, the router calls `ctx.signal.abort()`. The action author is responsible for observing the signal — `triggerAsyncEvent` itself observes the signal and rejects with `AbortError`.
4. `perform`'s eventual `resolve` or `reject` clears the pending entry. A rejection that is `AbortError` is swallowed silently; any other rejection is forwarded to the editor's error reporter.

> **Contract (from the wishlist note):** `perform` must not resolve until the high-level user-visible operation is fully complete. For "open a menu" that means resolve when the menu closes, not when it opens. Otherwise cancellation is meaningless.

### F.1 Mermaid — slash command lifecycle

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant V as EditorView
  participant R as ActionRouter
  participant A as slashCommand action
  participant B as AsyncEventBus
  participant L as Menu listener (UI)

  U->>V: types "/"
  V->>V: beforeinput → Trigger pipeline
  V->>R: dispatch(beforeinput, "/")
  R->>R: bucket lookup → keyboard.character("/") matches
  R->>R: validate (or [startOfBlock, precededByWhitespace]) → ok
  R->>A: perform(state, ctx)
  A->>B: triggerAsyncEvent("showSlashCommandMenu")
  B->>L: notify listener (event.resolve / reject / cancel)
  Note over R,A: action is now pending; cancellationTriggers active
  alt User picks an item
    L->>B: event.resolve(item)
    B-->>A: promise resolves
    A->>A: ctx.createTransaction().…commit()
    A-->>R: perform resolved
    R->>R: clear pending
  else User presses Escape
    U->>V: keydown Escape
    V->>R: dispatch(keydown Escape)
    R->>R: matches cancellationTrigger of slashCommand
    R->>A: ctx.signal.abort()
    A->>B: (triggerAsyncEvent observes signal) reject AbortError
    A-->>R: perform rejects (AbortError)
    R->>R: swallow + clear pending
  end
```

### F.2 Worked example — `slashCommand` (async, cancellable)

```ts
import { defineAction, triggers } from '@plim/core';

export const slashCommand = defineAction('slashCommand', {
  trigger: triggers.keyboard.character('/'),
  triggerValidationRules: ({ and, or }) => and([
    'inDocument',
    'notInCodeBlock',
    or(['startOfBlock', 'precededByWhitespace']),
  ]),
  cancellationTriggers: [
    triggers.keyboard.key('Escape'),
  ],
  perform: async (state, ctx) => {
    // Capture the slash position; ctx auto-remaps via Mapping if other
    // transactions land while we're awaiting.
    const anchor = state.cursor;

    try {
      const pick = await ctx.triggerAsyncEvent<{ commandId: string; args?: unknown } | null>(
        'showSlashCommandMenu',
        { anchor }
      );
      if (!pick) return; // listener resolved with null = no-op
      // Remove the slash + query, then run the picked command as another action.
      const head = ctx.getCursor();
      ctx.createTransaction()
        .replace(anchor, head, /* empty slice */ Slice.empty)
        .commit();
      await ctx.runAction(pick.commandId, pick.args);
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') {
        // Escape pressed — leave the literal "/" in the doc, do nothing else.
        return;
      }
      throw err;
    }
  },
});
```

---

## G. Priority & conflict resolution

When a raw event arrives, the router builds the candidate list — every action whose at least one trigger matches the event's bucket. It then resolves:

1. **Sort** candidates by `priority` desc; ties broken by registration order (earliest wins, so user actions appended after built-ins win on tie because user-supplied `registeredActions` are concatenated after built-ins).
2. **Lazy validate**. For each candidate in order, evaluate `triggerValidationRules` (treat absent rules as a vacuous pass). The **first** that passes is the winner; remaining candidates are not evaluated.
3. Built-in actions ship at priority 0. To override (e.g. replace `bold`), an extension supplies a same-named action with `priority: 1`. Same-name collisions throw at registration unless the new one has higher priority OR the colliding one was registered with `{ overridable: true }` (out of scope here).
4. **Default-prevention**. If a winner is found, the router calls `event.preventDefault()` and `event.stopPropagation()` on the raw browser event before invoking `perform`. The action may opt out by calling `ctx.allowDefault()` synchronously before any `await`. After the first `await` in `perform`, `allowDefault` throws — too late.

If **no** action matches/validates, the event passes through to the next handler in `EditorView` (input rules, default browser behaviour, etc.).

### G.1 Worked example — `paste` (clipboard trigger)

```ts
export const paste = defineAction('paste', {
  trigger: [
    triggers.keyboard.shortcut('Mod+v'),  // some browsers fire this without a clipboard event
    triggers.clipboard.action('paste'),
  ],
  priority: 1, // beat any extension trying to claim Mod+V
  perform: (state, ctx) => {
    const { clipboardData } = ctx.getMatchData<{ clipboardData: DataTransfer | null }>();
    // shortcut path may have no clipboardData; fall back to the native clipboard event the next tick
    if (!clipboardData) {
      ctx.allowDefault(); // let the browser surface a `paste` ClipboardEvent the action will catch
      return;
    }
    const html = clipboardData.getData('text/html');
    const text = clipboardData.getData('text/plain');
    const slice = ctx.getDriver().parsePaste({ html, text });
    ctx.createTransaction().replaceSelection(slice).commit();
  },
});
```

---

## H. Async event bus

Each `AgnosticEditor` owns one bus. Listeners are registered via `editor.onAsyncEvent(name, listener)` (agnostic API, see `api-wishlist.md`) or `useAsyncEventListener(name, listener)` (React API).

```ts
// @plim/editor
export interface AsyncEventListener<TPayload = unknown, TResult = unknown> {
  (event: AsyncEventHandle<TPayload, TResult>, state: ReadOnlyState, ctx: ListenerContext):
    Promise<void> | void;
}

export interface AsyncEventHandle<TPayload, TResult> {
  readonly name: string;
  readonly payload: TPayload;
  readonly signal: AbortSignal;       // mirrors the action's ctx.signal
  resolve(value: TResult): void;
  reject(reason: unknown): void;
  cancel(): void;                      // sugar for reject(new DOMException('cancelled','AbortError'))
}

// internal
class AsyncEventBus {
  #map = new Map<string, AsyncEventListener[]>();
  on(name: string, l: AsyncEventListener): () => void { /* add + return off */ }
  emit<T>(name: string, payload: unknown, signal: AbortSignal): Promise<T> {
    const ls = this.#map.get(name) ?? [];
    if (ls.length === 0) return Promise.reject(new Error(`no listener for ${name}`));
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const inner = new AbortController();
      const onAbort = () => { if (!settled) { settled = true; reject(new DOMException('aborted','AbortError')); inner.abort(); } };
      signal.addEventListener('abort', onAbort, { once: true });
      const handle = (p: unknown): AsyncEventHandle<unknown, unknown> => ({
        name, payload: p, signal: inner.signal,
        resolve: (v) => { if (!settled) { settled = true; resolve(v as T); inner.abort(); } },
        reject:  (r) => { if (!settled) { settled = true; reject(r); inner.abort(); } },
        cancel:  () => { if (!settled) { settled = true; reject(new DOMException('cancelled','AbortError')); inner.abort(); } },
      });
      // Fire all listeners; first to settle wins; the rest are notified via inner.signal.
      for (const l of ls) {
        Promise.resolve(l(handle(payload), this.#snapshotState(), this.#listenerCtx())).catch(reject);
      }
    });
  }
}
```

Behavioural rules:
- **Map shape**: `Map<eventName, Listener[]>` per editor; listeners are kept in insertion order.
- **First-to-settle wins**. When a listener calls `event.resolve` / `reject` / `cancel`, an internal `AbortSignal` (the handle's `signal`) is aborted so other listeners can bail out.
- **No listener registered** → `triggerAsyncEvent` rejects synchronously-microtask with `Error('no listener for X')`. Actions that are tolerant of missing UI (e.g. `confirmDangerous` → assume "yes" in headless contexts) should catch this themselves.
- **Action cancellation** propagates: when `ctx.signal` aborts, the bus aborts the listener handle's signal too, so a well-behaved listener tears down its menu.
- **Built-in event names** ship in `@plim/actions`: `showSlashCommandMenu`, `showMentionSuggestions`, `showEmojiSuggestions`, `confirmDangerous`, `pickFile`, `chooseLink`. Extensions are free to register more — the namespace is open. Convention: `snake.case` for built-ins, `extension-id:eventName` for extensions to avoid collisions.

---

## I. Built-in actions catalog

All ship in `@plim/actions`. Each is `defineAction(...)` with priority 0 unless noted. Triggers use the macOS-native `Mod` form; `Mod` is normalised per § B.1.

| Name | Trigger(s) | Validation | `perform` (sketch) |
|------|------------|------------|--------------------|
| `bold` | `kbd.shortcut('Mod+b')` | `and([selectionNotEmpty, blockSupportsMark('bold')])` | `ctx.tx().toggleMark('bold', sel).commit()` |
| `italic` | `kbd.shortcut('Mod+i')` | same w/ `'italic'` | `toggleMark('italic', sel)` |
| `underline` | `kbd.shortcut('Mod+u')` | same w/ `'underline'` | `toggleMark('underline', sel)` |
| `strikethrough` | `kbd.shortcut('Mod+Shift+s')` | same w/ `'strikethrough'` | `toggleMark('strikethrough', sel)` |
| `code` | `kbd.shortcut('Mod+e')` | same w/ `'code'` + `notInCodeBlock` | `toggleMark('code', sel)` |
| `link` | `kbd.shortcut('Mod+k')` | `and([selectionNotEmpty, blockSupportsMark('link')])` | `const url = await ctx.triggerAsyncEvent('chooseLink'); if (url) ctx.tx().toggleMark('link', sel, { href: url }).commit()` |
| `heading-1` | `kbd.shortcut('Mod+Alt+1')` | `notInAtomicBlock` | `ctx.tx().setBlockType(blockId, 'heading_1').commit()` |
| `heading-2` | `kbd.shortcut('Mod+Alt+2')` | same | `setBlockType('heading_2')` |
| `heading-3` | `kbd.shortcut('Mod+Alt+3')` | same | `setBlockType('heading_3')` |
| `bulletedList` | `kbd.shortcut('Mod+Shift+8')` | `notInAtomicBlock` | `setBlockType('bulleted_list_item')` |
| `numberedList` | `kbd.shortcut('Mod+Shift+7')` | same | `setBlockType('numbered_list_item')` |
| `todoList` | `kbd.shortcut('Mod+Shift+9')` | same | `setBlockType('to_do', { checked: false })` |
| `blockquote` | `kbd.shortcut('Mod+Shift+.')` | same | `setBlockType('quote')` |
| `codeBlock` | `kbd.shortcut('Mod+Shift+c')` | same | `setBlockType('code', { language: 'plain text' })` |
| `divider` | none (slash-only) | `notInAtomicBlock` | `insertBlock({ type: 'divider' }, after-cursor)` |
| `slashCommand` | `kbd.character('/')` | `or([startOfBlock, precededByWhitespace])` + `notInCodeBlock` | see § F.2 |
| `mention` | `kbd.character('@')`, priority 1 | same | `await triggerAsyncEvent('showMentionSuggestions')` |
| `emoji` | `kbd.character(':')`, priority 1 | same | `await triggerAsyncEvent('showEmojiSuggestions')` |
| `cut` | `kbd.shortcut('Mod+x')`, `clipboard.action('cut')`, priority 1 | `selectionNotEmpty` | write data; `tx().replaceSelection(empty).commit()` |
| `copy` | `kbd.shortcut('Mod+c')`, `clipboard.action('copy')`, priority 1 | `selectionNotEmpty` | write data; no transaction |
| `paste` | `kbd.shortcut('Mod+v')`, `clipboard.action('paste')`, priority 1 | — | see § G.1 |
| `duplicateBlock` | `kbd.shortcut('Mod+d')` | `notInAtomicBlock` | `tx().insertBlock(clone(block), after).commit()` |
| `deleteBlock` | `kbd.shortcut('Mod+Shift+Backspace')` | — | `tx().removeBlock(blockId).commit()` |
| `selectBlock` | `kbd.key('Escape')`, priority -1 | `selectionEmpty` | set selection to whole block |
| `selectAllInBlock` | `kbd.shortcut('Mod+a')` (1st press) | `inDocument` | sel = whole block; remember "armed" via plugin state |
| `selectAllDocument` | `kbd.shortcut('Mod+a')` (2nd press), priority 1 | armed | sel = whole doc |
| `moveBlockUp` | `kbd.shortcut('Mod+Shift+ArrowUp')` | `notInAtomicBlock` | `tx().moveBlock(blockId, prevSibling).commit()` |
| `moveBlockDown` | `kbd.shortcut('Mod+Shift+ArrowDown')` | same | `moveBlock(blockId, nextSibling+1)` |
| `undo` | `kbd.shortcut('Mod+z')` | — | `ctx.getHistory().undo()` |
| `redo` | `kbd.shortcut('Mod+Shift+z')`, `kbd.shortcut('Mod+y')` | — | `ctx.getHistory().redo()` |
| `indent` | `kbd.key('Tab')` | `cursorInBlock('bulleted_list_item' \| 'numbered_list_item' \| 'to_do')` | nest one level |
| `outdent` | `kbd.shortcut('Shift+Tab')` | same + has parent list | unnest one level |
| `splitBlock` | `kbd.key('Enter')` | `not(['cursorInBlock','code'])` | `tx().splitBlock(cursor).commit()` |
| `softBreak` | `kbd.shortcut('Shift+Enter')` | — | `tx().insertText('\n', cursor).commit()` |
| `joinBackward` | `kbd.key('Backspace')` | `and([selectionEmpty, startOfBlock])` | `tx().joinBackward(cursor).commit()` |
| `joinForward` | `kbd.key('Delete')` | `and([selectionEmpty, endOfBlock])` | `tx().joinForward(cursor).commit()` |

`selectAllInBlock`/`selectAllDocument` share a small plugin state (`armedAt: number | null`) to implement the once/twice semantics; both are dispatched from `Mod+A` because the second press has priority 1 and validates "armed". This is the pattern for any double-tap shortcut.

---

## J. Action registry & lookup

The `ActionRouter` lives inside `EditorView`. It is rebuilt whenever the action set changes (extension hot-reload, runtime `driver.registerAction(...)`).

```ts
// @plim/view (uses @plim/core types)
export class ActionRouter {
  // bucketed indexes — O(1) lookup per raw event
  #byKeyboardCombo  = new Map<string /* "meta+b" */, Action[]>();
  #byKey            = new Map<string /* "Escape" */, Action[]>();
  #byCharacter      = new Map<string /* "/" */, Action[]>();
  #bySequencePrefix = new Map<string /* "g" */, { action: Action; tail: string[] }[]>();
  #byClipboard      = new Map<'cut'|'copy'|'paste', Action[]>();
  #byDom            = new Map<string /* eventName */, Action[]>();
  #byEditor         = new Map<'selectionChange'|'transaction'|'ready', Action[]>();
  #byAfterCommit    = new Map<string /* actionName */, Action[]>();

  #pending = new Map<Action, PendingEntry>();

  constructor(actions: readonly Action[]) {
    for (const a of actions) for (const t of a.triggers) this.#index(a, t);
    for (const bucket of this.#allBuckets()) bucket.sort((x, y) => y.priority - x.priority);
  }

  /** Hot-reload */
  replace(actions: readonly Action[]): void { /* clear + reindex */ }

  /** One entry-point per raw-event kind: */
  routeKeyboard(ev: KeyboardEventLike, state: ReadOnlyState): RouteResult {
    // 1) sequences first (have a deferred timer)
    // 2) shortcut bucket (full chord)
    // 3) bare-key bucket
    // 4) character bucket is handled in routeBeforeInput
    // For each bucket, walk candidates in priority order, validate lazily, run first match.
  }

  routeBeforeInput(ev: BeforeInputLike, state: ReadOnlyState): RouteResult { /* character bucket */ }
  routeClipboard (ev: ClipboardLike, state: ReadOnlyState): RouteResult { /* cut/copy/paste */ }
  routeDom       (name: string, ev: Event, state: ReadOnlyState): RouteResult { /* dom bucket */ }
  routeEditor    (name: 'selectionChange'|'transaction'|'ready', payload: unknown, state: ReadOnlyState): void {
    /* Editor events do not preventDefault; all matching actions run, in priority order. */
  }
  notifyAfterCommit(actionName: string, result: unknown, state: ReadOnlyState): void { /* fan-out */ }
}

interface PendingEntry {
  action: Action;
  ctx: ActionContext;
  abort: AbortController;
  cancellationOff: () => void;        // unsubscribe from cancellation triggers
}

interface RouteResult {
  matched: boolean;
  preventDefault: boolean;
  promise?: Promise<unknown>;          // when the action was async
}
```

Hot-reload:
- `driver.registerAction(a)` / `driver.unregisterAction(name)` — synchronously rebuild the affected bucket(s); pending actions whose `Action` is removed are aborted.
- `ExtensionManager` swap (during HMR) → `router.replace(allActions)` once.

---

## K. Testing

Actions are pure functions of `(state, ctx)` and a trigger predicate. The test harness lives in `@plim/test-utils`.

```ts
import { createTestEditor, simulateKey, simulateBeforeInput, simulateClipboard } from '@plim/test-utils';
import { bold } from '@plim/actions';

test('bold toggles on selection', async () => {
  const ed = createTestEditor({
    initialDoc: 'paragraph("hello world")',
    selection: { anchor: 0, head: 5 },         // selects "hello"
    registeredActions: [bold],
  });

  await simulateKey(ed, { key: 'b', metaKey: true }); // Mod = meta on darwin in test
  expect(ed.toMarkdown()).toBe('**hello** world');
  expect(ed.lastTransaction.steps).toHaveLength(1);
});

test('bold no-ops on empty selection', async () => {
  const ed = createTestEditor({ initialDoc: 'paragraph("x")', selection: 0, registeredActions: [bold] });
  const ran = await simulateKey(ed, { key: 'b', metaKey: true });
  expect(ran.matched).toBe(false);              // validation rule blocked it
});

test('slashCommand cancels on Escape', async () => {
  const ed = createTestEditor({ initialDoc: 'paragraph("")', selection: 0, registeredActions: [slashCommand] });
  ed.onAsyncEvent('showSlashCommandMenu', (event) => { /* never resolve */ });

  const p = simulateBeforeInput(ed, { inputType: 'insertText', data: '/' });
  await simulateKey(ed, { key: 'Escape' });
  await expect(p).resolves.toMatchObject({ matched: true, cancelled: true });
});
```

Key utilities:
- `createTestEditor` — runs `@plim/core` with a stub `EditorView` (no DOM). It implements just enough of the view to invoke `ActionRouter.route*`.
- `simulateKey` / `simulateBeforeInput` / `simulateClipboard` — synthesise a `PlimRawEvent` and feed it into the router; return `RouteResult & { cancelled: boolean }`.
- `ed.lastTransaction` / `ed.transactions` — for asserting on emitted steps.
- `ed.toMarkdown()` — uses `@plim/markdown` for ergonomic assertions.

Headless mode (no DOM) is the default; opt into JSDOM only when testing actions that touch `document` (rare — those should be plugins).

---

## L. Migration mapping (from `packages/input/src/*`)

The current `@plim/input` package will be split: anything user-facing migrates to `@plim/actions`; anything that produces transactions from raw input migrates to `@plim/view` plugins. The package itself can be deprecated.

| Existing module | New home | New shape |
|---|---|---|
| `markdown.ts` — `evaluateMarkdownInput`, `evaluateMarkdownInputAfterInsertion`, `MarkdownTransformResult` | `@plim/view` (plugin: `markdownInputRulePlugin`) | An **input rule** plugin (see `04-input-and-paste.md`). Not an action — it runs inside the dispatch loop on `appendTransaction`, removes the trigger characters via the rule's replace step. |
| `markdown.ts` — `createDefaultMarkdownInputRules` | `@plim/view` | Stays as the rule list passed to the input-rule plugin. |
| `slash.ts` — `detectSlashTrigger` | `@plim/actions` (`slashCommand`) | The detection logic becomes the validation rule (`or([startOfBlock, precededByWhitespace])`) plus the action's own bookkeeping of the slash anchor. |
| `slash.ts` — `searchSlashCommands`, `groupCommandMenuItems`, `createMenuNavigationState`, `moveMenuNavigation`, `nextEnabledMenuIndex` | `@plim/react` + `@plim/agnostic-ui` | These are **listener-side** UI helpers — they live with whatever renders the menu. The action only emits `showSlashCommandMenu`; the listener owns search/grouping/nav. |
| `commands.ts` — `CommandRegistry`, `register`, `registerProvider`, `get`, `require`, `list` | `@plim/actions` (`ActionRegistry`) — but as a thin facade over the new `Action[]` model | One unified registry. `CommandDefinition` ⇒ `Action`. `AsyncCommandProvider` ⇒ extension that registers actions on demand. |
| `commands.ts` — `CommandInvocation`, `EditorCommandContext` | `@plim/core` | Subsumed by `ActionContext`. `runAction(name, payload)` replaces `invokeCommand`. |
| `events.ts` — `CompositionGuard`, `isComposingEvent`, `classifyBeforeInput`, `shouldRunInputRules`, `shouldOpenInlineAutocomplete`, `shouldPreventNativeBeforeInput`, `isDeletionInput`, `isHistoryInput` | `@plim/view` (DOMObserver / beforeinput pipeline) | These are pre-routing helpers used by the view to construct `PlimRawEvent`. They never touch actions directly anymore. |
| `events.ts` — `shouldIgnorePrintableShortcut` | `@plim/view` | Folded into `routeKeyboard` — a printable single character with no modifiers does not enter the shortcut bucket; it enters the character bucket via `beforeinput`. |
| `shortcuts.ts` — `resolveKeyboardMatches`, `eventToChord`, `detectPlatform` | `@plim/core` (helpers for `triggers.keyboard.shortcut`) | Used internally by the shortcut trigger to parse and match combos. The public API is `triggers.keyboard.shortcut(combo)`; these helpers stop being public. |
| `clipboard.ts` | `@plim/view` (clipboard pipeline) + `@plim/actions` (`cut`/`copy`/`paste`) | The view dispatches `PlimRawEvent { type: 'clipboard' }`; the actions own the user-visible behaviour. |
| `autocomplete.ts` | `@plim/actions` (`mention`, `emoji`) + listener-side UI | Same pattern as `slash`: detection ⇒ validation rule; UI ⇒ async event listener. |
| `text-utils.ts` (`fuzzyScore`, `wordBoundaryScore`, `foldForSearch`) | `@plim/agnostic-ui` | Generic text utilities — used by listeners, not the editor core. |
| `types.ts` — `CommandDefinition`, `CommandSurface`, `KeyboardBinding`, `SlashBinding`, `DisabledReason`, `CommandPredicate`, `CommandMenuItem` | Mostly retired; survivors move to `@plim/agnostic-ui` | The new types are `Action`, `Trigger`, `ValidationRule`, `ActionDef`. `KeyboardBinding` is replaced by `Trigger`. `SlashBinding` is replaced by an action triggered from the slash menu listener via `ctx.runAction`. |

End state: `@plim/input` is gone; the editor reads no DOM-derived state outside `@plim/view`'s observer; every user-visible operation is a `defineAction` call.

---

*End of 03-actions-and-triggers.md.*
