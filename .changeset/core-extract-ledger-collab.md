---
'@plim/core': patch
---

Move the transaction ledger and collaboration layers out of `@plim/core` into
the new `@plim/ledger` and `@plim/collaboration` packages. `@plim/core` no
longer re-exports those symbols — import `TransactionLedger`, `Collaborator`,
`CollabHub`, and friends from their dedicated packages instead. No core runtime
behaviour changed.
