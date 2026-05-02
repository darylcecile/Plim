# 19 · Commands, Keymap, and Input Rules

> Source citations:
> - `prosemirror-commands/src/commands.ts` (783 lines)
> - `prosemirror-keymap/src/keymap.ts` (109 lines)
> - `prosemirror-inputrules/src/{inputrules,rules,rulebuilders,index}.ts`
> - `prosemirror-schema-list/src/schema-list.ts` (267 lines)

This file dissects the three layers that translate user *intent* into
*transactions*: the **Command** primitive, the **keymap plugin** that
dispatches keyboard events to commands, and the **input rules plugin**
that fires text-driven transformations as the user types.

---

## 1. The `Command` Signature

```ts
type Command = (
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
  view?: EditorView
) => boolean
```

Defined in `prosemirror-state` and re-imported in `commands.ts:5`. Every
command in ProseMirror obeys this contract.

### 1.1 Dual-mode pattern (dry-run vs apply)

The defining convention of ProseMirror commands: `dispatch` is **optional**.

| Mode       | Caller passes  | Command does                                    | Returns       |
|------------|----------------|-------------------------------------------------|---------------|
| **Dry-run** | `state` only   | Compute whether the action is possible          | `true`/`false` |
| **Apply**   | `state, dispatch` | Build a transaction and call `dispatch(tr)`     | `true`/`false` |

The same boolean is returned in both modes. This lets a menu/toolbar call
the command with `dispatch = undefined` to grey out an item, then call it
again with the real `dispatch` when the user clicks. The pattern is
visible everywhere — for example `deleteSelection` (`commands.ts:9–13`):

```ts
export const deleteSelection: Command = (state, dispatch) => {
  if (state.selection.empty) return false
  if (dispatch) dispatch(state.tr.deleteSelection().scrollIntoView())
  return true
}
```

The `view` argument is the documented **escape hatch** for behaviours
that need DOM-level information — in `commands.ts` it is used by the
deletion family to call `view.endOfTextblock("backward"|"forward", state)`,
which is the only bidi-aware way to know whether the cursor is visually
at the start/end of a textblock (`commands.ts:17, 143, 163, 175`).

### 1.2 Idiom: `if (dispatch) dispatch(state.tr…scrollIntoView())`

Almost every built-in command ends with `.scrollIntoView()` so that
keyboard-driven mutations keep the cursor visible. Commands that only
move the selection (e.g. `selectParentNode` at `commands.ts:428`) omit
`scrollIntoView` deliberately.

---

## 2. Built-in Commands (one-by-one)

### 2.1 Reference table

| Command | File:line | Selection requirement | What it does |
|---|---|---|---|
| `deleteSelection` | `commands.ts:9` | non-empty | `tr.deleteSelection()` |
| `joinBackward` | `commands.ts:30` | empty cursor at block-start | Join with previous block, or lift, or eat atom |
| `joinTextblockBackward` | `commands.ts:80` | empty cursor at block-start | Limited form: only joins textblocks |
| `joinTextblockForward` | `commands.ts:90` | empty cursor at block-end | Mirror of above |
| `selectNodeBackward` | `commands.ts:138` | empty, start of textblock | `NodeSelection` of node before |
| `joinForward` | `commands.ts:174` | empty cursor at block-end | Mirror of `joinBackward` |
| `selectNodeForward` | `commands.ts:217` | empty, end of textblock | `NodeSelection` of node after |
| `joinUp` | `commands.ts:244` | any | Join selected/ancestor block with sibling above |
| `joinDown` | `commands.ts:263` | any | Join with sibling below |
| `lift` | `commands.ts:279` | any | `tr.lift(blockRange, liftTarget)` |
| `newlineInCode` | `commands.ts:290` | inside `code` textblock | Insert `\n` literal |
| `exitCode` | `commands.ts:308` | inside `code` textblock | Insert default block after, move cursor |
| `createParagraphNear` | `commands.ts:323` | non-text NodeSelection | Insert default block before/after |
| `liftEmptyBlock` | `commands.ts:339` | empty cursor in empty textblock | Split or lift |
| `splitBlockAs(fn)` | `commands.ts:357` | factory | Split current textblock; custom resulting type |
| `splitBlock` | `commands.ts:409` | (Enter) | `splitBlockAs()` with no override |
| `splitBlockKeepMarks` | `commands.ts:413` | (Enter w/ marks) | Like `splitBlock`, preserves stored marks |
| `selectParentNode` | `commands.ts:423` | any | Wrap selection in `NodeSelection` of parent |
| `selectAll` | `commands.ts:433` | any | `AllSelection(doc)` |
| `selectTextblockStart` | `commands.ts:524` | any | `selectTextblockSide(-1)` |
| `selectTextblockEnd` | `commands.ts:527` | any | `selectTextblockSide(1)` |
| `wrapIn(type, attrs?)` | `commands.ts:533` | factory | `findWrapping` + `tr.wrap` |
| `setBlockType(type, attrs?)` | `commands.ts:545` | factory | `tr.setBlockType` over each range |
| `toggleMark(type, attrs?, opts?)` | `commands.ts:611` | factory | Add/remove mark on ranges or stored-marks |
| `autoJoin(cmd, predicate)` | `commands.ts:717` | wrapper | After cmd runs, join joinable siblings touched by the transaction |
| `chainCommands(...cmds)` | `commands.ts:728` | wrapper | Try each in order until one returns `true` |

