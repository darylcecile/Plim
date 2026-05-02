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

---

## 8. Gap-fill addenda

### 8.1 `baseKeymap` Mac vs PC — exact divergence

`pcBaseKeymap` and `macBaseKeymap` differ only in the **extra Emacs-style
bindings on Mac** (`commands.ts:751–774`). The `Mod-*` entries are
identical strings; their meaning differs because `prosemirror-keymap`
resolves `Mod` per-platform (`keymap.ts:5`: `mac → meta`, otherwise →
`ctrl`). Concretely:

| Binding (literal key) | `pcBaseKeymap` | `macBaseKeymap` |
|---|---|---|
| `Enter` | newlineInCode → createParagraphNear → liftEmptyBlock → splitBlock | same |
| `Mod-Enter` | `Ctrl-Enter` ⇒ `exitCode` | `Cmd-Enter` ⇒ `exitCode` |
| `Backspace` | backspace chain | same |
| `Mod-Backspace` | `Ctrl-Backspace` ⇒ word-backspace chain | `Cmd-Backspace` ⇒ same chain |
| `Shift-Backspace` | backspace chain | same |
| `Delete` | del chain | same |
| `Mod-Delete` | `Ctrl-Delete` | `Cmd-Delete` |
| `Mod-a` | `Ctrl-a` ⇒ selectAll | `Cmd-a` ⇒ selectAll |
| `Ctrl-h` | — | Backspace chain |
| `Alt-Backspace` | — | Mod-Backspace chain |
| `Ctrl-d` | — | Delete chain |
| `Ctrl-Alt-Backspace` | — | Mod-Delete chain |
| `Alt-Delete` / `Alt-d` | — | Mod-Delete chain |
| `Ctrl-a` | — | selectTextblockStart |
| `Ctrl-e` | — | selectTextblockEnd |

Only the last seven rows are platform-divergent; everything else is the
same dictionary entry resolved against a different `Mod`. The for-loop
at `commands.ts:774` (`for (let key in pcBaseKeymap) macBaseKeymap[key] = …`)
ensures `macBaseKeymap` is a strict superset.

### 8.2 `chainCommands` — short-circuit-on-first-true *contract rationale*

`chainCommands(...cmds)` (`commands.ts:728–734`) iterates and returns the
moment one command returns `true`:

```ts
for (let i = 0; i < commands.length; i++)
  if (commands[i](state, dispatch, view)) return true
return false
```

Why short-circuit (not "run them all" or "chain dispatches"):

1. **Each command in a chain is mutually exclusive on dispatch.** Once
   the first applicable command dispatches a tr, the editor state has
   advanced; the remaining commands would see a stale `state` and either
   misfire or apply against wrong positions.
2. **Boolean return = "I handled it"**, modelled after DOM event
   handlers. A command that returns `true` claims the keystroke and
   prevents fall-through; `false` means "not applicable, try the next".
3. **Dry-run consistency**: when called with `dispatch === undefined`,
   the chain still returns `true` if *any* sub-command is applicable.
   Menu enable-state derivation thus matches runtime behaviour — what
   would dispatch IS what currently can dispatch.
4. **Plugin precedence semantics**: `keydownHandler` (`keymap.ts:88`)
   stops at the first plugin whose binding returns `true`; chains
   compose at the command level with the same contract, so users can
   reason about precedence the same way at both layers.

The contract is *not* "all-or-nothing": there is no rollback if a later
command fails. That's why the canonical Backspace chain
(`deleteSelection, joinBackward, selectNodeBackward`) puts the
*destructive* commands in priority order — once one fires, no backtrack.

### 8.3 Async commands — the missing pattern

**ProseMirror commands are synchronous.** The `Command` type returns
`boolean` *immediately*, and `dispatch(tr)` is a synchronous call into
`view.dispatch`. There is no `Promise<Command>` or `async Command` in
the API surface, and `chainCommands`, `keydownHandler`, and
`splitListItem` all assume sync return.

