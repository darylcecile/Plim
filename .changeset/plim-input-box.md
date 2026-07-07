---
"@plim/core": minor
"@plim/editor": minor
"@plim/react": minor
"@plim/markdown": minor
"@plim/mojis": minor
"@plim/collaboration": minor
"@plim/ledger": minor
"@plim/transports": minor
"@plim/html": minor
"@plim/storage": minor
"@plim/test-utils": minor
---

Add `PlimInputBox`, a stripped-down single-block editor for chat/comment-style composers.

`PlimInputBox` is a mini `PlimEditor`: a single block only (Enter never splits), with no
`+` add button and no drag handle, plus a configurable placeholder. It still supports the
non-multi-block extensions — mojis, markdown input rules, slash commands, mentions and
inline formatting — while skipping multi-block concerns (the collab hub, ledger and
transport are simply not wired up). Enter submits, Shift+Enter inserts a soft newline, and
Cmd/Ctrl+Enter always submits; the input clears on submit by default. Multi-paragraph
pastes collapse to soft newlines so the input stays single-block.

Pop-up menus (slash, mention) now anchor to the whole input box in single-block mode, so
they flip cleanly above the composer instead of covering the text being typed.