### 2.2 Walks

#### `joinBackward` (`commands.ts:30–75`)

The most subtle command in the file. It is bound to **Backspace** when
the cursor is at the start of a block. The algorithm:

1. **Cursor check**: `atBlockStart` returns the `$cursor` only if the
   selection is a collapsed `TextSelection` AND the cursor is at the
   visual start of the textblock. With a `view`, it uses
   `view.endOfTextblock("backward", state)` for bidi-correct detection;
   otherwise it falls back to `$cursor.parentOffset > 0` (`commands.ts:15–21`).
2. **Find cut**: `findCutBefore($cursor)` walks up the depth chain until
   it finds an ancestor with a previous sibling. It bails if any ancestor
   has `spec.isolating` set (`commands.ts:153–159`). Returns the position
   *between* the previous sibling and our ancestor.
3. **No cut → lift**: if there's no node before us at any depth, attempt
   `liftTarget` on the cursor's `blockRange()`. If lift works, do it.
4. **`deleteBarrier($cut, dir=-1)`**: the heavy lifting (see §2.3).
5. **Empty-block + selectable predecessor**: if the current textblock is
   empty and the previous node is a selectable atom or contains a
   textblock at its end, climb depths, find a `replaceStep` that actually
   shrinks content, and either move the selection to the end of the
   textblock-at-end or select the predecessor as a `NodeSelection`
   (`commands.ts:50–66`).
6. **Atom predecessor**: if `before.isAtom` and the cut is exactly one
   level above the cursor, just `tr.delete` the atom (`commands.ts:69–72`).
7. Otherwise return `false` so the next command in the chain
   (`selectNodeBackward`) gets a chance.

`joinForward` (`commands.ts:174–209`) is the symmetric mirror.

#### `deleteBarrier` (`commands.ts:452–505`) — the join algorithm

Called by both `joinBackward` and `joinForward` with a `$cut` position
between two siblings and a direction. Strategies tried in order:

1. **Plain merge**: if neither side is `isolating` and `joinMaybeClear`
   succeeds, use it. `joinMaybeClear` (`commands.ts:438–450`) covers two
   sub-cases:
   - `before` is empty and parent permits removing it ⇒ `tr.delete` the
     empty node.
   - Otherwise `tr.join($pos)` if join is structurally valid.
2. **Wrap-and-join**: if the current parent could replace `[index, index+1]`
   and `before.contentMatchAt(end).findWrapping(after.type)` returns a
   wrapping path that can validly end the content, build that wrapping
   inside `before` via `ReplaceAroundStep` and then attempt to join the
   resulting structure with the next sibling if compatible (`commands.ts:457–473`).
   This is what folds an empty paragraph after a list back into the list,
   for example.
3. **Lift after**: take the next selection forward (`Selection.findFrom`),
   compute its `blockRange`, and if `liftTarget >= $cut.depth`, lift it
   into the current parent (`commands.ts:475–480`).
4. **Slot textblocks**: if both sides have textblocks at the boundary,
   build a `ReplaceAroundStep` that pulls `after`'s textblock content
   into `before`'s deepest textblock (`commands.ts:482–502`).

These four strategies are why a single Backspace can do "join paragraphs",
"merge into list item", "lift quoted paragraph out of blockquote", or
"merge headings" depending on document shape.

#### `selectNodeBackward` / `selectNodeForward` (`commands.ts:138, 217`)

Pure selection commands meant as the **last fallback** in the Backspace/
Delete chains. If `joinBackward` couldn't merge — typically because the
node before is an atom or schema-isolated — these promote the node into
a `NodeSelection`, giving the user a "selected box" they can confirm-
delete with another keystroke.

#### `lift` (`commands.ts:279`)

Two-line wrapper around `prosemirror-transform`'s
`liftTarget($from.blockRange($to))`.

#### `newlineInCode` (`commands.ts:290`) and `exitCode` (`commands.ts:308`)