This rules out `async` directly. The **canonical pattern** when you
need async data (server lookup, OCR, translation, AI completion) is the
**placeholder + meta-replace** idiom:

```ts
// 1. Plugin that draws "loading" decorations keyed by a unique id.
const placeholderPlugin = new Plugin<DecorationSet>({
  state: {
    init() { return DecorationSet.empty },
    apply(tr, set) {
      set = set.map(tr.mapping, tr.doc)
      const action = tr.getMeta(this)
      if (action?.add) {
        const widget = document.createElement("span")
        widget.className = "placeholder"
        const deco = Decoration.widget(action.add.pos, widget,
          { id: action.add.id })
        set = set.add(tr.doc, [deco])
      } else if (action?.remove) {
        set = set.remove(set.find(undefined, undefined,
          spec => spec.id == action.remove.id))
      }
      return set
    }
  },
  props: { decorations(state) { return this.getState(state) } }
})

function findPlaceholder(state: EditorState, id: number) {
  const set = placeholderPlugin.getState(state)!
  const found = set.find(undefined, undefined, spec => spec.id == id)
  return found.length ? found[0].from : null
}

// 2. Command — returns a boolean synchronously, but kicks off async
//    work that will later dispatch a *separate* transaction.
const translateSelection: Command = (state, dispatch, view) => {
  if (state.selection.empty) return false
  if (!dispatch) return true                       // dry-run "can do?"

  const id = {}                                     // unique sentinel
  const { from, to } = state.selection
  const text = state.doc.textBetween(from, to)

  // Insert placeholder synchronously
  dispatch(state.tr.setMeta(placeholderPlugin,
    { add: { id, pos: to } }))

  // Kick async work — note: we deliberately do NOT await here.
  fetch("/translate", { method: "POST", body: text })
    .then(r => r.text())
    .then(translated => {
      // Look up placeholder against the *current* state — positions
      // have shifted if the user kept typing.
      const pos = findPlaceholder(view!.state, id)
      if (pos == null) return                       // user undid / removed
      const tr = view!.state.tr
        .replaceWith(pos, pos, view!.state.schema.text(translated))
        .setMeta(placeholderPlugin, { remove: { id } })
      view!.dispatch(tr)
    })
    .catch(() => view!.dispatch(view!.state.tr
      .setMeta(placeholderPlugin, { remove: { id } })))
  return true
}
```

Key invariants of the async pattern:

- The command **returns immediately** so `chainCommands`/keymap don't
  break. The boolean reflects "did we kick off the work?", not "did the
  async result land?".
- The placeholder is a **DecorationSet widget**, not a node — so it
  doesn't enter the document and doesn't perturb selection or undo
  history (decorations are view-only; see file 10).
- The async resolution dispatches a *new* transaction. Positions are
  recovered by **searching for the decoration by id**, never by holding
  the original `from`/`to` (those are stale after intervening edits).
  This is the single most common bug in async PM commands.
- `setMeta(placeholderPlugin, …)` does not change the doc, so the
  placeholder add/remove transactions are **not** undoable events
  (they're map-only from history's POV, see file 20 §1.5).
- If the result must be undoable as a single user-visible event, the
  *replacement* transaction (the one that drops the placeholder and
  inserts the translated text) carries the docChange and is recorded.

For "user clicks Translate menu item":

```ts
button.onclick = () => {
  view.focus()                         // see §8.4
  translateSelection(view.state, view.dispatch, view)
}
```

The async pattern is identical for menu-driven and key-driven
invocations.

### 8.4 `handleTextInput` — command-adjacent surface

`Plugin.props.handleTextInput(view, from, to, text) → boolean`
(documented in file 13 §3.4) has the same return-as-claim semantics as
a `Command`, but a **different signature** and a *different* dispatch
context: it runs from the input pipeline before the browser commits
text. The connection points:

- `prosemirror-inputrules` is implemented entirely on top of
  `handleTextInput` (`inputrules.ts:95`): the InputRule handler returns
  a `Transaction | null`, the plugin dispatches it, and returns `true`
  to suppress the native input. This is why InputRules feel like
  commands but are *not* Commands.
