# 09 — Wishlist → Concrete API Mapping

> Status: **Authoritative implementation contract.** Every example in [`api-wishlist.md`](../../api-wishlist.md) is reproduced verbatim and mapped to the exact TypeScript signature `@plim/*` packages will export. Where the wishlist is silent we extend; the extension is always called out, with a justification anchored in docs [00](./00-overview.md)–[08](./08-packages-and-migration.md).
>
> Canonical primitives (`PlimDriver`, `Schema`, `EditorState`, `Transaction`, `Step`, `Mapping`, `AgnosticEditor`, `EditorView`, `ViewDesc`, `Plugin`, `Action`, `Extension`, `Snapshot`) are defined in [00-overview.md §4](./00-overview.md#4-core-primitives-canonical-names). This doc does not redefine them — it specifies their **public TS surface**.
>
> Reading order: this doc is the contract. The companion docs (01–08) explain the **internals** that make it true. If they ever conflict with this doc, **this doc wins** — the wishlist is the contract, and 09 is the wishlist's projection into TypeScript.

---

## Table of contents

- [A. `PlimDriver` constructor](#a-plimdriver-constructor)
- [B. `defineAction(name, opts)`](#b-defineactionname-opts)
- [C. `triggers` namespace](#c-triggers-namespace)
- [D. `deriveEditor` and `attachContainer`](#d-deriveeditor-and-attachcontainer)
- [E. `contentFromMarkdown`](#e-contentfrommarkdown)
- [F. `<PlimEditor />` and React hooks](#f-plimeditor--and-react-hooks)
- [G. History API](#g-history-api)
- [H. Extension API](#h-extension-api)
- [I. Snapshot API](#i-snapshot-api)
- [J. `defineBlock`](#j-defineblock)
- [K. `defineMark`](#k-definemark)
- [L. End-to-end compile test](#l-end-to-end-compile-test)
- [M. API stability matrix](#m-api-stability-matrix)
- [N. Index of exported symbols](#n-index-of-exported-symbols)

---

## A. `PlimDriver` constructor

### Wishlist (verbatim)

```ts
import { PlimDriver, defineAction, triggers } from '@plim/core';

const plim = new PlimDriver({
	theme: 'light', // theme name or custom theme object
	extensions: [ /* array of extensions to use */ ],
	registeredMarks: [ boldMark(), italicMark(), /* ... */ ],
	registeredBlocks: [ paragraphBlock(), headingBlock(), /* ... */ ],
	registeredActions: [ defineAction('bold', { /* ... */ }), /* ... */ ],
});
```

### Final signature

```ts
// Package: @plim/core
// Module:  @plim/core/driver

export class PlimDriver {
  constructor(config: PlimDriverConfig);

  /** Compiled, frozen schema (built from registered blocks/marks + extensions). */
  getSchema(): Schema;

  /** Driver-wide history factory. Each editor gets its own History instance,
   *  but `getHistory()` returns the *driver-level* aggregate that mirrors the
   *  wishlist `plim.getHistory()` example. See section G. */
  getHistory(): History;

  /** Create a new live editor. Equivalent to `deriveEditor(this, opts)`. */
  createEditor(opts?: DeriveEditorOptions): AgnosticEditor;

  /** Hot-attach an extension after construction. Triggers schema rebuild
   *  for live editors and re-runs the cached `defineExtension` factory. */
  addExtension(ext: Extension): void;

  /** Detach an extension. Throws if a live editor still depends on a block
   *  type contributed solely by this extension. */
  removeExtension(extName: string): void;

  /** Tear down all editors created from this driver, flush async events,
   *  drop all listeners. Idempotent. */
  destroy(): void;
}
```

```ts
export interface PlimDriverConfig {
  /** Theme: 'light' | 'dark' | a token map. See `Theme` below. */
  theme?: Theme;

  /** Extensions to apply at construction. Order matters: later extensions
   *  see earlier extensions' contributions in their factory's `editor` arg. */
  extensions?: Extension[];

  /** Mark factories (results of `defineMark(...)`). */
  registeredMarks?: RegisteredMark[];

  /** Block factories (results of `defineBlock(...)`). */
  registeredBlocks?: RegisteredBlock[];

  /** Top-level actions. Extensions may register more actions; merging follows
   *  the priority rules in 03-actions-and-triggers.md §5. */
  registeredActions?: RegisteredAction[];

  /** Optional override hook for diagnostics — see 05-extensions.md §7. */
  onWarning?: (w: PlimWarning) => void;
}
```

### Sub-types

```ts
// ─── Theme ──────────────────────────────────────────────────────────────────
export type Theme = ThemeName | ThemeTokens;

export type ThemeName = 'light' | 'dark';

/** Custom token map. Tokens are CSS custom-property names without the `--`
 *  prefix; values may be any valid CSS string. Tokens are written to the
 *  editor root element via `style.setProperty('--' + key, value)` at mount.
 *  See 02-view-and-dom.md §9 for the canonical token list. */
export interface ThemeTokens {
  /** Discriminator for `Theme` — required so 'light' | 'dark' don't overlap
   *  with arbitrary objects. */
  readonly kind: 'custom';
  readonly base?: ThemeName; // optional preset to inherit from
  readonly tokens: Readonly<Record<string, string>>;
}

// ─── Extension ──────────────────────────────────────────────────────────────
// Returned by `defineExtension(...)` — see section H.
export interface Extension {
  readonly id: string;          // stable id used for extension cache key
  readonly factory: ExtensionFactory;
}

export type ExtensionFactory = (
  editor: AgnosticEditor,
  config?: unknown,
) => ExtensionDef;

// ─── Registered* ────────────────────────────────────────────────────────────
// Returned by `defineMark(...)` / `defineBlock(...)` / `defineAction(...)`.
// They are *factory results*, opaque to consumers but introspectable to the
// driver. See sections J, K, B for their full shapes.

export interface RegisteredMark<TAttrs = MarkAttrs> {
  readonly kind: 'mark';
  readonly spec: MarkSpec<TAttrs>;
}

export interface RegisteredBlock<TAttrs = BlockAttrs> {
  readonly kind: 'block';
  readonly spec: BlockSpec<TAttrs>;
}

export interface RegisteredAction<
  TName extends string = string,
  TAsyncEvents extends AsyncEventMap = AsyncEventMap,
> {
  readonly kind: 'action';
  readonly spec: ActionSpec<TName, TAsyncEvents>;
}
```

### Lifecycle methods

| Method                    | Wishlist? | Notes |
|---------------------------|-----------|-------|
| `getHistory()`            | ✅        | Section G. Returns the **driver-level** aggregate `History`. |
| `createEditor(opts?)`     | ⛌ ext.    | The wishlist uses `deriveEditor(plim, opts)`; we add `plim.createEditor` as sugar — both produce identical results (`createEditor` literally calls `deriveEditor(this, opts)`). |
| `destroy()`               | ⛌ ext.    | Required for memory-safe teardown — used by React's `<PlimEditor />` on unmount, see [07-react-bindings.md §4](./07-react-bindings.md). |
| `addExtension(ext)`       | ⛌ ext.    | Wishlist says extensions can be configured at runtime; this is the runtime hook. |
| `removeExtension(name)`   | ⛌ ext.    | Symmetric pair. |
| `getSchema()`             | ⛌ ext.    | Needed by tools (markdown serializer, snapshot deserializer) — public for parity with PM. |

### Architecture ties

- The driver builds the `Schema` (00-overview §4, 01-schema-and-state §3) by merging `registeredBlocks` + `registeredMarks` + extension-contributed schema fragments. Conflicts throw at construction (00-overview §12, "Can two extensions register the same block name?").
- `extensions[].factory(editor, config?)` is invoked **lazily, per editor**, the first time `createEditor()` is called for a given driver. Results are cached per `(driver, extension.id)` so subsequent editors reuse the compiled `ExtensionDef` (05-extensions §6 — caching contract).
- `theme` tokens are written by `EditorView` on mount (02-view-and-dom §9).

### Real-world usage

```ts
import {
  PlimDriver,
  defineAction,
  triggers,
  type ThemeTokens,
} from '@plim/core';
import { paragraphBlock, headingBlock } from '@plim/blocks';
import { boldMark, italicMark } from '@plim/marks';
import { historyExtension } from '@plim/actions';

const myTheme: ThemeTokens = {
  kind: 'custom',
  base: 'light',
  tokens: {
    'plim-color-bg': '#fafafa',
    'plim-font-mono': 'JetBrains Mono, monospace',
  },
};

const plim = new PlimDriver({
  theme: myTheme,
  extensions: [historyExtension()],
  registeredMarks: [boldMark(), italicMark()],
  registeredBlocks: [paragraphBlock(), headingBlock()],
  registeredActions: [
    defineAction('bold', {
      trigger: triggers.keyboard.shortcut('Mod+b'),
      triggerValidationRules: ({ and }) =>
        and(['selectionNotEmpty', 'blockSupportsDecoration']),
      perform: async (state, ctx) => {
        const { from, to } = state.selection;
        await ctx.createTransaction()
          .toggleMark('bold', { from, to })
          .commit();
      },
    }),
  ],
});

const schema = plim.getSchema();
// later: plim.destroy();
```

---

## B. `defineAction(name, opts)`

### Wishlist (verbatim)

```ts
defineAction('bold', {
  trigger: triggers.keyboard.shortcut('Mod+b'),
  triggerValidationRules: ({and, or}) => and([
    "selectionNotEmpty",
    "blockSupportsDecoration",
  ]),
  perform: async (state, ctx) => {
    const { selection } = state;
    await ctx.createTransaction()
      .toggleMark('bold', { from: selection.from, to: selection.to })
      .commit();
  }
})

defineAction('slashCommand', {
  trigger: triggers.keyboard.character('/'),
  triggerValidationRules: ({and, or}) => or([
    "startOfBlock",
    "precededByWhitespace",
  ]),
  cancellationTriggers: [ triggers.keyboard.key('Escape') ],
  perform: async (state, ctx) => {
    return ctx.triggerAsyncEvent('showSlashCommandMenu');
  },
})
```

### Final signature

```ts
// Package: @plim/core
// Module:  @plim/core/actions

export function defineAction<
  TName extends string,
  TAsyncEvents extends AsyncEventMap = DefaultAsyncEventMap,
>(
  name: TName,
  opts: ActionOptions<TName, TAsyncEvents>,
): RegisteredAction<TName, TAsyncEvents>;
```

```ts
export interface ActionOptions<
  TName extends string,
  TAsyncEvents extends AsyncEventMap,
> {
  /** Single trigger or array of triggers (any trigger fires the action). */
  trigger: Trigger | Trigger[];

  /** Optional validation. The builder argument exposes `and`, `or`, `not`,
   *  and a registry of named rules (see 03-actions-and-triggers §3). */
  triggerValidationRules?: ValidationRuleBuilder;

  /** Triggers that cancel the action while `perform` is still pending.
   *  Cancellation only applies if `perform` has not yet resolved
   *  (see wishlist NOTE block, lines 141–142). */
  cancellationTriggers?: Trigger[];

  /** Higher numbers win when multiple actions share a trigger. Default 0. */
  priority?: number;

  /** Strongly typed. The return type may be void OR an `AsyncEventResult`
   *  (when `perform` ends in `ctx.triggerAsyncEvent(...)`). */
  perform: (
    state: ActionState,
    ctx: ActionContext<TAsyncEvents>,
  ) => Promise<void | AsyncEventResult>;
}

// ─── Validation rule builder ────────────────────────────────────────────────
export type ValidationRuleBuilder =
  (b: ValidationRuleBuilderArg) => ValidationRule;

export interface ValidationRuleBuilderArg {
  /** All inner rules must pass. */
  and(rules: ValidationRule[]): ValidationRule;
  /** Any inner rule passes. */
  or(rules: ValidationRule[]): ValidationRule;
  /** Negate. */
  not(rule: ValidationRule): ValidationRule;
  /** Inline custom predicate; the action sees the editor `state` only. */
  when(predicate: (state: ActionState) => boolean): ValidationRule;
}

/** A validation rule is either a built-in rule name (string-literal union, so
 *  typos surface at compile time) or a structured node returned from the
 *  builder helpers above. */
export type ValidationRule =
  | BuiltInValidationRuleName
  | { readonly _t: 'and' | 'or'; readonly rules: ValidationRule[] }
  | { readonly _t: 'not'; readonly rule: ValidationRule }
  | { readonly _t: 'when'; readonly fn: (state: ActionState) => boolean };

export type BuiltInValidationRuleName =
  | 'selectionNotEmpty'
  | 'selectionEmpty'
  | 'blockSupportsDecoration'
  | 'startOfBlock'
  | 'endOfBlock'
  | 'precededByWhitespace'
  | 'followedByWhitespace'
  | 'inEditableBlock'
  | 'notInCodeBlock';
// extensions register more via `registerValidationRule(name, fn)` —
// see 03-actions-and-triggers §3.

// ─── ActionState / ActionContext ────────────────────────────────────────────
export interface ActionState {
  readonly doc: Doc;
  readonly selection: Selection;
  readonly cursor: Position;          // collapsed selection's anchor
  readonly storedMarks: ReadonlyArray<MarkRef>;
  readonly schema: Schema;
}

export interface ActionContext<TAsyncEvents extends AsyncEventMap> {
  /** Builder; commit returns a Promise that resolves after the dispatch
   *  pipeline has applied the transaction (00-overview §5). */
  createTransaction(): TransactionBuilder;

  /** Strongly-typed async events. Resolves with the listener's return value;
   *  rejects if a `cancellationTrigger` fires before resolution. */
  triggerAsyncEvent<K extends keyof TAsyncEvents>(
    name: K,
    payload?: TAsyncEvents[K]['in'],
  ): Promise<AsyncEventResult<TAsyncEvents[K]['out']>>;

  getSchema(): Schema;
  getView(): EditorView | null;       // null during SSR or pre-attach
  dispatch(tr: Transaction): void;    // escape hatch for low-level use
  getRegistry(): Registry;            // blocks / marks / actions registry
}

export interface AsyncEventMap {
  [name: string]: { in: unknown; out: unknown };
}

export interface DefaultAsyncEventMap extends AsyncEventMap {
  showSlashCommandMenu:    { in: { anchor: Position }; out: SlashCommandPick | null };
  showMentionSuggestions:  { in: { anchor: Position }; out: MentionPick | null };
  showEmojiSuggestions:    { in: { anchor: Position }; out: EmojiPick | null };
}

export interface AsyncEventResult<TOut = unknown> {
  readonly status: 'resolved' | 'cancelled';
  readonly value?: TOut;
  readonly cancellationReason?: Trigger;
}
```

### Extensions over the wishlist

| Field                     | Wishlist | Extension justification |
|---------------------------|----------|-------------------------|
| `priority`                | ✅       | Already in wishlist (`priority: 1` on mention/emoji/cut/copy/paste). |
| Generic `TAsyncEvents`    | ⛌       | Required for `ctx.triggerAsyncEvent('showSlashCommandMenu')` to be type-safe. Default map covers all wishlist events. |
| `not`/`when` builders     | ⛌       | Symmetric with `and`/`or`; needed for any non-trivial validation. Cheap to add, costs nothing if unused. |
| `BuiltInValidationRuleName` literal | ⛌ | Wishlist uses bare strings (`"selectionNotEmpty"`); we type it as a literal union so typos fail the build. The two strings used in the wishlist are first-class members. |
| `getView`/`getRegistry`   | ⛌       | Required by built-in actions (paste handlers, slash menu) that need to know what blocks/marks are registered. |

### Architecture ties

- Triggers (section C) feed an **`ActionRouter`** ([03-actions-and-triggers §2](./03-actions-and-triggers.md)) which owns the keymap and clipboard listeners.
- `triggerValidationRules` is evaluated synchronously **before** `perform`; failure means the action does not match and the next-priority candidate is tried (03-actions-and-triggers §3).
- `cancellationTriggers` register a one-shot listener while `perform` is in-flight; firing rejects the `triggerAsyncEvent` promise with `{ status: 'cancelled' }` (03-actions-and-triggers §6).
- Async events are routed through the editor's **async event bus** ([04-input-and-paste §8](./04-input-and-paste.md), [07-react-bindings §6](./07-react-bindings.md)).

### Real-world usage

```ts
import { defineAction, triggers, type AsyncEventMap } from '@plim/core';

interface MyAsyncEvents extends AsyncEventMap {
  showLinkPrompt: { in: { initial?: string }; out: { href: string } | null };
}

const linkAction = defineAction<'link', MyAsyncEvents>('link', {
  trigger: triggers.keyboard.shortcut('Mod+k'),
  triggerValidationRules: ({ and, not }) =>
    and(['selectionNotEmpty', not('notInCodeBlock' as const)]),
  cancellationTriggers: [triggers.keyboard.key('Escape')],
  priority: 2,
  perform: async (state, ctx) => {
    const result = await ctx.triggerAsyncEvent('showLinkPrompt', {
      initial: state.selection.toString(),
    });
    if (result.status === 'cancelled' || !result.value) return;
    await ctx.createTransaction()
      .addMark('link', { href: result.value.href }, state.selection)
      .commit();
  },
});
```

---

## C. `triggers` namespace

### Wishlist (verbatim)

```ts
trigger: triggers.keyboard.shortcut('Mod+b')
trigger: triggers.keyboard.character('/')
cancellationTriggers: [ triggers.keyboard.key('Escape') ]
trigger: [ triggers.keyboard.shortcut('Mod+x'), triggers.clipboard.action('cut') ]
```

### Final signature

```ts
// Package: @plim/core
// Module:  @plim/core/triggers

export const triggers: TriggersNamespace;

export interface TriggersNamespace {
  readonly keyboard: KeyboardTriggers;
  readonly clipboard: ClipboardTriggers;
  readonly mouse: MouseTriggers;
  readonly composition: CompositionTriggers;
  readonly inputRule: InputRuleTriggers;
}

// ─── Keyboard ───────────────────────────────────────────────────────────────
export interface KeyboardTriggers {
  /** Modifier-aware combo. `Mod` = Cmd on macOS, Ctrl elsewhere. */
  shortcut(combo: KeyboardCombo): Trigger;

  /** A bare named key without modifiers (e.g. 'Escape', 'Enter', 'ArrowUp',
   *  'Space', 'Tab'). Matches `KeyboardEvent.key` exactly. */
  key(name: KeyboardKeyName): Trigger;

  /** A single printable character that the user typed (post-IME). Distinct
   *  from `key()` because '/' may come from Shift+7 on some layouts. */
  character(ch: string): Trigger;
}

export type KeyboardCombo =
  // Loose string for ergonomics; templated for autocomplete in IDEs.
  // Examples: 'Mod+b', 'Mod+Shift+z', 'Ctrl+Alt+ArrowDown'.
  | `${KeyboardModifier}+${string}`
  | `${KeyboardModifier}+${KeyboardModifier}+${string}`
  | `${KeyboardModifier}+${KeyboardModifier}+${KeyboardModifier}+${string}`;

export type KeyboardModifier = 'Mod' | 'Ctrl' | 'Cmd' | 'Alt' | 'Shift' | 'Meta';

export type KeyboardKeyName =
  | 'Enter' | 'Escape' | 'Tab' | 'Space' | 'Backspace' | 'Delete'
  | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'
  | 'Home' | 'End' | 'PageUp' | 'PageDown'
  | (string & {}); // allow any string for forward-compat without losing autocomplete

// ─── Clipboard ──────────────────────────────────────────────────────────────
export interface ClipboardTriggers {
  /** Native clipboard event. Fires for *both* keyboard-initiated and
   *  context-menu-initiated clipboard actions. */
  action(kind: 'cut' | 'copy' | 'paste'): Trigger;
}

// ─── Mouse / composition / input rule (extensions over wishlist) ────────────
export interface MouseTriggers {
  click(opts?: { button?: 0 | 1 | 2; count?: 1 | 2 | 3 }): Trigger;
  drop(): Trigger;
}
export interface CompositionTriggers {
  start(): Trigger;
  end(): Trigger;
}
export interface InputRuleTriggers {
  match(pattern: RegExp): Trigger;
}

// ─── Trigger union ──────────────────────────────────────────────────────────
export type Trigger =
  | { readonly kind: 'keyboard.shortcut';  readonly combo: KeyboardCombo }
  | { readonly kind: 'keyboard.key';       readonly name: KeyboardKeyName }
  | { readonly kind: 'keyboard.character'; readonly char: string }
  | { readonly kind: 'clipboard.action';   readonly action: 'cut' | 'copy' | 'paste' }
  | { readonly kind: 'mouse.click';        readonly button: 0 | 1 | 2; readonly count: 1 | 2 | 3 }
  | { readonly kind: 'mouse.drop' }
  | { readonly kind: 'composition.start' }
  | { readonly kind: 'composition.end' }
  | { readonly kind: 'inputRule.match';    readonly pattern: RegExp };
```

### Architecture ties

- Triggers are pure data; the **`ActionRouter`** ([03-actions-and-triggers §2](./03-actions-and-triggers.md)) maps them to DOM listeners on the `EditorView` root.
- `keyboard.character` is fired **after** IME composition completes, by the composition handler ([02-view-and-dom §6](./02-view-and-dom.md)).
- `inputRule.match` is the bridge from `defineInputRule` (04-input-and-paste §3) to the action system: an input rule emits a synthetic trigger that user-defined actions can listen for.

### Real-world usage

```ts
import { triggers, defineAction } from '@plim/core';

defineAction('savePage', {
  trigger: triggers.keyboard.shortcut('Mod+s'),
  perform: async (_state, _ctx) => { /* persist */ },
});

defineAction('quickInsert', {
  trigger: [
    triggers.keyboard.character('+'),
    triggers.mouse.click({ button: 2 }),
  ],
  perform: async (_state, ctx) => ctx.triggerAsyncEvent('showSlashCommandMenu'),
});
```

---

## D. `deriveEditor` and `attachContainer`

### Wishlist (verbatim)

```ts
import { deriveEditor, attachContainer } from '@plim/editor';
import { contentFromMarkdown } from '@plim/markdown';

const agnosticEditor = deriveEditor(plim, {
  containerAdapter: attachContainer(() => document.getElementById('editor')),
  initialContent: contentFromMarkdown('# Hello World', '', '...'),
  readonly: false,
  autoFocus: true,
});

agnosticEditor.onTransaction((transaction) => { /* ... */ });
agnosticEditor.onAsyncEvent('showSlashCommandMenu', async (event, state, ctx) => { /* ... */ });
agnosticEditor.isReady;
agnosticEditor.whenReady(() => { /* ... */ });
```

### Final signature

```ts
// Package: @plim/editor
// Module:  @plim/editor

export function deriveEditor(
  driver: PlimDriver,
  opts?: DeriveEditorOptions,
): AgnosticEditor;

export function attachContainer(
  getEl: () => HTMLElement | null,
): ContainerAdapter;

export interface DeriveEditorOptions {
  /** How the editor finds its host element. Lazy by design — the element
   *  may not exist when `deriveEditor` is called (React renders later). */
  containerAdapter?: ContainerAdapter;

  /** Initial content. See section E. Accepts markdown, JSON, or `ContentInput`. */
  initialContent?: ContentInput;

  readonly?: boolean;
  autoFocus?: boolean;

  /** Per-editor extension config. Keyed by extension id. */
  extensionConfig?: Record<string, unknown>;

  /** Per-editor theme override (falls back to driver theme). */
  theme?: Theme;
}

export interface ContainerAdapter {
  readonly kind: 'container';
  /** Lazily resolved by `EditorView` on each ready-check tick (rAF-throttled). */
  readonly resolve: () => HTMLElement | null;
}
```

### `AgnosticEditor`

```ts
export interface AgnosticEditor {
  // ── Reactive lifecycle ──────────────────────────────────────────────────
  readonly isReady: boolean;
  whenReady(cb: () => void): Unsubscribe;

  // ── Listening ───────────────────────────────────────────────────────────
  onTransaction(handler: TransactionListener): Unsubscribe;
  onAsyncEvent<K extends keyof DefaultAsyncEventMap>(
    name: K,
    handler: AsyncEventListener<DefaultAsyncEventMap, K>,
  ): Unsubscribe;
  onAsyncEvent<TMap extends AsyncEventMap, K extends keyof TMap>(
    name: K & string,
    handler: AsyncEventListener<TMap, K>,
  ): Unsubscribe;

  // ── State access ────────────────────────────────────────────────────────
  getState(): EditorState;
  getHistory(): History;     // editor-scoped, see section G
  getSchema(): Schema;

  // ── Mutation ────────────────────────────────────────────────────────────
  /** Low-level dispatch. Most code should go through actions or
   *  `ctx.createTransaction()` instead. */
  dispatch(tr: Transaction): void;

  /** Hot-update opts (readonly, autoFocus, theme, etc.). Triggers a view
   *  re-render but never a re-mount. */
  setProps(patch: Partial<DeriveEditorOptions>): void;

  // ── Snapshots ───────────────────────────────────────────────────────────
  takeSnapshot(meta?: SnapshotMeta): Snapshot;
  restoreSnapshot(snap: Snapshot, opts?: RestoreSnapshotOptions): void;

  // ── Teardown ────────────────────────────────────────────────────────────
  destroy(): void;
}

export type Unsubscribe = () => void;
export type TransactionListener = (tr: Transaction, state: EditorState) => void;
export type AsyncEventListener<TMap extends AsyncEventMap, K extends keyof TMap> = (
  event: { name: K & string; payload: TMap[K]['in'] },
  state: ActionState,
  ctx: ActionContext<TMap>,
) => Promise<TMap[K]['out'] | void>;

export interface RestoreSnapshotOptions {
  /** Clear undo/redo when restoring? Defaults to false (keeps history). */
  clearHistory?: boolean;
  /** Treat the restore as a single undoable group? Defaults to true. */
  recordInHistory?: boolean;
}
```

### Extensions over the wishlist

| Member             | Wishlist | Justification |
|--------------------|----------|---------------|
| `getState`/`dispatch`/`getHistory`/`getSchema` | ⛌ ext. | Required for any non-trivial host integration (toolbars, persistence). PM has all of these. |
| `setProps`         | ⛌ ext.  | Required by React `<PlimEditor />` to flow `readonly`/`autoFocus` updates without remount ([07-react-bindings §3](./07-react-bindings.md)). |
| `takeSnapshot`/`restoreSnapshot` | ⛌ ext. | Wishlist's Snapshot section uses them (`editor.restoreSnapshot(snapshot)`); we hoist them onto `AgnosticEditor`. |
| `destroy`          | ⛌ ext.  | Memory safety. |
| `whenReady` returns `Unsubscribe` | extends wishlist | Wishlist shows a callback; we keep the callback shape but also let consumers detach. Backwards compatible. |

### Architecture ties

- `attachContainer` solves the **timing problem** in [00-overview §3](./00-overview.md#3-layered-architecture): `@plim/core` builds the driver synchronously; React renders the host element later. The lazy `getEl` closure is polled on rAF until it returns non-null, then `EditorView` mounts and `isReady` flips to `true`.
- `onTransaction` is the public projection of the dispatch loop in [00-overview §5](./00-overview.md#5-end-to-end-data-flow-typing-the-letter-b).
- `onAsyncEvent` writes to the editor's async event bus; only one listener wins per event name (last-registered, with priority by registration order — see [03-actions-and-triggers §6](./03-actions-and-triggers.md)).

### Real-world usage

```ts
import { deriveEditor, attachContainer } from '@plim/editor';
import { contentFromMarkdown } from '@plim/markdown';

const editor = deriveEditor(plim, {
  containerAdapter: attachContainer(() => document.getElementById('editor')),
  initialContent: contentFromMarkdown('# Hello World'),
  autoFocus: true,
});

const offTx = editor.onTransaction((tr) => console.log('tx', tr.steps.length));
const offSlash = editor.onAsyncEvent('showSlashCommandMenu', async (e, state, _ctx) => {
  return openSlashUI(e.payload.anchor); // returns SlashCommandPick | null
});

editor.whenReady(() => editor.setProps({ readonly: false }));

// later
offTx();
offSlash();
editor.destroy();
```

---

## E. `contentFromMarkdown`

### Wishlist (verbatim)

```ts
const initialContent = contentFromMarkdown(
  '# Hello World',
  '',
  'This is a **markdown** content that will be converted to the editor\'s internal format on initialization.'
);
```

### Final signature

```ts
// Package: @plim/markdown
// Module:  @plim/markdown

/** Variadic form (matches wishlist exactly). */
export function contentFromMarkdown(...lines: string[]): ContentInput;
/** Single-string overload — convenience for cases where the caller already
 *  has a multi-line string (e.g. read from a file). */
export function contentFromMarkdown(source: string): ContentInput;
/** Array overload — convenience for caller-built arrays. */
export function contentFromMarkdown(lines: readonly string[]): ContentInput;
```

```ts
// Returned shape — opaque to callers, consumed by `deriveEditor` and
// `<PlimEditor initialContent={...} />`.
export interface ContentInput {
  readonly kind: 'content-input';
  /** Source format the editor will parse. */
  readonly format: 'markdown' | 'json' | 'plim-doc';
  readonly source: string | DocJSON;
}

// Sister helpers (extensions over wishlist; same `ContentInput` return type):
export function contentFromJSON(json: DocJSON): ContentInput;
export function contentFromHTML(html: string): ContentInput;          // @plim/html
export function contentFromPlimDoc(doc: Doc): ContentInput;           // @plim/core
```

### Extensions over the wishlist

- **String + array overloads** — preserves the variadic ergonomics for the wishlist case while accommodating realistic call sites (`fs.readFileSync(...).toString()`).
- **`contentFrom*` siblings** — same return type, same consumer; they keep the API cohesive.

### Architecture ties

- The actual markdown-to-state conversion happens **inside** `EditorState.create({ initialContent })` ([01-schema-and-state §6](./01-schema-and-state.md)). `contentFromMarkdown` does no work — it just tags the data with a discriminator so the state factory dispatches to the right parser.

### Real-world usage

```ts
import { contentFromMarkdown } from '@plim/markdown';
import { deriveEditor } from '@plim/editor';

const fromArgs   = contentFromMarkdown('# A', '', 'b');
const fromString = contentFromMarkdown('# A\n\nb');
const fromArray  = contentFromMarkdown(['# A', '', 'b']);

const editor = deriveEditor(plim, { initialContent: fromArgs });
```

---

## F. `<PlimEditor />` and React hooks

### Wishlist (verbatim)

```tsx
import { PlimEditor, useAsyncEventListener } from '@plim/react';

function MyEditor() {
  const initialContent = contentFromMarkdown(/* ... */);
  const onSlashCommandMenu = useAsyncEventListener('showSlashCommandMenu', async (event, state, ctx) => { /* ... */ });
  const onMentionSuggestions = useAsyncEventListener('showMentionSuggestions', /* ... */);
  const onEmojiSuggestions = useAsyncEventListener('showEmojiSuggestions', /* ... */);
  const editor = useEditorHandle();

  return (
    <PlimEditor
      plim={plim}
      handle={editor}
      initialContent={initialContent}
      readonly={false}
      autoFocus={true}
      onTransaction={(transaction) => { /* ... */ }}
      whenReady={() => { /* ... */ }}
      asyncEventListeners={[onSlashCommandMenu, onMentionSuggestions, onEmojiSuggestions]}
    />
  );
}
```

### Final signature

```ts
// Package: @plim/react
// Module:  @plim/react

import type { ReactNode, RefObject } from 'react';

export const PlimEditor: React.FC<PlimEditorProps>;

export interface PlimEditorProps {
  plim: PlimDriver;
  handle?: EditorHandleRef;

  initialContent?: ContentInput;
  readonly?: boolean;
  autoFocus?: boolean;
  theme?: Theme;

  className?: string;
  style?: React.CSSProperties;

  onTransaction?: TransactionListener;
  whenReady?: () => void;

  asyncEventListeners?: AsyncEventListenerEntry[];

  /** Custom child render — defaults to the managed div. Rare. */
  children?: ReactNode;
}

// ─── Hooks ──────────────────────────────────────────────────────────────────

/** Returns a stable handle whose `.current` is the live `AgnosticEditor`,
 *  or null until mount + ready. Pass it to `<PlimEditor handle={...} />`. */
export function useEditorHandle(): EditorHandleRef;

export interface EditorHandleRef extends RefObject<AgnosticEditor | null> {
  /** True once `<PlimEditor />` has mounted and `isReady` flipped. Mirrors
   *  `agnosticEditor.isReady` but is reactive (re-renders the host). */
  readonly isReady: boolean;
}

/** Builds an entry to pass into `<PlimEditor asyncEventListeners={[...]} />`.
 *  The hook auto-cleans on unmount and always invokes the latest closure. */
export function useAsyncEventListener<
  TMap extends AsyncEventMap = DefaultAsyncEventMap,
  K extends keyof TMap = keyof TMap,
>(
  name: K & string,
  handler: AsyncEventListener<TMap, K>,
): AsyncEventListenerEntry<TMap, K>;

export interface AsyncEventListenerEntry<
  TMap extends AsyncEventMap = AsyncEventMap,
  K extends keyof TMap = keyof TMap,
> {
  readonly _t: 'async-event-listener';
  readonly name: K & string;
  readonly handler: AsyncEventListener<TMap, K>;
}
```

### Architecture ties

- `<PlimEditor />` calls `deriveEditor(plim, { containerAdapter: attachContainer(() => divRef.current), ... })` on first render and `editor.destroy()` on unmount ([07-react-bindings §3](./07-react-bindings.md)).
- `useAsyncEventListener` returns a stable entry whose `.handler` indirects through a `useRef`, so it always invokes the latest closure (wishlist requirement: *"hook auto cleans on unmount, and ensures the latest callback is used"*).
- `setProps` is called in `useEffect` deps when `readonly`/`autoFocus`/`theme` change.

### Real-world usage

```tsx
import { PlimEditor, useEditorHandle, useAsyncEventListener } from '@plim/react';
import { contentFromMarkdown } from '@plim/markdown';

export function MyEditor({ plim }: { plim: PlimDriver }) {
  const editor = useEditorHandle();
  const onSlash = useAsyncEventListener('showSlashCommandMenu', async (e, state, _ctx) => {
    const pick = await openMenu(e.payload.anchor);
    return pick;
  });

  return (
    <PlimEditor
      plim={plim}
      handle={editor}
      initialContent={contentFromMarkdown('# Hello')}
      readonly={false}
      autoFocus
      onTransaction={(tr) => console.debug('tx', tr)}
      whenReady={() => console.log('ready')}
      asyncEventListeners={[onSlash]}
    />
  );
}
```

---

## G. History API

### Wishlist (verbatim)

```ts
const history = plim.getHistory();
history.undo();
history.redo();
history.canUndo;
history.canRedo;
history.onChange((historyState) => { /* ... */ });
```

### Final signature

```ts
// Package: @plim/core
// Module:  @plim/core/history

export interface History {
  // ── Wishlist surface ────────────────────────────────────────────────────
  undo(): boolean;     // returns true if something was undone
  redo(): boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  onChange(handler: (s: HistoryState) => void): Unsubscribe;

  // ── Extensions ──────────────────────────────────────────────────────────
  /** Drop all undo/redo state. */
  clear(): void;

  /** End the current undoable group; the next transaction starts a new one.
   *  Idempotent (no-op if there is no open group). */
  closeGroup(): void;

  /** True iff the editor is at exactly the state that was current when
   *  `markSaved()` was last called. */
  readonly atSavedCheckpoint: boolean;

  /** Record the current state as the "saved" checkpoint (e.g. after a
   *  successful persist). Resets the dirty bit. */
  markSaved(): void;

  /** Number of undoable steps currently retained. */
  readonly depth: number;

  /** Serialize for persistence or transport. */
  serialize(): HistoryJSON;

  /** Restore previously serialized history; replaces existing state. */
  restore(json: HistoryJSON): void;
}

export interface HistoryState {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly depth: number;
  readonly atSavedCheckpoint: boolean;
  readonly lastChangeAt: number;     // ms epoch
}

export interface HistoryJSON {
  readonly version: 1;
  readonly past: ReadonlyArray<HistoryEntryJSON>;
  readonly future: ReadonlyArray<HistoryEntryJSON>;
}
```

### Extensions over the wishlist

| Method               | Justification |
|----------------------|---------------|
| `clear()`            | Required after `restoreSnapshot({ clearHistory: true })`. |
| `closeGroup()`       | Lets toolbars force a checkpoint before/after a non-keyboard action so undo behaves intuitively (06-history-and-snapshots §4). |
| `atSavedCheckpoint`/`markSaved` | Standard "is the document dirty?" surface. Used by host apps to enable/disable Save buttons. |
| `depth`              | Diagnostics; used by the example app's debug panel. |
| `serialize`/`restore`| Mirrors `Snapshot.serialize`/`Snapshot.deserialize`. Required for "restore tab" type UX. |

### Architecture ties

- `plim.getHistory()` returns the **driver-level aggregate**, which forwards to the `History` of the most-recently-active editor (matches the wishlist's "the editor should have a built-in history system that allows for undo/redo functionality"). Each `AgnosticEditor` *also* has its own `getHistory()`.
- The history is implemented as a Plugin ([00-overview §4](./00-overview.md#4-core-primitives-canonical-names)) — see [06-history-and-snapshots §2](./06-history-and-snapshots.md).

### Real-world usage

```ts
const history = plim.getHistory();
history.onChange((s) => updateToolbar(s.canUndo, s.canRedo));

document.getElementById('undo')!.addEventListener('click', () => history.undo());
document.getElementById('redo')!.addEventListener('click', () => history.redo());

await persist(editor.takeSnapshot());
history.markSaved();
console.log(history.atSavedCheckpoint); // true until the next edit
```

---

## H. Extension API

### Wishlist (verbatim)

```ts
import { defineExtension } from '@plim/core';

const myExtension = defineExtension((editor: AgnosticEditor) => {
  return {
    name: 'myExtension',
    registeredBlocks: [/* ... */],
    registeredMarks:  [/* ... */],
    registeredActions:[/* ... */],
    onTransaction: (transaction, ctx) => { /* ... */ },
    onAsyncEvent: async (event, state, ctx) => { /* ... */ },
  };
});
```

### Final signature

```ts
// Package: @plim/core
// Module:  @plim/core/extensions

export function defineExtension<TConfig = void>(
  factory: ExtensionFactory<TConfig>,
): (config?: TConfig) => Extension;

export type ExtensionFactory<TConfig = void> = (
  editor: AgnosticEditor,
  config?: TConfig,
) => ExtensionDef;

export interface ExtensionDef {
  /** Stable, unique within a driver. Conflict throws at assembly. */
  name: string;

  registeredBlocks?:  RegisteredBlock[];
  registeredMarks?:   RegisteredMark[];
  registeredActions?: RegisteredAction[];

  /** Optional low-level plugins (decorations, input rules, etc.). */
  plugins?: Plugin[];

  /** Pre-dispatch hook. Return a transaction (or void) to append to the
   *  current dispatch — same contract as `Plugin.appendTransaction`. */
  onTransaction?: ExtensionTransactionHook;

  /** Async event handler. Last-registered listener wins per event. */
  onAsyncEvent?: ExtensionAsyncEventHook;

  /** Optional teardown — called when the editor is destroyed or the
   *  extension is removed via `driver.removeExtension`. */
  onDestroy?: () => void;
}

export type ExtensionTransactionHook = (
  tr: Transaction,
  ctx: ExtensionContext,
) => Transaction | void;

export type ExtensionAsyncEventHook = <K extends string>(
  event: { name: K; payload: unknown },
  state: ActionState,
  ctx: ActionContext<AsyncEventMap>,
) => Promise<unknown | void>;

export interface ExtensionContext {
  readonly editor: AgnosticEditor;
  readonly schema: Schema;
}
```

### Caching contract

> *Wishlist:* "Once initialized the extension will be cached and not re-processed on subsequent editor initializations, allowing for better performance when creating multiple editor instances with the same extensions."

The runtime contract:

1. `defineExtension(factory)` returns a **constructor function**. Each call to the constructor produces an `Extension { id, factory }` where `id` is a stable hash of `(factory.toString(), config)`.
2. `PlimDriver` holds a `Map<extensionId, ExtensionDef>` cache. The first editor created from the driver invokes `factory(editor, config)`; subsequent editors **reuse the cached `ExtensionDef`** (`registeredBlocks` etc. are pure data).
3. The `editor` argument to the factory is always the *current* editor; per-editor handlers (e.g. closures over `editor.dispatch`) are wrapped so the cached `ExtensionDef` is rebound on each new editor — see [05-extensions §6](./05-extensions.md).

### Architecture ties

- Extension registration is the assembly step in [00-overview §4](./00-overview.md#4-core-primitives-canonical-names). Conflicts throw (00-overview §12 "Can two extensions register the same block name?").
- `plugins` is the escape hatch into the low-level plugin contract (00-overview §4 row "Plugin").

### Real-world usage

```ts
import { defineExtension } from '@plim/core';

interface TocConfig { maxDepth?: number }

export const tocExtension = defineExtension<TocConfig>((editor, config) => ({
  name: 'toc',
  onTransaction(tr, ctx) {
    if (!tr.docChanged) return;
    rebuildToc(ctx.schema, ctx.editor.getState().doc, config?.maxDepth ?? 3);
  },
  onDestroy() { teardownToc(); },
}));

// usage:
const plim = new PlimDriver({
  extensions: [tocExtension({ maxDepth: 2 })],
  registeredBlocks: [/* ... */],
  registeredMarks:  [/* ... */],
});
```

---

## I. Snapshot API

### Wishlist (verbatim)

```ts
import { Snapshot } from '@plim/core';

const snapshot = new Snapshot(editor);
editor.restoreSnapshot(snapshot);
const serializedSnapshot = snapshot.serialize();
const deserializedSnapshot = Snapshot.deserialize(serializedSnapshot);
```

### Final signature

```ts
// Package: @plim/core
// Module:  @plim/core/snapshot

export class Snapshot {
  /** Capture the editor's current state. Equivalent to `editor.takeSnapshot()`. */
  constructor(editor: AgnosticEditor, meta?: SnapshotMeta);

  /** Stable id (uuid v7 — sortable by creation time). */
  readonly id: string;
  readonly createdAt: number;            // ms epoch
  readonly schemaVersion: string;        // from `Schema.version`
  readonly meta: Readonly<SnapshotMeta>;

  /** Stringified JSON suitable for storage (IndexedDB, network, file). */
  serialize(): string;

  /** Inverse of `serialize`. Throws on schema-version mismatch unless the
   *  caller passes `{ allowSchemaMigration: true }` and a migrator is
   *  registered (see 06-history-and-snapshots §7). */
  static deserialize(json: string, opts?: SnapshotDeserializeOptions): Snapshot;

  /** Internal — used by `editor.restoreSnapshot`. Public so 3rd-party
   *  storage layers can introspect. */
  toJSON(): SnapshotJSON;
}

export interface SnapshotMeta {
  /** Caller-provided label, e.g. 'pre-paste', 'auto-save@12:00:13'. */
  label?: string;
  /** Arbitrary bag for app-level data (user id, comment id, etc.). */
  data?: Readonly<Record<string, unknown>>;
}

export interface SnapshotJSON {
  readonly version: 1;
  readonly id: string;
  readonly createdAt: number;
  readonly schemaVersion: string;
  readonly meta: SnapshotMeta;
  readonly doc: DocJSON;
  readonly selection: SelectionJSON;
  readonly storedMarks: readonly MarkJSON[];
}

export interface SnapshotDeserializeOptions {
  allowSchemaMigration?: boolean;
}

// On the editor side (re-stated from section D):
//   editor.takeSnapshot(meta?: SnapshotMeta): Snapshot;
//   editor.restoreSnapshot(snap: Snapshot, opts?: RestoreSnapshotOptions): void;
```

### Architecture ties

- A `Snapshot` is a thin freeze of `EditorState` + selection + storedMarks + schema version ([06-history-and-snapshots §6](./06-history-and-snapshots.md)).
- `restoreSnapshot` produces a single composite `Transaction` that replaces the doc and selection in one step, so listeners see one transaction (00-overview §5 dispatch loop).
- Schema-version migration is out of scope here — see 06-history-and-snapshots §7.

### Real-world usage

```ts
import { Snapshot } from '@plim/core';

const snap = new Snapshot(editor, { label: 'before-experiment' });

await runExperimentalEdits(editor);

// undo all the experimental edits in one shot
editor.restoreSnapshot(snap, { clearHistory: false });

// persist for later recovery
await idb.set(snap.id, snap.serialize());

// restore on a future page load
const json = await idb.get(snap.id);
const restored = Snapshot.deserialize(json!);
editor.restoreSnapshot(restored);
```

---

## J. `defineBlock`

### Wishlist (verbatim)

```tsx
import { defineBlock, type BlockPayload } from '@plim/core';

const paragraphBlock = defineBlock({
  name: 'paragraph',
  type: 'standalone',     // "standalone" or "inline"
  nestable: true,
  toDOM: (payload: BlockPayload) => {
    const dom = document.createElement('p');
    dom.textContent = node.content;
    dom.setAttribute('data-block-type', 'paragraph');
    dom.setAttributes(payload.attributes);
    return dom;
  },
  toComponent: (payload: BlockPayload) => (
    <p data-block-type="paragraph" {...payload.attributes}>
      {payload.content}
    </p>
  ),
});
```

### Final signature

```ts
// Package: @plim/core
// Module:  @plim/core/blocks

export function defineBlock<
  TName extends string,
  TAttrs extends BlockAttrs = BlockAttrs,
>(spec: BlockSpec<TName, TAttrs>): RegisteredBlock<TAttrs> & { (): RegisteredBlock<TAttrs> };
// ↑ The result is callable so `paragraphBlock()` (wishlist style) works.
//   Calling it returns a fresh `RegisteredBlock` with the same spec — useful
//   when an app wants per-instance customization via `paragraphBlock({ ... })`.
```

```ts
export interface BlockSpec<
  TName extends string = string,
  TAttrs extends BlockAttrs = BlockAttrs,
> {
  name: TName;
  type: 'standalone' | 'inline';
  nestable?: boolean;          // default false
  atomic?: boolean;            // default false; when true, has no editable content
  isolating?: boolean;         // default false; selection won't cross the boundary

  /** Attribute schema. Drives the type of `payload.attributes`. */
  attributes?: AttributesSchema<TAttrs>;

  /** Content rule (which child block names are valid). Inline blocks default
   *  to 'inline*'. Standalone blocks default to 'inline*' (text + inline). */
  content?: ContentExpression;

  /** Optional default attributes when a block is created blank. */
  defaultAttributes?: TAttrs;

  toDOM:       (payload: BlockPayload<TName, TAttrs>) => HTMLElement;
  toComponent?: (payload: BlockPayload<TName, TAttrs>) => ReactNode;

  /** Reverse: parse a DOM element back into a block. Optional; if omitted,
   *  the schema cannot ingest external HTML for this block. */
  parseDOM?: ReadonlyArray<DOMParseRule<TAttrs>>;

  /** Optional input rules scoped to this block (e.g. `> ` → quote). */
  inputRules?: InputRule[];

  /** Optional keyboard shortcuts scoped to this block. */
  keyboardShortcuts?: Record<KeyboardCombo, BlockCommand<TName, TAttrs>>;
}
```

```ts
export interface BlockPayload<
  TName extends string = string,
  TAttrs extends BlockAttrs = BlockAttrs,
> {
  readonly id: string;                 // stable block id (00-overview §9)
  readonly type: TName;
  readonly attributes: TAttrs;         // ← typed via `BlockSpec.attributes`
  readonly content: ReactNode;         // for `toComponent` (already-rendered children)
  readonly contentText: string;        // for `toDOM` (flat text fallback)
  readonly children: ReadonlyArray<BlockPayload>;
  readonly state: BlockState;
}

export interface BlockState {
  readonly selected: boolean;
  readonly focused: boolean;
  readonly readonly: boolean;
}

export interface AttributesSchema<TAttrs extends BlockAttrs> {
  readonly [K in keyof TAttrs]: AttributeDef<TAttrs[K]>;
}

export interface AttributeDef<T> {
  readonly type: 'string' | 'number' | 'boolean' | 'enum' | 'json';
  readonly default?: T;
  readonly required?: boolean;
  readonly enum?: readonly T[];
  readonly validate?: (v: unknown) => v is T;
}

export type BlockAttrs = Record<string, unknown>;
```

### Generic propagation

```ts
const headingBlock = defineBlock({
  name: 'heading',
  type: 'standalone',
  attributes: {
    level: { type: 'enum', enum: [1, 2, 3] as const, default: 1, required: true },
  },
  // payload.attributes is inferred as { level: 1 | 2 | 3 }
  toDOM: (payload) => {
    const tag = `h${payload.attributes.level}` as const;
    const dom = document.createElement(tag);
    dom.textContent = payload.contentText;
    dom.setAttribute('data-block-type', 'heading');
    return dom;
  },
  toComponent: (payload) => {
    const Tag = (`h${payload.attributes.level}`) as 'h1' | 'h2' | 'h3';
    return <Tag data-block-type="heading">{payload.content}</Tag>;
  },
});
```

### Inline block (mention) example

```ts
interface MentionAttrs { userId: string; displayName: string }

export const mentionBlock = defineBlock<'mention', MentionAttrs>({
  name: 'mention',
  type: 'inline',
  atomic: true,
  attributes: {
    userId:      { type: 'string', required: true },
    displayName: { type: 'string', required: true },
  },
  toDOM: (payload) => {
    const span = document.createElement('span');
    span.setAttribute('data-block-type', 'mention');
    span.setAttribute('data-user-id', payload.attributes.userId);
    span.textContent = `@${payload.attributes.displayName}`;
    return span;
  },
  toComponent: (payload) => (
    <span data-block-type="mention" data-user-id={payload.attributes.userId}>
      @{payload.attributes.displayName}
    </span>
  ),
});
```

### Extensions over the wishlist

| Field                  | Justification |
|------------------------|---------------|
| `attributes`           | Required to type `payload.attributes`. Wishlist passes attributes implicitly via `BlockPayload.attributes`. |
| `atomic`/`isolating`/`content`/`defaultAttributes` | Required for inline blocks (mention, emoji), atomic blocks (image), and content validation (01-schema-and-state §4). |
| `parseDOM`             | Required for paste handling (04-input-and-paste §4). |
| `inputRules`/`keyboardShortcuts` | Block-scoped DX; the wishlist names "toolbar buttons and keyboard shortcuts" in the prose for blocks. |
| Generic `<TName, TAttrs>` | Required so `payload.attributes` is strongly typed at use sites. |
| Callable result        | Lets `paragraphBlock()` work as in the wishlist *and* `paragraphBlock({ defaultAttributes })` for per-instance config. |

> ⚠️ Note: the wishlist `toDOM` body refers to `node.content` (a typo for `payload.contentText`). Our `BlockPayload` exposes `contentText` (string) for `toDOM` and `content` (ReactNode) for `toComponent`, eliminating the ambiguity.

### Architecture ties

- `BlockSpec` rolls into `Schema` ([01-schema-and-state §3](./01-schema-and-state.md)).
- `toDOM` is the renderer for `EditorView` (02-view-and-dom §4); `toComponent` is the renderer for the React node-view bridge (07-react-bindings §5).
- `parseDOM` is consumed by `DOMParser` during paste/drop (04-input-and-paste §4).

---

## K. `defineMark`

### Wishlist (verbatim)

```tsx
import { defineMark, type MarkPayload } from '@plim/core';

const boldMark = defineMark({
  name: 'bold',
  toDOM: (payload: MarkPayload) => {
    const dom = document.createElement('strong');
    dom.textContent = payload.text;
    dom.setAttribute('data-mark-type', 'bold');
    dom.setAttributes(payload.attributes);
    return dom;
  },
  toComponent: (payload: MarkPayload) => (
    <strong data-mark-type="bold" {...payload.attributes}>
      {payload.text}
    </strong>
  ),
});
```

### Final signature

```ts
// Package: @plim/core
// Module:  @plim/core/marks

export function defineMark<
  TName extends string,
  TAttrs extends MarkAttrs = MarkAttrs,
>(spec: MarkSpec<TName, TAttrs>): RegisteredMark<TAttrs> & { (): RegisteredMark<TAttrs> };
```

```ts
export interface MarkSpec<
  TName extends string = string,
  TAttrs extends MarkAttrs = MarkAttrs,
> {
  name: TName;
  attributes?: AttributesSchema<TAttrs>;

  /** Marks of the same group cannot coexist on the same range
   *  (e.g. `'sizing'` for fontSize variants). */
  excludes?: string;
  inclusive?: boolean;        // does the mark stick to text typed after it?

  toDOM:       (payload: MarkPayload<TName, TAttrs>) => HTMLElement;
  toComponent?: (payload: MarkPayload<TName, TAttrs>) => ReactNode;

  parseDOM?: ReadonlyArray<DOMParseRule<TAttrs>>;

  // ── Extensions over wishlist ────────────────────────────────────────────
  keyboardShortcuts?: Record<KeyboardCombo, MarkCommand<TName, TAttrs>>;
  inputRules?: InputRule[];   // e.g. `**...**` → bold
  pasteRules?: PasteRule[];   // e.g. URL → link mark
}

export interface MarkPayload<
  TName extends string = string,
  TAttrs extends MarkAttrs = MarkAttrs,
> {
  readonly type: TName;
  readonly attributes: TAttrs;
  readonly text: string;
  readonly content: ReactNode;
}

export type MarkAttrs = Record<string, unknown>;
```

### Extensions over the wishlist

| Field                | Justification |
|----------------------|---------------|
| `keyboardShortcuts`  | Wishlist prose for marks: *"Marks should be able to define their own toolbar buttons and keyboard shortcuts."* |
| `inputRules`         | Required to power `**bold**`-style typing transformations (04-input-and-paste §3). |
| `pasteRules`         | Required for URL→link mark conversion on paste (04-input-and-paste §5). |
| `excludes`/`inclusive` | Standard PM-style mark behaviour; required to support stacking semantics correctly. |
| Generic `<TName, TAttrs>` | Same reasoning as `defineBlock`. |

### Real-world usage

```tsx
import { defineMark, triggers } from '@plim/core';

interface LinkAttrs { href: string; title?: string }

export const linkMark = defineMark<'link', LinkAttrs>({
  name: 'link',
  inclusive: false,
  attributes: {
    href:  { type: 'string', required: true },
    title: { type: 'string' },
  },
  keyboardShortcuts: {
    'Mod+k': (state, ctx) => ctx.triggerAsyncEvent('showLinkPrompt'),
  },
  pasteRules: [{
    pattern: /^https?:\/\/\S+$/,
    transform: (match) => ({ kind: 'addMark', name: 'link', attrs: { href: match[0] } }),
  }],
  toDOM: (payload) => {
    const a = document.createElement('a');
    a.href = payload.attributes.href;
    if (payload.attributes.title) a.title = payload.attributes.title;
    a.setAttribute('data-mark-type', 'link');
    a.textContent = payload.text;
    return a;
  },
  toComponent: (payload) => (
    <a data-mark-type="link" href={payload.attributes.href} title={payload.attributes.title}>
      {payload.content}
    </a>
  ),
});
```

---

## L. End-to-end compile test

This is the **complete** wishlist program assembled into one file. Every symbol resolves to a section above; every line type-checks under the signatures of A–K.

```tsx
// myapp/editor.tsx — compiles end-to-end against @plim/* with the signatures above.

// ── A. PlimDriver, defineAction, triggers ──────────────────────────────────
import {
  PlimDriver,
  defineAction,
  triggers,
  Snapshot,
  defineExtension,
  defineBlock,
  defineMark,
  type AgnosticEditor,
  type AsyncEventMap,
} from '@plim/core';

// ── J/K. Built-in blocks and marks (each is `defineBlock(...)` /
//        `defineMark(...)` from sections J/K) ────────────────────────────────
import {
  paragraphBlock, headingBlock, imageBlock,
  numberedListBlock, bulletedListBlock, horizontalRuleBlock,
  quoteBlock, codeBlock, embeddedMediaBlock, rawHTMLBlock, tableBlock,
} from '@plim/blocks';
import {
  boldMark, italicMark, underlineMark, strikethroughMark,
  codeMark, linkMark, highlightMark,
} from '@plim/marks';

// ── D. deriveEditor + attachContainer ──────────────────────────────────────
import { deriveEditor, attachContainer } from '@plim/editor';

// ── E. contentFromMarkdown ─────────────────────────────────────────────────
import { contentFromMarkdown } from '@plim/markdown';

// ── F. React bindings ──────────────────────────────────────────────────────
import {
  PlimEditor,
  useEditorHandle,
  useAsyncEventListener,
} from '@plim/react';

// ── A. Driver construction (verbatim shape from wishlist lines 9–139) ──────
const plim = new PlimDriver({
  theme: 'light',
  extensions: [],
  registeredMarks: [
    boldMark(), italicMark(), underlineMark(), strikethroughMark(),
    codeMark(), linkMark(), highlightMark(),
  ],
  registeredBlocks: [
    paragraphBlock(), headingBlock(), imageBlock(),
    numberedListBlock(), bulletedListBlock(), horizontalRuleBlock(),
    quoteBlock(), codeBlock(), embeddedMediaBlock(), rawHTMLBlock(), tableBlock(),
  ],
  registeredActions: [
    defineAction('bold', {
      trigger: triggers.keyboard.shortcut('Mod+b'),
      triggerValidationRules: ({ and }) =>
        and(['selectionNotEmpty', 'blockSupportsDecoration']),
      perform: async (state, ctx) => {
        const { from, to } = state.selection;
        await ctx.createTransaction()
          .toggleMark('bold', { from, to })
          .commit();
      },
    }),
    defineAction('slashCommand', {
      trigger: triggers.keyboard.character('/'),
      triggerValidationRules: ({ or }) =>
        or(['startOfBlock', 'precededByWhitespace']),
      cancellationTriggers: [triggers.keyboard.key('Escape')],
      perform: async (_state, ctx) =>
        ctx.triggerAsyncEvent('showSlashCommandMenu'),
    }),
    defineAction('mention', {
      trigger: triggers.keyboard.character('@'),
      triggerValidationRules: ({ or }) =>
        or(['startOfBlock', 'precededByWhitespace']),
      cancellationTriggers: [
        triggers.keyboard.key('Escape'),
        triggers.keyboard.key('Space'),
      ],
      priority: 1,
      perform: async (_state, ctx) =>
        ctx.triggerAsyncEvent('showMentionSuggestions'),
    }),
    defineAction('emoji', {
      trigger: triggers.keyboard.character(':'),
      triggerValidationRules: ({ or }) =>
        or(['startOfBlock', 'precededByWhitespace']),
      cancellationTriggers: [
        triggers.keyboard.key('Escape'),
        triggers.keyboard.key('Space'),
        triggers.keyboard.character(':'),
      ],
      priority: 1,
      perform: async (_state, ctx) =>
        ctx.triggerAsyncEvent('showEmojiSuggestions'),
    }),
    defineAction('cut', {
      trigger: [triggers.keyboard.shortcut('Mod+x'), triggers.clipboard.action('cut')],
      priority: 1,
      perform: async (_state, _ctx) => { /* custom clipboard data */ },
    }),
    defineAction('copy', {
      trigger: [triggers.keyboard.shortcut('Mod+c'), triggers.clipboard.action('copy')],
      priority: 1,
      perform: async (_state, _ctx) => { /* custom clipboard data */ },
    }),
    defineAction('paste', {
      trigger: [triggers.keyboard.shortcut('Mod+v'), triggers.clipboard.action('paste')],
      priority: 1,
      perform: async (_state, _ctx) => { /* read custom clipboard data */ },
    }),
  ],
});

// ── D. Agnostic editor (wishlist lines 144–185) ───────────────────────────
const agnosticEditor = deriveEditor(plim, {
  containerAdapter: attachContainer(() => document.getElementById('editor')),
  initialContent: contentFromMarkdown(
    '# Hello World',
    '',
    "This is a **markdown** content that will be converted to the editor's internal format on initialization.",
  ),
  readonly: false,
  autoFocus: true,
});

agnosticEditor.onTransaction((_tr) => { /* handle */ });
agnosticEditor.onAsyncEvent('showSlashCommandMenu',   async (_e, _state, _ctx) => null);
agnosticEditor.onAsyncEvent('showMentionSuggestions', async (_e, _state, _ctx) => null);
agnosticEditor.onAsyncEvent('showEmojiSuggestions',   async (_e, _state, _ctx) => null);

void agnosticEditor.isReady;
agnosticEditor.whenReady(() => { /* ready */ });

// ── F. React component (wishlist lines 187–233) ────────────────────────────
function MyEditor() {
  const initialContent = contentFromMarkdown(
    '# Hello World',
    '',
    "This is a **markdown** content that will be converted to the editor's internal format on initialization.",
  );

  const onSlashCommandMenu   = useAsyncEventListener('showSlashCommandMenu',   async (_e, _state, _ctx) => null);
  const onMentionSuggestions = useAsyncEventListener('showMentionSuggestions', async (_e, _state, _ctx) => null);
  const onEmojiSuggestions   = useAsyncEventListener('showEmojiSuggestions',   async (_e, _state, _ctx) => null);

  const editor = useEditorHandle();

  return (
    <PlimEditor
      plim={plim}
      handle={editor}
      initialContent={initialContent}
      readonly={false}
      autoFocus={true}
      onTransaction={(_tr) => { /* handle */ }}
      whenReady={() => { /* ready */ }}
      asyncEventListeners={[onSlashCommandMenu, onMentionSuggestions, onEmojiSuggestions]}
    />
  );
}

// ── G. History (wishlist lines 240–251) ────────────────────────────────────
const history = plim.getHistory();
history.undo();
history.redo();
void history.canUndo;
void history.canRedo;
history.onChange((_s) => { /* update toolbar */ });

// ── H. Extension (wishlist lines 257–283) ──────────────────────────────────
const myExtension = defineExtension((editor: AgnosticEditor) => ({
  name: 'myExtension',
  registeredBlocks: [],
  registeredMarks:  [],
  registeredActions:[],
  onTransaction: (_tr, _ctx) => { /* ... */ },
  onAsyncEvent: async (_e, _state, _ctx) => { /* ... */ },
}));
plim.addExtension(myExtension());

// ── I. Snapshot (wishlist lines 291–305) ───────────────────────────────────
const snapshot = new Snapshot(agnosticEditor);
agnosticEditor.restoreSnapshot(snapshot);
const serializedSnapshot = snapshot.serialize();
const deserializedSnapshot = Snapshot.deserialize(serializedSnapshot);
agnosticEditor.restoreSnapshot(deserializedSnapshot);

export { plim, agnosticEditor, history, MyEditor };
```

Symbol-by-symbol resolution:

| Symbol                | Origin                    | Section |
|-----------------------|---------------------------|---------|
| `PlimDriver`          | `@plim/core`              | A |
| `defineAction`        | `@plim/core`              | B |
| `triggers`            | `@plim/core`              | C |
| `Snapshot`            | `@plim/core`              | I |
| `defineExtension`     | `@plim/core`              | H |
| `defineBlock`/`defineMark` | `@plim/core`         | J / K |
| `paragraphBlock` … `tableBlock` | `@plim/blocks`  | J |
| `boldMark` … `highlightMark` | `@plim/marks`      | K |
| `deriveEditor`/`attachContainer` | `@plim/editor` | D |
| `contentFromMarkdown` | `@plim/markdown`          | E |
| `PlimEditor`/`useEditorHandle`/`useAsyncEventListener` | `@plim/react` | F |
| `AgnosticEditor` (type) | `@plim/core` re-export of `@plim/editor` type for ergonomics | D |

Every symbol that appears in `api-wishlist.md` is accounted for.

---

## M. API stability matrix

| API                            | Package         | Status               | Notes |
|--------------------------------|-----------------|----------------------|-------|
| `new PlimDriver(config)`       | `@plim/core`    | **stable**           | Core construction surface — covered by §A. |
| `PlimDriver#getSchema`         | `@plim/core`    | **stable**           | |
| `PlimDriver#getHistory`        | `@plim/core`    | **stable**           | Wishlist API. |
| `PlimDriver#createEditor`      | `@plim/core`    | stable (sugar)       | Wraps `deriveEditor`. |
| `PlimDriver#destroy`           | `@plim/core`    | **stable**           | |
| `PlimDriver#addExtension`/`removeExtension` | `@plim/core` | experimental | Hot-attach semantics still TBD only at the **schema-rebuild** edge cases (05-extensions §6). API shape is stable. |
| `defineAction`                 | `@plim/core`    | **stable**           | |
| `triggers.keyboard.*`          | `@plim/core`    | **stable**           | |
| `triggers.clipboard.*`         | `@plim/core`    | **stable**           | |
| `triggers.mouse.*`/`composition.*`/`inputRule.*` | `@plim/core` | experimental | Beyond the wishlist; may evolve with paste/drop work. |
| `BuiltInValidationRuleName` literals | `@plim/core` | experimental | Adding new built-ins is non-breaking; renaming is. |
| `deriveEditor`/`attachContainer` | `@plim/editor`| **stable**           | |
| `AgnosticEditor`               | `@plim/editor`  | **stable**           | |
| `AgnosticEditor#setProps`      | `@plim/editor`  | experimental         | Patch shape may grow. |
| `contentFromMarkdown` (variadic) | `@plim/markdown` | **stable**         | |
| `contentFromMarkdown(string)` / `(string[])` overloads | `@plim/markdown` | stable (extension) | |
| `contentFromJSON`/`contentFromHTML`/`contentFromPlimDoc` | `@plim/markdown` / `@plim/html` / `@plim/core` | experimental | |
| `<PlimEditor />`               | `@plim/react`   | **stable**           | |
| `useEditorHandle`              | `@plim/react`   | **stable**           | |
| `useAsyncEventListener`        | `@plim/react`   | **stable**           | |
| `History` (wishlist surface)   | `@plim/core`    | **stable**           | |
| `History#clear`/`closeGroup`/`markSaved`/`atSavedCheckpoint`/`depth`/`serialize`/`restore` | `@plim/core` | stable (extension) | |
| `defineExtension`              | `@plim/core`    | **stable**           | Caching contract is normative. |
| `ExtensionDef.plugins`         | `@plim/core`    | advanced             | Low-level escape hatch. |
| `Snapshot`                     | `@plim/core`    | **stable**           | |
| `Snapshot` schema migration     | `@plim/core`    | experimental         | See 06-history-and-snapshots §7. |
| `defineBlock`                  | `@plim/core`    | **stable**           | |
| `BlockSpec.parseDOM`/`inputRules`/`keyboardShortcuts` | `@plim/core` | stable (extension) | |
| `defineMark`                   | `@plim/core`    | **stable**           | |
| `MarkSpec.inputRules`/`pasteRules`/`keyboardShortcuts` | `@plim/core` | stable (extension) | |
| `Plugin` contract              | `@plim/core`    | internal-but-public  | Used by extensions writing low-level rules. Changes go through deprecation. |
| `Step`/`Mapping`               | `@plim/core`    | internal-but-public  | Same as PM — power users need them. |
| `EditorView`/`ViewDesc`        | `@plim/view`    | internal-but-public  | Most callers go through `AgnosticEditor`. |

Status legend:
- **stable**: contract from this doc; breaking changes require a major bump.
- **experimental**: shape may evolve in minor versions until promoted.
- **advanced**: stable but for power users; expect to read `04-input-and-paste`/`05-extensions`.
- **internal-but-public**: exported because extensions need it; not part of the wishlist surface.

---

## N. Index of exported symbols

Alphabetical. Each entry: `symbol` — package — section.

- `Action` (type) — `@plim/core` — see [00-overview §4](./00-overview.md#4-core-primitives-canonical-names); used in B
- `ActionContext` — `@plim/core` — B
- `ActionOptions` — `@plim/core` — B
- `ActionState` — `@plim/core` — B
- `AgnosticEditor` — `@plim/editor` — D
- `AsyncEventListener` — `@plim/editor` — D
- `AsyncEventListenerEntry` — `@plim/react` — F
- `AsyncEventMap` — `@plim/core` — B
- `AsyncEventResult` — `@plim/core` — B
- `attachContainer` — `@plim/editor` — D
- `AttributeDef` — `@plim/core` — J
- `AttributesSchema` — `@plim/core` — J
- `BlockAttrs` — `@plim/core` — J
- `BlockPayload` — `@plim/core` — J
- `BlockSpec` — `@plim/core` — J
- `BlockState` — `@plim/core` — J
- `BuiltInValidationRuleName` — `@plim/core` — B
- `ClipboardTriggers` — `@plim/core` — C
- `CompositionTriggers` — `@plim/core` — C
- `ContainerAdapter` — `@plim/editor` — D
- `ContentInput` — `@plim/markdown` (re-exported by `@plim/core`) — E
- `contentFromHTML` — `@plim/html` — E
- `contentFromJSON` — `@plim/markdown` — E
- `contentFromMarkdown` — `@plim/markdown` — E
- `contentFromPlimDoc` — `@plim/core` — E
- `defaultAsyncEventMap` (`DefaultAsyncEventMap` type) — `@plim/core` — B
- `defineAction` — `@plim/core` — B
- `defineBlock` — `@plim/core` — J
- `defineExtension` — `@plim/core` — H
- `defineMark` — `@plim/core` — K
- `deriveEditor` — `@plim/editor` — D
- `DeriveEditorOptions` — `@plim/editor` — D
- `EditorHandleRef` — `@plim/react` — F
- `EditorState` — `@plim/core` — see [00-overview §4](./00-overview.md#4-core-primitives-canonical-names)
- `EditorView` — `@plim/view` — see [00-overview §4](./00-overview.md#4-core-primitives-canonical-names)
- `Extension` — `@plim/core` — A, H
- `ExtensionAsyncEventHook` — `@plim/core` — H
- `ExtensionContext` — `@plim/core` — H
- `ExtensionDef` — `@plim/core` — H
- `ExtensionFactory` — `@plim/core` — H
- `ExtensionTransactionHook` — `@plim/core` — H
- `History` — `@plim/core` — G
- `HistoryJSON` — `@plim/core` — G
- `HistoryState` — `@plim/core` — G
- `InputRuleTriggers` — `@plim/core` — C
- `KeyboardCombo` — `@plim/core` — C
- `KeyboardKeyName` — `@plim/core` — C
- `KeyboardModifier` — `@plim/core` — C
- `KeyboardTriggers` — `@plim/core` — C
- `MarkAttrs` — `@plim/core` — K
- `MarkPayload` — `@plim/core` — K
- `MarkSpec` — `@plim/core` — K
- `MouseTriggers` — `@plim/core` — C
- `PlimDriver` — `@plim/core` — A
- `PlimDriverConfig` — `@plim/core` — A
- `PlimEditor` — `@plim/react` — F
- `PlimEditorProps` — `@plim/react` — F
- `Plugin` — `@plim/core` — see [00-overview §4](./00-overview.md#4-core-primitives-canonical-names)
- `RegisteredAction` — `@plim/core` — A, B
- `RegisteredBlock` — `@plim/core` — A, J
- `RegisteredMark` — `@plim/core` — A, K
- `RestoreSnapshotOptions` — `@plim/core` — D, I
- `Schema` — `@plim/core` — see [00-overview §4](./00-overview.md#4-core-primitives-canonical-names)
- `Snapshot` — `@plim/core` — I
- `SnapshotDeserializeOptions` — `@plim/core` — I
- `SnapshotJSON` — `@plim/core` — I
- `SnapshotMeta` — `@plim/core` — I
- `Theme` — `@plim/core` — A
- `ThemeName` — `@plim/core` — A
- `ThemeTokens` — `@plim/core` — A
- `Transaction` — `@plim/core` — see [00-overview §4](./00-overview.md#4-core-primitives-canonical-names)
- `TransactionListener` — `@plim/editor` — D
- `Trigger` — `@plim/core` — C
- `triggers` — `@plim/core` — C
- `TriggersNamespace` — `@plim/core` — C
- `Unsubscribe` — `@plim/editor` — D
- `useAsyncEventListener` — `@plim/react` — F
- `useEditorHandle` — `@plim/react` — F
- `ValidationRule` — `@plim/core` — B
- `ValidationRuleBuilder` — `@plim/core` — B
- `ValidationRuleBuilderArg` — `@plim/core` — B

---

*End of 09. The contract above is normative for `@plim/*` package authors and consumers.*