Both check `$head.parent.type.spec.code` and require `$head.sameParent($anchor)`.
- `newlineInCode` simply inserts `"\n"`.
- `exitCode` finds a default textblock type via `defaultBlockAt`
  (`commands.ts:297–303`, walks `match.edge(i)` for any non-required-attr
  textblock type), inserts a fresh `type.createAndFill()` after the code
  block, and moves the cursor into it via `Selection.near(..., 1)`.

#### `createParagraphNear` (`commands.ts:323`)

Active when neither end of the selection is in inline content (i.e. a
node-selection of a block, e.g. an image). Computes a default textblock
from the parent's content match at `$to.indexAfter()` and inserts it
either *before* the selected node (if it's the parent's first child and
`$from.parentOffset == 0`) or *after* it.

#### `liftEmptyBlock` (`commands.ts:339`)

Bound after `createParagraphNear` in the Enter chain. Two paths:

1. If the cursor is in a depth-≥2 empty block and the textblock isn't the
   last child of its grand-ancestor (`$cursor.after() != $cursor.end(-1)`),
   `canSplit($before)` ⇒ `tr.split($before)`. This is what makes pressing
   Enter inside the second-to-last empty `<li>` *break out* of the list.
2. Otherwise compute `blockRange()` + `liftTarget` and lift.

#### `splitBlockAs` / `splitBlock` (`commands.ts:357–419`)

Walked here in detail because Enter is the most-bound key in any editor:

1. **NodeSelection on a block**: if the user has selected an entire
   block-level node, only split if the cursor isn't at offset 0 and
   `canSplit` is true at that exact position (`commands.ts:362–366`).
2. **Walk depths upward** from `$from.depth` looking for an `isBlock`
   ancestor (`commands.ts:371–385`). Tracks:
   - `atEnd`: cursor sits at `$from.end(d)` (i.e. end of that block).
   - `atStart`: cursor sits at `$from.start(d)`.
   - `deflt`: default textblock type for the *containing* parent's
     content match at the index *after* this block.
   - `splitType`: the user-supplied override (used by `splitBlockKeepMarks`'s
     callers and by markdown-style enter handlers).
   - `types[]`: a stack of `{type, attrs}` (or `null`) entries to pass
     into `tr.split`.
3. **Delete current selection** if it's text (`commands.ts:388`) — split
   semantically *replaces* the selected text with a paragraph break.
4. **Probe `canSplit`** with the proposed types; if it fails, retry with
   `[deflt]` only. If that also fails, return `false` (`commands.ts:390–395`).
5. **Apply split**, then if the cursor was at `atStart && !atEnd` and the
   pre-split block wasn't already the default, **change the now-orphaned
   front block's type to `deflt`** (`commands.ts:397–401`). This is what
   makes pressing Enter at the very start of a heading produce a
   paragraph above it (instead of two headings).

`splitBlock` is the no-override default (`commands.ts:409`).

#### `splitBlockKeepMarks` (`commands.ts:413`)