- A `handleTextInput` returning `true` short-circuits all other text
  handlers (first-plugin-wins, same as keymap).
- You can use `handleTextInput` for "smart" replacements (auto-link
  detection, mention triggers, etc.) and for these, **prefer it over a
  keymap binding on the trigger character**: the keymap fires on
  `keydown` *before* the character has joined `textBefore`, leading to
  off-by-one matches.

If your "command" needs to inspect the just-inserted text in context,
implement it as a `handleTextInput` plugin prop, not as a Command in a
keymap. Then expose a thin Command wrapper (for menus / programmatic
invocation) that performs the same transformation against the current
selection.

### 8.5 Decoration-driven commands

A common PM idiom: a plugin tracks state as a `DecorationSet`
(highlights, suggestions, lint markers), and exposes Commands that key
off "is the cursor inside an active decoration?" rather than off the
selection alone.

```ts
const acceptSuggestion: Command = (state, dispatch) => {
  const set = suggestionPlugin.getState(state)
  const at = set.find(state.selection.from, state.selection.from)
  if (!at.length) return false                     // no decoration here
  if (!dispatch) return true
  const { suggestion, from, to } = at[0].spec
  dispatch(state.tr
    .replaceWith(from, to, state.schema.text(suggestion))
    .setMeta(suggestionPlugin, { dismiss: at[0] }))
  return true
}
```

Why this is preferred over storing positions in plugin state directly:

- Decorations are mapped through `tr.mapping` automatically by
  `DecorationSet.map(mapping, doc)` (file 10), so positions stay valid
  across remote/local edits without boilerplate.
- The decoration's `.spec` is the right place to stash command payload
  (replacement text, source URL, fix-it action), keyed to the visual
  marker the user sees.
- `set.find(from, to)` is the lookup primitive — O(log n) on the
  internal tree.

Pair this with `handleClickOn` to make the same command fire from a
toolbar overlay attached to the decoration's DOM.

### 8.6 `undoInputRule` × `closeHistory` — and the cross-link to file 20

`undoInputRule` does **not** itself call `closeHistory(tr)`. It builds
a transaction by inverting the recorded steps; that transaction enters
the regular history flow (file 20 §1.6). The relevant boundary effect
is the *opposite* one:

- The **input-rule transaction** that originally fired the rule does
  *not* set `closeHistory`. It's a normal docChanging transaction and
  groups with surrounding typing per the 500ms `newGroupDelay` rule
  (file 20 §1.6).
- This is **on purpose** — without grouping, every InputRule firing
  would be its own undo step, so typing `--` would take two Ctrl-Z
  presses to revert (one for the `—`, one for the `--`).
- The **`undoInputRule` command** (Backspace-bound *before* base
  Backspace) catches the immediate post-rule press and inverts the
  rule's own steps directly, *bypassing* history undo entirely. After
  it dispatches, the inputrules plugin state resets to `null`
  (`inputrules.ts:88–91`), so a *second* Backspace becomes a normal
  Backspace.

If you want a forced history boundary at rule-firing time (so that a
later Ctrl-Z reverts the rule as a discrete event, not folded into the
preceding word), wrap the rule's handler:

```ts
new InputRule(/--$/, (state, match, start, end) => {
  const tr = state.tr.replaceWith(start, end, state.schema.text("—"))
  return closeHistory(tr)                          // file 20 §1.6
})
```

Cross-link to file 20 §1.6 ("Detecting event boundaries") and §1.13
(`closeHistory` as the public API for forced boundaries).

### 8.7 Built-in input rules — per-rule walkthrough

From `prosemirror-inputrules/src/rules.ts`:

#### `emDash` (`rules.ts:4`)
```ts
new InputRule(/--$/, "—", { inCodeMark: false })
```
- Pattern: literal two hyphens at cursor.
- String handler: replaces the two hyphens with `—` (U+2014).
- Skipped inside `code` marks/textblocks (default for code, plus opt-out
  for `code` mark via `inCodeMark: false`).
