---
status: accepted
date: 2026-11-25
supersedes: 0020 (in part: "the folder is the truth about which secrets exist"), 0021 (in part: "`index.json` keeps its shape")
superseded_by:
revisit_when: a secret's end has to hold against a wrong system clock, a value already handed to a running command has to be taken back at the end, or callers need a replace that keeps the old end
---
# Machine secrets may end, the machine enforces it, and a replace always states its end

## Context

A secret in the machine store (decision 0020) lived until somebody removed it.
Often it should not: a password shared for one automated run, or an API key
the supplier keeps valid for years that should only work on this machine for
a week. The end has to hold when the server is down or the machine was off, so
it cannot be the server's job to remember to remove it.

A first version of this change let a replace without an end keep the secret's
old end on the command line, and clear it on the wire. When a key is rotated,
the caller (often an AI) then decides the end by leaving an argument out: a
forgotten argument silently made a short-lived secret permanent, or silently
kept an old end on a new value.

## Decision

- A secret may carry an end: `ends_at` (UTC, whole seconds) and `end_kind`.
  `expire` removes the value file at the end and keeps the name, listed as
  expired, until it is replaced or removed; `delete` removes both. An end is
  in the future and at most 10 years ahead. A date or time that does not
  exist (30 February, minute 60) is refused, never rolled over.
- The machine enforces it: a sweep under the store's lock before every read
  and write, when the bridge starts, and every 60 s while a bridge with
  `--machine-secrets` runs. `aib secret run` and `path` refuse an ended
  secret. Each end handled leaves a record (name, kind, moment; never a value)
  for 30 days, at most 100.
- **A replace states its end.** On the wire, a `secret_put` with `replace`
  must carry the `ends_at` key: a time (with `end_kind`) or `null` for
  deliberately no end; without it the bridge answers `end_required` and
  changes nothing. On the command line, `aib secret add --replace` and
  `import --replace` need `--ends-in`/`--ends-at` (optionally
  `--delete-at-end`) or `--no-end`. The old end is never kept. A first put
  keeps the end optional. Decided by the repository owner on 2026-11-25.
- `aib secret end` may change only the time or only the kind and keep the
  other; it reads and writes them under the store's lock, never read in one
  step and written back in another.
- The index holds the ends, so it is no longer only words beside the folder:
  a value file whose entry says it has ended is not a secret, and an expired
  secret is a name without a file. An index that cannot be read is refused
  (`store_unavailable`), never read as empty.
- `index.json` is written as `version: 2` (1 was descriptions and dates). An
  index with a version above what the code knows is refused, never rewritten,
  so a later format change cannot be undone by this code.
- `hello.machine_secrets.revision` is 3. The protocol stays on 0.1 (0005).

## Consequences

- A short-lived secret ends on time with no server involved, and the server
  and the person can see afterwards what ended when.
- Rotating a key costs one more argument, and a caller that forgets it is
  told instead of getting a guess.
- A server written for revision 2 can no longer replace a secret on a
  revision 3 bridge (`end_required`); adding, listing, describing and
  removing work as before. This is the one part of revision 3 that is not
  additive, accepted because a replace that guesses the end is what this
  decision exists to stop.
- Enforcement trusts the machine's clock: set back, a secret lives longer.
- An end stops new uses; a value already handed to a running command is not
  taken back.
- Rolling back: bridges and `aib` from before revision 3 do not read the
  index's `version`, so the bump cannot make them refuse it. Rolled back, a
  machine uses every secret whose value file is still there without its end,
  an older `add --replace` drops that secret's end, and an older write drops
  the ended records. Values that already expired stay gone. Once a newer
  version runs again, every end that passed in between is handled at once.

## Options considered

- Keep the old end on a replace without an end (the first version on the
  command line): rejected, because a forgotten argument then silently decides
  how long a rotated key lives.
- Clear the old end on a replace without an end (the first version on the
  wire): rejected for the same reason in the other direction.
- Let the server remove secrets at their end: rejected; the end must hold
  while the server is unreachable or the machine was off.
- A different index key or file name so that older code sees no index:
  rejected; older code would then rewrite the index without the ends and lose
  them for the newer code too, which is worse than ignoring them for a while.
