---
status: accepted
date: 2026-11-21
supersedes:
superseded_by: 0023 (in part: the folder is no longer the only truth about which secrets exist; the index holds ends)
revisit_when: a value has to be readable by the server, secrets need encryption at rest or a separate OS user, a turn's output has to be scrubbed of stored values, or the 16 KB prompt cap is too small
---
# Machine secrets: a built-in store, managed by a server only with the operator's opt-in

## Context
A web application may want to keep secrets on the person's machine for them
(an API key a local tool or script needs) and manage them from the app: list
what is there, add or replace one, describe it, remove it. Scripts on the
machine already tend to keep such values one file per secret in a private
folder, read through a small local helper. A first design had the bridge run
an operator-named external command for every operation (`--secret-command`);
that made the bridge's behaviour depend on a program it did not ship, and the
person still had to install and trust that helper. Separately, the 8 KB cap on
`bridge_prompt.text` had become too small for some servers.

## Decision
- The bridge ships the store: `~/.ai-bridge/secrets/` (0700), one file per
  secret (0600 from creation: a temp file opened `O_EXCL` with mode 0600 in the
  folder, fsynced, renamed), descriptions and dates in `index.json` (0600,
  written the same way). The folder is the truth about which secrets exist.
  The folder is refused, never repaired, when it is a symlink, owned by
  someone else or open to others. One writer at a time across processes, by a
  lock directory.
- A server may use it only when the operator starts the bridge with
  `--machine-secrets` (`AI_BRIDGE_MACHINE_SECRETS=1`, recorded by `install`,
  never carried over a reinstall that omits it). Only then does `hello` carry
  `machine_secrets: {revision: 2}`; otherwise every `secret_*` frame is
  answered `machine_secrets_unsupported`. The frames are the earlier draft's
  (`secret_list`, `secret_put`, `secret_describe`, `secret_remove`,
  `secret_result`); revision 2 means a replace is always explicit.
- A value only travels in. No frame, log line, error or `aib secret` command
  ever carries one out; only `aib secret run` reads one, to hand it to the
  command the person named, with that command's output masked.
- `aib secret` works on the store whether or not the flag is on: the flag
  decides what a server may do, not what the machine's own user may.
- A store operation that takes longer than 15 s is answered `timeout` (result
  unknown) instead of holding the frame.
- The prompt cap is its own `hello` field, `bridge_prompt_max_bytes` (16384);
  a server keeps the text within 8 KB for a bridge that does not send it.

## Consequences
- A machine whose operator did nothing exposes nothing to a server, and the
  person still gets a local store with `aib secret`.
- A folder of one-file-per-secret moves in with `aib secret import`; an old
  helper script can forward to `aib secret`.
- The secrets are as safe as the user account: no encryption at rest, no
  versions, no separate user. A value is not scrubbed from turn output yet,
  and a turn that may read the folder (`--allow-dir` above it,
  `--allow-native`) can read a value: the bridge warns at startup.
- A server that may write secrets may write one the person later runs with;
  `run --dotenv` refuses variables that make a program load code.
- The protocol stays on 0.1; all of it is additive (0005).

## Options considered
- Run an operator-named command (`--secret-command`): rejected, because the
  bridge's guarantees (file modes, atomic writes, never printing a value) would
  rest on a program it does not ship, and every operator would need one.
- Announce `machine_secrets` whenever the store exists: rejected; whether a
  server may change secrets on a machine is the operator's choice, like
  `--local-tools` (0004).
- Encrypt the store at rest or run it as another user: left out of this
  phase; it adds a key to keep and a setup step, for a threat (another process
  as the same user) it would not fully stop.