- **Note**: triggers only on the *second* hyphen — by the time `run()`
  fires for the second `-`, `textBefore` ends in `--`. Typing `---` does
  NOT produce `—-`; it produces `—-` only because the rule fires once,
  on the second hyphen, and the third hyphen lands as plain text.

#### `ellipsis` (`rules.ts:6`)
```ts
new InputRule(/\.\.\.$/, "…", { inCodeMark: false })
```
- Three literal periods → `…` (U+2026).
- Same firing rule: only on the third `.`. Typing four periods yields
  `….`

#### `openDoubleQuote` (`rules.ts:8`)
```ts
new InputRule(/(?:^|[\s\{\[\(\<'"\u2018\u201C])(")$/, "“",
  { inCodeMark: false })
```
- The `(?:^|[\s\{\[\(\<'"…])` non-capturing group matches one of:
  start-of-block, whitespace, opening bracket, existing quote (so
  nesting works), or already-curly open quotes.
- The capturing group `(")` is the just-typed `"`.
- `stringHandler` (`inputrules.ts:58–73`) sees `match[1]` is set, so it
  computes `start' = start + match[0].indexOf(match[1])` and replaces
  *only* the closing `"` — preserving the boundary character.

#### `closeDoubleQuote` (`rules.ts:10`) and single-quote variants
- `closeDoubleQuote` matches a bare `"$` (no prefix group), replacing it
  with `”`. Because `openDoubleQuote` is checked first in
  `smartQuotes` (`rules.ts:17`), a `"` after whitespace becomes `“`;
  every other `"` becomes `”`.
- `openSingleQuote` / `closeSingleQuote` mirror the doubles, producing
  `‘` / `’`. Note `closeSingleQuote` doubles as the apostrophe rule:
  in `don't`, `'` lands after `n` (no whitespace prefix), so the close
  rule matches and produces `don't`.

#### `smartQuotes` (`rules.ts:17`)
```ts
export const smartQuotes: readonly InputRule[] =
  [openDoubleQuote, closeDoubleQuote, openSingleQuote, closeSingleQuote]
```
- The **order matters**: open-quote rules are tested before close-quote
  rules in `inputRules({rules: [...smartQuotes]})`. Both close-quote
  patterns match `"$` / `'$`, so without the order, `closeDoubleQuote`
  would always shadow `openDoubleQuote`.

### 8.8 Composite key sequences — *not supported*

`prosemirror-keymap` does **not** support multi-keystroke chords like
`Ctrl-K Ctrl-K` (VS Code) or `Ctrl-X Ctrl-S` (Emacs). The plugin's
state is a single `bindings` dict; each `keydown` is matched
independently against it (`keymap.ts:83–109`). There is no "we are
inside a prefix" state machine.

If you need chord support, build it in a separate plugin:

```ts
const chordPlugin = new Plugin({
  state: {
    init() { return { prefix: null } },
    apply(tr, val) {
      const newPrefix = tr.getMeta(this)
      return newPrefix !== undefined ? { prefix: newPrefix } : val
    }
  },
  props: {
    handleKeyDown(view, ev) {
      const name = keyName(ev)             // from w3c-keyname
      const { prefix } = this.getState(view.state)!
      if (prefix == null && name == "Ctrl-k") {
        view.dispatch(view.state.tr.setMeta(this, "Ctrl-k"))
        return true
      }
      if (prefix == "Ctrl-k") {
        view.dispatch(view.state.tr.setMeta(this, null))
        if (name == "Ctrl-k") { /* run chord command */ return true }
        return true   // swallow the second keystroke regardless
      }
      return false
    }
  }
})
```

Then mount it *before* `keymap(baseKeymap)` so it claims the prefix
key. Most PM-based apps (Atom legacy, Notion, Outline) do not use
chords at all — they rely on `Mod-` modifiers and menus instead.

### 8.9 Dead keys on macOS — timing implications

A "dead key" (e.g. Option+e on US-extended → combining-acute, then `a`
→ `á`) reaches the editor as a **composition session**, not as
discrete keydowns:

- macOS dispatches `compositionstart` when the dead key is pressed.
- During composition, `view.composing` is `true`, and `prosemirror-view`
  suppresses keymap dispatch for printable keys to avoid double-handling
  (file 14 §3).
- The composed character arrives via `compositionend` + a single
  text-input event.
- `prosemirror-inputrules` re-runs `run()` on `compositionend`
  (`inputrules.ts:98–104`) so accent-completed sequences still fire
  rules.

Implications for keymap design:

- **Don't bind plain printable keys**: a binding on `a` will not fire
  during dead-key composition (correctly), but if the user typed `a`
  *without* a preceding dead key, your binding *does* fire — and on
  most Mac layouts there's no obvious way the user can tell.
- **Bind only modified keys** (`Mod-…`, `Alt-…`, `Ctrl-…`) for
  commands. Plain letter bindings are reserved for InputRules
  (compose-aware) and the base text-insertion path.
- **Don't bind `Alt-e`, `Alt-u`, `Alt-i`, `Alt-n`, `Alt-` ` ** (the dead
  keys on macOS US): these will steal the dead-key sequence. Same with
  `Alt-Shift-` versions. The IME swallows them anyway when the user is
  composing, but a user with a different layout gets surprising
  behaviour.

### 8.10 `dispatch` closure-capture footgun

The dual-mode pattern's `dispatch` argument is **specific to the call
site** — `view.dispatch` is itself stable, but the `state` you would
build a tr against is *not*. A common bug:

```ts
// ❌ Buggy — captures `state` and `dispatch` at button-render time.
function renderButton(state, dispatch) {
  const enabled = toggleMark(schema.marks.strong)(state)
  return html`<button ?disabled=${!enabled}
                      @click=${() => toggleMark(schema.marks.strong)(state, dispatch)}>
                Bold
              </button>`
}
```

When the user types between render and click, `state` is stale; the tr
built from `state.tr` references positions in the *old* document. If
the doc lengths still happen to match, you get a silent mis-edit; if
not, the dispatch throws `Position N out of range`.

```ts
// ✅ Always read state at click time, dispatch through `view`.
function renderButton(view) {
  return html`<button
    ?disabled=${!toggleMark(schema.marks.strong)(view.state)}
    @click=${() => {
      view.focus()
      toggleMark(schema.marks.strong)(view.state, view.dispatch)
    }}>Bold</button>`
}
```

Rules:

1. Pass the `EditorView` (or a getter for it), never a captured `state`,
   to UI code.