Wraps `splitBlock`'s `dispatch` to call `tr.ensureMarks(state.storedMarks ||
$from.marks())` before forwarding. Without this wrapper, `splitBlock`
clears stored marks at the new block boundary.

#### `selectParentNode` (`commands.ts:423`) and `selectAll` (`commands.ts:433`)

Trivial. `selectParentNode` uses `$from.sharedDepth(to)` to find the
common ancestor depth and constructs a `NodeSelection` at `$from.before(same)`.

#### `selectTextblockStart` / `selectTextblockEnd` (`commands.ts:507–527`)

`selectTextblockSide(side)` walks `$pos.depth` downward past inline nodes
to find the enclosing textblock and sets a `TextSelection` at its
`start(depth)` or `end(depth)`. Bound to `Ctrl-a`/`Ctrl-e` on Mac.

#### `wrapIn(nodeType, attrs)` (`commands.ts:533`)

Compute `blockRange`, `findWrapping(range, type, attrs)` from
`prosemirror-transform`. If non-null, `tr.wrap(range, wrapping)`.

#### `setBlockType(nodeType, attrs)` (`commands.ts:545`)

Two-pass:
1. **Applicability scan**: walk every selection range with `nodesBetween`
   and stop as soon as it finds a textblock that either *is* the target
   type or whose parent allows `canReplaceWith(index, index+1, type)`
   (`commands.ts:548–561`).
2. **Apply pass**: iterate ranges and call `tr.setBlockType(from, to, type, attrs)`.

This is what backs heading toggles, code-block conversions, etc.

#### `toggleMark(markType, attrs, options)` (`commands.ts:611–671`)

Options:
- `removeWhenPresent` (default `true`): when *part* of the range has the
  mark, default behaviour is to *remove* it from the whole range. If
  `false`, the mark is *added* across the whole range only when no node
  is fully missing it (`commands.ts:643–653`).
- `enterInlineAtoms` (default `true`): when `false`, atom inline nodes
  fully covered by a range are excluded via `removeInlineAtoms`
  (`commands.ts:588–602`).
- `includeWhitespace` (default `false`): leading/trailing whitespace at
  range boundaries is excluded by trimming with `/^\s*/` / `/\s*$/` regex
  (`commands.ts:660–662`).

If the selection is collapsed (`$cursor`), the mark is toggled in
`storedMarks` instead of the document (`commands.ts:632–636`). If the
selection has no `$cursor` and `markApplies` is false, the command
returns `false`.

`markApplies` (`commands.ts:574–586`) walks `nodesBetween` checking
whether *any* containing node has `inlineContent && allowsMarkType(type)`.

#### `autoJoin(command, isJoinable)` (`commands.ts:717`)

A higher-order command. It wraps `dispatch` (`wrapDispatchForJoin` at
`commands.ts:673–709`):

1. Walk the transaction's `mapping.maps`, collecting every changed
   `[from, to]` pair, then map them through later steps so they refer to
   final-doc positions.
2. For each range, walk every node-boundary in the shared parent and add
   any boundary where `before.type == after.type && isJoinable(before, after)`
   to the joinable set.
3. After sorting, iterate from highest pos to lowest, calling `tr.join(pos)`
   if `canJoin` is still true.

This is how the basic editor merges adjacent `bullet_list`s when content
between them is removed: bind `wrapInList`/`liftListItem` with
`autoJoin(cmd, ["bullet_list", "ordered_list"])`.

`chainCommands(...)` (`commands.ts:728–734`) is one for-loop: try each
command in order, return on first `true`.

### 2.3 Base keymaps (`commands.ts:736–783`)

```ts
let backspace = chainCommands(deleteSelection, joinBackward, selectNodeBackward)
let del       = chainCommands(deleteSelection, joinForward,  selectNodeForward)
```

| Key | `pcBaseKeymap` | extra in `macBaseKeymap` |
|---|---|---|
| Enter | `chain(newlineInCode, createParagraphNear, liftEmptyBlock, splitBlock)` | – |
| Mod-Enter | `exitCode` | – |
| Backspace, Mod-Backspace, Shift-Backspace | `backspace` | – |
| Delete, Mod-Delete | `del` | – |
| Mod-a | `selectAll` | – |
| Ctrl-h | – | `Backspace` |
| Alt-Backspace | – | `Mod-Backspace` |
| Ctrl-d, Ctrl-Alt-Backspace, Alt-Delete, Alt-d | – | `Mod-Delete` |
| Ctrl-a | – | `selectTextblockStart` |
| Ctrl-e | – | `selectTextblockEnd` |

`baseKeymap` (`commands.ts:783`) is `mac ? macBaseKeymap : pcBaseKeymap`.
The platform sniff at `commands.ts:776–778` checks `navigator.platform`
or, when running under Node (e.g. SSR), `os.platform() == "darwin"`.

---

## 3. `prosemirror-keymap`

A 109-line module that wraps a bindings dict in a single `Plugin`
(`keymap.ts:76–78`):

```ts
export function keymap(bindings) {
  return new Plugin({props: {handleKeyDown: keydownHandler(bindings)}})
}
```

### 3.1 Key normalization (`keymap.ts:8–26`)

`normalizeKeyName(name)` splits on `-` (but not a trailing `-`, allowing
literal `-` as the keyname). Each prefix part is a modifier, with these
aliases:

| Match (regex) | Modifier set |
|---|---|
| `cmd`, `meta`, `m` | meta |
| `a`, `alt` | alt |
| `c`, `ctrl`, `control` | ctrl |
| `s`, `shift` | shift |
| `mod` | meta on Mac, ctrl elsewhere (`mac` detected via `navigator.platform`) |

The result is reassembled in canonical order: **`Shift-Meta-Ctrl-Alt-key`**
(prepended in reverse → effective order is Shift, Meta, Ctrl, Alt). Also
maps `"Space"` → `" "` (line 10). Unknown modifier name throws.

`normalize(map)` re-keys every binding through `normalizeKeyName` and
throws if two normalized names collide (`keymap.ts:32–33`). This is why
both `"Mod-z"` and `"Cmd-z"` in the same map error on Mac.

### 3.2 Lookup order in `keydownHandler` (`keymap.ts:83–109`)

Per keydown event:

1. Use `keyName(event)` from `w3c-keyname` plus event modifiers (via
   `modifiers(name, event, shift=true)` which prepends Alt, Ctrl, Meta,
   Shift in that order — so the *final* string is `Shift-Meta-Ctrl-Alt-X`,
   matching the normalized form).
2. **Direct lookup**. If the normalized binding fires and returns `true`,
   stop.
3. **Shift-aware retry**. If the unmodified key is a single character and
   shift is held, look up the binding *without* the Shift- prefix. This
   is the rule that makes binding `?` work even though the OS reports the
   key as `Shift-/` on US layouts (`keymap.ts:90–95`).
4. **AltGr / dead-key fallback**. If a non-shift modifier is held *and*
   `base[event.keyCode]` produces a different name (e.g. on a non-US
   layout where Alt+letter produces a glyph), look up the keyCode-derived
   name with modifiers (`keymap.ts:96–105`). The `windows && ctrl && alt`
   guard avoids breaking AltGr text input on Windows.
5. Return `false` (fallthrough) so other plugins / the browser can act.

### 3.3 Plugin precedence

Multiple keymap plugins can be registered; the **earlier in the
`plugins` array, the higher the precedence**. A binding that returns
`false` falls through to the next plugin — this is the canonical
extensibility pattern: install a high-priority keymap that returns
`false` when it doesn't apply, letting the base keymap take over.

---

## 4. `prosemirror-inputrules`

### 4.1 The `InputRule` shape (`inputrules.ts:8–56`)

```ts
class InputRule {
  constructor(
    match: RegExp,
    handler: string | ((state, match, start, end) => Transaction | null),
    options?: {
      undoable?: boolean       // default true
      inCode?:    boolean | "only"  // default false
      inCodeMark?: boolean     // default true
    }
  )
}
```

- The regex MUST end at `$` so it matches *up to* the cursor. The plugin
  ensures the matched text touches the cursor by checking `match[0].length
  >= text.length` (`inputrules.ts:126`).
- A **string** handler is wrapped by `stringHandler` (`inputrules.ts:58–73`):
  it replaces `match[0]` with the string, but if `match[1]` is captured,
  preserves the surrounding context (this is what makes `openDoubleQuote`'s
  pattern `(?:^|[\s\{\[\(\<'"])(")$` keep the leading character).
- **`undoable`** (default `true`): when set, the plugin attaches a meta
  payload to the transaction so `undoInputRule` can revert it.
- **`inCode`**: by default rules are skipped inside `code` textblocks.
  `true` opts in; `"only"` makes the rule apply *only* in code.
- **`inCodeMark`**: by default rules don't fire inside any inline range
  covered by a `code` mark. Set `false` for typographic rules
  (`smartQuotes`, `emDash`, `ellipsis` all do this).

### 4.2 The plugin (`inputrules.ts:82–110`)

```ts
const MAX_MATCH = 500
type PluginState = { transform: Transaction, from, to, text } | null
```

- **State**: stores the last-applied undoable-rule payload, or `null`.
  On every transaction `apply` reads the meta written by `run()`; if no
  meta is present and the tr changed the doc or selection, the state is
  reset to `null` (`inputrules.ts:84–91`). That reset is what allows a
  *single* Backspace to undo the rule — once you type anything else, the
  payload is gone and Backspace becomes normal.
- **Hooks**:
  - `handleTextInput(view, from, to, text)` calls `run()` (line 95).
  - `compositionend` triggers a `run` on the cursor with empty inserted
    text (line 98–104) so that IME completions still trip rules.

### 4.3 The `run` scan (`inputrules.ts:112–142`)

1. Skip if `view.composing` (line 113) — prevents partial IME firings.
2. Resolve `$from = state.doc.resolve(from)`, take up to **500 chars** of
   text before the cursor in the same parent (`MAX_MATCH`), append the
   inserted `text`, and call that `textBefore`. This is the buffer all
   rules match against.
3. For each rule:
   - Skip if the cursor is inside a `code` mark and the rule disallows it.
   - Skip if the parent textblock is `code` and the rule isn't opted in;
     skip if `inCode === "only"` and we *aren't* in code.
   - `rule.match.exec(textBefore)`. Skip if no match or the match is
     shorter than the just-inserted text (line 126) — i.e. the rule must
     consume at least the typed character.
   - Compute `startPos = from - (match[0].length - text.length)`.
   - Re-check for code marks across `[startPos, $from.pos]` if
     `inCodeMark` was false (line 128–134).
   - Call `rule.handler(state, match, startPos, to)`. If it returns
     `null`, continue. Otherwise:
     - Stamp the transaction with `tr.setMeta(plugin, {transform: tr,
       from, to, text})` (line 137) — only when `undoable`.
     - Dispatch and return `true`.

### 4.4 `undoInputRule` (`inputrules.ts:146–167`)

A regular `Command`. Walks plugins; for any plugin marked `isInputRules`
whose state is non-null, it:

1. Builds a transaction that **inverts each step** of the recorded
   transform in reverse order (`step.invert(toUndo.docs[j])`).
2. Replaces the original `[from, to]` with `state.schema.text(undoable.text,
   marks)` if `text` was non-empty, or `tr.delete` otherwise.
3. Dispatches.

Bind this to **Backspace** (typically chained before `pcBaseKeymap`'s
backspace) so a single press undoes the auto-formatting.

### 4.5 Built-in rules (`rules.ts`)

| Constant | Pattern | Replacement | File:line |
|---|---|---|---|
| `emDash` | `/--$/` | `—` | `rules.ts:4` |
| `ellipsis` | `/\.\.\.$/` | `…` | `rules.ts:6` |
| `openDoubleQuote` | `/(?:^\|[\s\{\[\(\<'"\u2018\u201C])(")$/` | `“` | `rules.ts:8` |
| `closeDoubleQuote` | `/"$/` | `”` | `rules.ts:10` |
| `openSingleQuote` | `/(?:^\|[\s\{\[\(\<'"\u2018\u201C])(')$/` | `‘` | `rules.ts:12` |
| `closeSingleQuote` | `/'$/` | `’` | `rules.ts:14` |
| `smartQuotes` | bundled list | – | `rules.ts:17` |

All built-ins set `inCodeMark: false`. Open-quote rules use a captured
group so `stringHandler` only replaces the quote character, not the
preceding boundary.

There is **no** `markInputRule` in the package itself — bold/italic
underscores are user-supplied; the `example-setup` repo demonstrates a
typical implementation. The package only exports the two builders below.

### 4.6 Rule builders (`rulebuilders.ts`)

#### `wrappingInputRule(regexp, nodeType, getAttrs?, joinPredicate?)` (`rulebuilders.ts:20–38`)

```ts
return new InputRule(regexp, (state, match, start, end) => {
  let attrs = getAttrs instanceof Function ? getAttrs(match) : getAttrs
  let tr = state.tr.delete(start, end)
  let $start = tr.doc.resolve(start)
  let range = $start.blockRange()
  let wrapping = range && findWrapping(range, nodeType, attrs)
  if (!wrapping) return null
  tr.wrap(range, wrapping)
  let before = tr.doc.resolve(start - 1).nodeBefore
  if (before && before.type == nodeType && canJoin(tr.doc, start - 1) &&
      (!joinPredicate || joinPredicate(match, before)))
    tr.join(start - 1)
  return tr
})
```

The **join-with-prior-list** behaviour after the wrap is what makes
typing `> ` on the line after a blockquote merge into the existing
blockquote rather than create a sibling.

Typical use:
```ts
wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list)
wrappingInputRule(/^(\d+)\.\s$/, schema.nodes.ordered_list,
  match => ({order: +match[1]}),
  (match, node) => node.childCount + node.attrs.order == +match[1])
```

#### `textblockTypeInputRule(regexp, nodeType, getAttrs?)` (`rulebuilders.ts:46–59`)

Replaces the matched text with a `setBlockType` change on the *current*
textblock. Implementation:

```ts
return new InputRule(regexp, (state, match, start, end) => {
  let $start = state.doc.resolve(start)
  let attrs = ... getAttrs ...
  if (!$start.node(-1).canReplaceWith($start.index(-1), $start.indexAfter(-1), nodeType))
    return null
  return state.tr.delete(start, end).setBlockType(start, start, nodeType, attrs)
})
```

The classic `# ` → heading rule:
```ts
textblockTypeInputRule(/^(#{1,6})\s$/, schema.nodes.heading,
  match => ({level: match[1].length}))
```

#### `markInputRule` — *not exported*

The official `prosemirror-inputrules` package exposes only the two
builders above; there is no `markInputRule`. Many third-party setups
ship one — the typical shape is:

```ts
function markInputRule(regexp: RegExp, markType: MarkType, getAttrs?) {
  return new InputRule(regexp, (state, match, start, end) => {
    const attrs = getAttrs instanceof Function ? getAttrs(match) : getAttrs
    const tr = state.tr
    const text = match[1]
    if (text) {
      const textStart = start + match[0].indexOf(text)
      const textEnd = textStart + text.length
      if (textEnd < end) tr.delete(textEnd, end)
      if (textStart > start) tr.delete(start, textStart)
      end = start + text.length
    }
    tr.addMark(start, end, markType.create(attrs))
    tr.removeStoredMark(markType)
    return tr
  })
}
```

(Quoted from common community implementations; record this in our spec
as a thing we will provide ourselves.)

### 4.7 Undo behaviour walkthrough

1. User types `--`. Plugin's `handleTextInput` fires `run`. `emDash`
   matches, handler returns `tr.insertText("—", start, end)`. The
   plugin attaches `setMeta(plugin, {transform, from, to: from, text: "-"})`
   *(actually `text` is the just-inserted character)*.
2. The keymap dispatches the transaction; the state stores the payload.
3. User presses Backspace. The keymap chain reaches `undoInputRule`
   (when bound) before `joinBackward`. It inverts the recorded transform
   and re-inserts `--` (or whatever `text` was). State resets to `null`.
4. If instead the user types another character, the apply function in
   `inputRules` resets state to `null` because `tr.docChanged && !meta`.
   Backspace afterwards is a normal Backspace.

---

## 5. `prosemirror-schema-list` commands

Includes node specs (`orderedList`, `bulletList`, `listItem`) and the
helper `addListNodes(nodes, itemContent, listGroup?)` to splice them into
a schema's nodemap (`schema-list.ts:54–60`). The commands assume
`list_item.spec.defining` is `true` (line 32).

| Command | File:line | Signature |
|---|---|---|
| `wrapInList(listType, attrs?)` | `schema-list.ts:66` | `Command` factory |
| `splitListItem(itemType, itemAttrs?)` | `schema-list.ts:127` | `Command` factory |
| `splitListItemKeepMarks(itemType, itemAttrs?)` | `schema-list.ts:173` | `Command` factory |
| `liftListItem(itemType)` | `schema-list.ts:186` | `Command` factory |
| `sinkListItem(itemType)` | `schema-list.ts:245` | `Command` factory |
| (also exported helper) `wrapRangeInList(tr, range, listType, attrs?)` | `schema-list.ts:83` | non-Command helper |

### 5.1 `wrapInList` / `wrapRangeInList` (`schema-list.ts:66–123`)

Algorithm (in `wrapRangeInList`):

1. Default to wrapping the given `range` directly. But: **if the range
   is at the top of an existing list item** (`range.depth >= 2`,
   `parent.type` is compatible with `listType`, `range.startIndex == 0`)
   *and* it isn't the very first item of the list, expand the *outer*
   range to the position 2 above (`doc.resolve(range.start - 2)`). Set
   `doJoin = true`. If the inner range doesn't reach the end of its
   parent, also clip the inner range to `$to.end(depth)` (lines 86–94).
2. `findWrapping(outerRange, listType, attrs, range)`. If no wrapping
   path is possible, return `false`.
3. `doWrapInList(tr, range, wrap, doJoin, listType)`:
   - Build a `Fragment` of nested wrapper nodes.
   - `ReplaceAroundStep` to insert that wrapping (`schema-list.ts:107–108`).
     `joinBefore` controls whether the insertion is shifted left by 2
     positions to swallow a preceding list item.
   - For each child after the first, if `canSplit` at the running
     `splitPos` with `splitDepth = wrappers.length - found_listType_index`,
     split — i.e. **each block becomes its own list item** (lines 114–121).

### 5.2 `splitListItem(itemType, itemAttrs?)` (`schema-list.ts:127–169`)

The Enter inside a list:

1. Bail if a block is selected, `$from.depth < 2`, or selection straddles
   parents (line 130).
2. Bail if the grand-parent isn't `itemType` (line 132).
3. **Empty-block at end-of-item** branch (lines 133–161): if the cursor
   is in an empty textblock and that textblock is the last child of the
   item, *and* we're at depth 3 / nested-but-last-position structure,
   build a fragment that re-creates the necessary nesting around an
   empty new item (`itemType.createAndFill()`), `tr.replace` from
   `$from.before(...)` to `$from.after(-depthAfter)` with that fragment.
   Then walk for the first empty textblock in the new doc and put the
   selection there. This is the "press Enter on the empty last item to
   exit the list" behaviour, with the correct depth handling for nested
   lists.
4. **Normal split** branch (lines 162–167): delete the selection,
   compute `nextType` (default content of the new item) when the cursor
   is at end-of-block, build a `types` array `[itemAttrs?, {type:
   nextType}]`, `canSplit(... 2, types)`, then `tr.split($from.pos, 2,
   types)`. Depth `2` because we split through both `list_item` and the
   textblock inside.

### 5.3 `splitListItemKeepMarks` (`schema-list.ts:173`)

Same wrapper trick as `splitBlockKeepMarks`: forwards to `splitListItem`
with a `dispatch` that `tr.ensureMarks(state.storedMarks || $from.marks())`.

### 5.4 `liftListItem(itemType)` (`schema-list.ts:186–215`)

1. Compute `range = $from.blockRange($to, node => node.childCount > 0
   && node.firstChild.type == itemType)` — the predicate ensures the
   range is bounded by something that *contains* list items.
2. If `dispatch` is null, return `true` (queries possibility only).
3. **Inside a parent list** (`$from.node(range.depth - 1).type == itemType`)
   ⇒ `liftToOuterList`:
   - If there are siblings *after* the lifted items, wrap them under the
     last lifted item via a `ReplaceAroundStep` so they stay nested
     (lines 200–207).
   - `liftTarget(range)` + `tr.lift`.
   - Probe the position right after the lifted block; if it can be
     joined with the next sibling of the same type, do so (`canJoin`
     check, line 212).
4. **Outer list node** ⇒ `liftOutOfList` (lines 217–241):
   - Merge all selected items into one big item by deleting the
     boundaries between adjacent items in reverse order (lines 220–223).
   - Verify the parent (the document-level container) can accept the
     resulting content via `canReplace`.
   - Use a single `ReplaceAroundStep` to peel the surrounding list off,
     leaving the first `$start.nodeAfter`'s content inline. The slice
     reconstructs `list.copy(empty)` on whichever side(s) we are not at
     the boundary, so adjacent list portions are preserved (lines
     235–239).

### 5.5 `sinkListItem(itemType)` (`schema-list.ts:245–267`)

1. Compute the same `blockRange`.
2. Bail if `startIndex == 0` (can't sink the first item).
3. Examine `nodeBefore` (the previous list item).
4. Build the "wrap into a sub-list" slice:
   - If `nodeBefore` already ends with a sub-list of the same type
     (`nestedBefore`), the slice is `itemType( parent.type( itemType ))`
     with open-start `3`. The new item joins the existing nested list.
   - Otherwise the slice is `itemType( parent.type() )` with open-start
     `1`, creating a fresh nested list.
5. `ReplaceAroundStep(before - (nestedBefore ? 3 : 1), after, before, after,
   slice, 1, true)` (line 261–263). The `insert = 1` and `structure = true`
   make `Tab`-style indentation atomic.

### 5.6 Typical bindings

```ts
keymap({
  "Enter":      splitListItem(schema.nodes.list_item),
  "Tab":        sinkListItem(schema.nodes.list_item),
  "Shift-Tab":  liftListItem(schema.nodes.list_item),
  "Mod-[":      liftListItem(schema.nodes.list_item),
  "Mod-]":      sinkListItem(schema.nodes.list_item),
})
```

`splitListItem` is typically chained *before* `pcBaseKeymap`'s Enter
chain so that it shadows the generic split when the cursor is in a list.
`autoJoin(wrapInList(...), ["bullet_list", "ordered_list"])` is the
canonical wrapper to merge adjacent lists after applying.

---

## 6. Summary cheatsheet

- **Command = `(state, dispatch?, view?) => boolean`**. Dual-mode is the
  bedrock contract.
- **`chainCommands`** is the core composition primitive. **`autoJoin`**
  layers post-hoc joining on top of any command.
- **Keymap precedence**: plugin order → in-plugin lookup → shift retry →
  keyCode/AltGr fallback. Returning `false` falls through.
- **InputRules** scan up to 500 chars before the cursor on every text
  input and `compositionend`. They tag dispatched transactions with a
  meta so `undoInputRule` (typically Backspace-bound) can revert them.
- **List commands** are *factories* that capture the schema's
  `list_item` type. Always pair `wrapInList` with `autoJoin` on
  `bullet_list`/`ordered_list`.

---

## 7. Implications for our editor spec

- Our command primitive should mirror the `(state, dispatch?, view?)`
  shape precisely; menu enable-state derivation hinges on the dry-run
  half. We can treat `dispatch === undefined` as "query".
- `splitBlock`'s start-of-block reset to `deflt` is a non-obvious
  behaviour worth replicating: it's why "Enter at start of heading"
  produces a paragraph above. Don't lose this when reimplementing.
- `deleteBarrier`'s four-strategy ladder (join → wrap-and-join → lift →
  slot textblock) is the sole reason Backspace "feels right" across
  blockquotes/lists/code. Document this as required behaviour; tests
  should cover each strategy.
- For input rules: keep the `MAX_MATCH = 500` scan window, the
  `compositionend` retry, and the `setMeta(plugin, payload)` undo
  sentinel pattern. Without the sentinel, undo is per-keystroke and
  feels wrong.
- Provide a built-in `markInputRule` (the upstream package omits it but
  every consumer rewrites the same 15 lines).
- For lists, expose all five operations (`wrap`, `split`, `splitKeepMarks`,
  `lift`, `sink`) and bind `Tab`/`Shift-Tab` plus `Mod-[`/`Mod-]`.