2. Always read `view.state` at the moment of dispatch.
3. The `dispatch` you forward is `view.dispatch.bind(view)` (or just
   `view.dispatch` — it's pre-bound by PM).
4. In `appendTransaction`, use the **`newState` argument**, not the
   plugin-state-time `state`.

This is the single most-common foot-gun for menu/toolbar code.

### 8.11 Keymap lookup-order diagram

```
keydown event
     │
     ▼
┌──────────────────────────────────────────┐
│ keyName(event) + modifiers(name, event)   │  → "Shift-Meta-Ctrl-Alt-X"
└──────────────────────────────────────────┘
     │
     ▼
┌──────────────────────────────────────────┐
│ Plugin 1 (highest precedence)             │
│  ├─ exact-match lookup ────► true → STOP  │
│  ├─ shift-fallback (single-char only)     │
│  │   strip "Shift-", retry  ─► true → STOP│
│  ├─ keyCode/AltGr fallback ─► true → STOP │
│  └─ return false                          │
└──────────────────────────────────────────┘
     │ (fall-through)
     ▼
┌──────────────────────────────────────────┐
│ Plugin 2 …                                │
│   (same 3-step lookup, same precedence)   │
└──────────────────────────────────────────┘
     │
     ▼
   browser default
```

**First-plugin-wins** at the outer level (`keydownHandler` returns at
the first `true`). **Three-step lookup** within a plugin
(`keymap.ts:88–105`):

1. Direct match on the canonical `Shift-Meta-Ctrl-Alt-key` string.
2. **Shift-fallback** — if `shift` is held and the key is a single
   character (length 1, often a glyph the OS reported as Shift-X), try
   without `Shift-` (`keymap.ts:90–95`).
3. **AltGr/keyCode fallback** — when a non-shift modifier is held and
   `base[event.keyCode]` produces a different name than the event's
   `key` (e.g. on a non-US layout where `Alt-X` produces a glyph),
   look up using the keyCode-derived name (`keymap.ts:96–105`). The
   `windows && ctrl && alt` guard skips this on Windows AltGr to avoid
   eating composed characters.

### 8.12 Input-rule scan window — performance characteristics

`MAX_MATCH = 500` (`inputrules.ts:82`) bounds `textBefore` per
`run()`:

- **Scan cost**: `$from.parent.textBetween(max(0, $from.parentOffset -
  500), $from.parentOffset, null, "\ufffc")` (`inputrules.ts:121`) —
  O(min(500, parentSize)) per text-input event. `\ufffc` is the
  object-replacement character used to stand in for inline atoms so
  regex-on-text doesn't see them as gaps.
- **Regex cost**: each rule's `match.exec(textBefore)` is run against
  the same string. With N rules, total cost is O(N · 500) *characters*
  examined per keystroke. For typical `smartQuotes + ellipsis +
  emDash` (5 rules, all simple anchored patterns), this is sub-microsecond
  on modern V8.
- **Pathological cases**:
  - A user-supplied rule with a non-anchored pattern (no `$`) would
    scan-and-backtrack across the full 500-char window — avoid.
  - Catastrophic-backtrack regexes (`(a+)+$`) on a 500-char input can
    spike to ms. Always anchor with `$` and keep alternations bounded.
- **Why 500**: long enough for paragraph-scoped rules (heading prefixes,
  list markers up to medium length, blockquote `> ` after long
  preceding text) and short enough that the per-keystroke cost is
  trivially bounded. If you genuinely need a longer window (multi-block
  rule), do not raise `MAX_MATCH` — `prosemirror-inputrules` doesn't
  support cross-block regexes. Build a custom `handleTextInput` that
  walks the doc structure instead.

### 8.13 `setBlockType` — "is this textblock different" no-op bailout

`setBlockType(nodeType, attrs?)` (`commands.ts:545–571`) does an
**applicability scan** *before* dispatch:

```ts
let applicable = false
for (let i = 0; !applicable && i < state.selection.ranges.length; i++) {
  let { $from: { pos: from }, $to: { pos: to } } = state.selection.ranges[i]
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (applicable) return false
    if (!node.isTextblock || node.hasMarkup(type, attrs)) return
    if (node.type == type) applicable = true
    else {
      const $pos = state.doc.resolve(pos), index = $pos.index()
      applicable = $pos.parent.canReplaceWith(index, index + 1, type)
    }
  })
}
if (!applicable) return false
```

Two distinct bailout reasons return `false`:

1. **Already-this-type-and-attrs**: every textblock in range satisfies
   `node.hasMarkup(type, attrs)`. The command refuses to dispatch a
   no-op tr. Toolbar callers see this as "button stays
   un-highlighted" *and* "no event in undo".
2. **Schema-illegal**: no textblock in range can be replaced with the
   target type (`canReplaceWith` is false for every parent at every
   range index). Common cause: trying to set a node-type the parent
   doesn't allow.

The bailout is the answer to "why didn't my Heading button do
anything?" — usually case 1 (already a heading with same level) or the
selection's anchor is in a non-textblock context (atom selected,
NodeSelection on an image).

To force a "set to heading-1, even if already heading-2" *and* "create
a single undo event regardless", build the tr explicitly:

```ts
const cmd: Command = (state, dispatch) => {
  if (!dispatch) return true
  const { from, to } = state.selection
  dispatch(state.tr.setBlockType(from, to, type, attrs).scrollIntoView())
  return true
}
```

This skips the applicability scan entirely.

### 8.14 Cross-link: `joinBackward` / `joinForward` ↔ file 13 §3.3.1

`joinBackward` (`commands.ts:30–75`) and `joinForward` (`commands.ts:174–209`)
are the **command-layer entry points** for the same logical flow that
file 13 §3.3.1 describes at the **input-pipeline layer** as
`stopNativeHorizontalDelete`:

- File 13: when the user presses Backspace/Delete and PM detects a
  scenario the browser would mis-handle (atom before cursor, isolating
  parent boundary, NodeSelection target), it pre-empts the native
  delete and dispatches a PM transaction.
- File 19 (this file): the dispatched transaction's command is the
  Backspace/Delete chain, ending in `joinBackward`/`joinForward` →
  `selectNodeBackward`/`selectNodeForward`.

So the same Backspace press flows: `keydown` → `capturekeys.ts:266`
(`stopNativeHorizontalDelete`, file 13 §3.3.1) → keymap binding
`Backspace` → `chainCommands(deleteSelection, joinBackward,
selectNodeBackward)` (this file §2.3) → one of the four
`deleteBarrier` strategies (this file §2.2). Treat them as one flow
documented in two layers.

### 8.15 Worked example: custom `Command` from scratch

Goal: `wrapLineInCallout` — wrap the current textblock in a `callout`
node, *and* if the previous sibling is already a callout of the same
attrs, merge into it.

```ts
import { Command } from "prosemirror-state"
import { findWrapping, canJoin } from "prosemirror-transform"
import type { NodeType } from "prosemirror-model"

export function wrapLineInCallout(
  calloutType: NodeType,
  attrs: Attrs | null = null
): Command {
  return (state, dispatch) => {
    const { $from, $to } = state.selection
    const range = $from.blockRange($to)
    if (!range) return false                       // nothing to wrap

    const wrapping = findWrapping(range, calloutType, attrs)
    if (!wrapping) return false                    // schema disallows

    if (!dispatch) return true                     // dry-run

    let tr = state.tr.wrap(range, wrapping)

    // Optional join-with-prior-callout
    const before = tr.doc.resolve(range.start).nodeBefore
    if (before && before.type == calloutType
                && before.sameMarkup(calloutType.create(attrs))
                && canJoin(tr.doc, range.start)) {
      tr = tr.join(range.start)
    }

    dispatch(tr.scrollIntoView())
    return true
  }
}
```

Properties this command demonstrates:

- **Factory** pattern: returns a `Command` closure over the schema-
  specific `NodeType`.
- **Dry-run**: every check happens before the `if (!dispatch)` gate, so
  `cmd(state)` accurately reflects "would dispatch succeed?".
- **`findWrapping`** is the right primitive — it returns the chain of
  wrapper types needed to satisfy the schema (e.g. if `callout` itself
  needs an inner `callout_body`, the wrapping array is `[callout,
  callout_body]`).
- **Auto-join** at the end mirrors `wrappingInputRule`'s pattern
  (§4.6), making the command idempotent across "wrap, wrap again,
  unwrap" sequences without producing sibling-callout pairs.

### 8.16 Worked example: custom `InputRule` with `getAttrs` + `joinPredicate`

Goal: numbered-list rule where the start number is taken from the typed
prefix, and joins with a preceding numbered list only if the typed
number continues the count.

```ts
import { wrappingInputRule } from "prosemirror-inputrules"

export const orderedListRule = wrappingInputRule(
  /^(\d+)\.\s$/,                                   // "1. ", "42. ", …
  schema.nodes.ordered_list,
  match => ({ order: +match[1] }),                 // getAttrs: { order: 1|42|… }
  (match, prevList) => {
    // joinPredicate(match, nodeBefore): merge only if the new typed
    // number equals the previous list's start + childCount.
    const typed = +match[1]
    const expected = prevList.attrs.order + prevList.childCount
    return typed == expected
  }
)
```

How this composes:

- `wrappingInputRule`'s pattern fires when the user types `<n>. `.
- `getAttrs(match)` produces `{ order }` for the new list node.
- `joinPredicate(match, prevList)` decides whether to merge with the
  previous list — `prevList` is the `nodeBefore` of the wrap point
  (`rulebuilders.ts:30`).
- If the user types `1. ` after a list ending at item 3, `typed=1` ≠
  `expected=4`, so a NEW list starts with `order=1`. If they type `4. `,
  the lists merge and the user sees `1. 2. 3. 4.` continuous.
- All the other rule machinery (undo via Backspace, scan-window,
  inCodeMark) comes for free.

### 8.17 Worked example: chained Mac/PC keymap setup

A complete Mod-aware setup that layers app commands above the base
keymap and gets Mac vs PC right via PM's `Mod` resolution:

```ts
import { keymap } from "prosemirror-keymap"
import { baseKeymap, toggleMark, chainCommands,
         setBlockType, wrapIn } from "prosemirror-commands"
import { undo, redo } from "prosemirror-history"
import { splitListItem, liftListItem, sinkListItem }
                                from "prosemirror-schema-list"
import { undoInputRule } from "prosemirror-inputrules"

export function buildKeymap(schema: Schema) {
  const m = schema.marks, n = schema.nodes
  const bindings: Record<string, Command> = {}

  // History — Mod = Cmd on Mac, Ctrl on PC
  bindings["Mod-z"] = undo
  bindings["Shift-Mod-z"] = redo
  bindings["Mod-y"] = redo                  // Windows convention; harmless on Mac

  // Marks
  if (m.strong) bindings["Mod-b"] = toggleMark(m.strong)
  if (m.em)     bindings["Mod-i"] = toggleMark(m.em)
  if (m.code)   bindings["Mod-`"] = toggleMark(m.code)
  if (m.link)   bindings["Mod-k"] = openLinkDialog        // app-specific

  // Block types
  if (n.heading) for (let lvl = 1; lvl <= 6; lvl++)
    bindings[`Shift-Mod-${lvl}`] = setBlockType(n.heading, { level: lvl })
  if (n.paragraph)  bindings["Shift-Mod-0"] = setBlockType(n.paragraph)
  if (n.code_block) bindings["Shift-Mod-\\"] = setBlockType(n.code_block)
  if (n.blockquote) bindings["Mod->"]        = wrapIn(n.blockquote)

  // List operations (layered before baseKeymap's Enter so they win)
  if (n.list_item) {
    bindings["Enter"] = chainCommands(
      splitListItem(n.list_item),
      baseKeymap["Enter"]
    )
    bindings["Tab"]       = sinkListItem(n.list_item)
    bindings["Shift-Tab"] = liftListItem(n.list_item)
    bindings["Mod-["]     = liftListItem(n.list_item)
    bindings["Mod-]"]     = sinkListItem(n.list_item)
  }

  // Backspace: undoInputRule first (revert "—" before deleting), then base
  bindings["Backspace"] = chainCommands(undoInputRule, baseKeymap["Backspace"])

  return bindings
}

// Plugin order: app keymap first (highest precedence), base keymap last.
const plugins = [
  keymap(buildKeymap(schema)),
  keymap(baseKeymap),
]
```

Notes:

- Using `Mod-` everywhere lets `prosemirror-keymap` resolve to `Cmd-`
  on Mac and `Ctrl-` on PC automatically (`keymap.ts:5`). Don't mix
  `Mod-z` and `Cmd-z` in the same map — the normalizer would throw on
  Mac.
- The `Enter` and `Backspace` chains are **explicit** — we shadow the
  base map's binding on those keys but call into it via
  `baseKeymap[key]` so we keep all the joinBackward/splitBlock chain
  behaviour as the fallback.
- `keymap(baseKeymap)` is the *last* plugin so app bindings override
  it, but unhandled keys still flow through.
- `Mod-y` (Windows redo) is bound *in addition* to `Shift-Mod-z`
  because Windows users expect both; on Mac it's harmless (no `Cmd-y`
  conflict in the base map).
