---
status: accepted
date: 2026-11-22
supersedes:
superseded_by: 0023 (in part: index.json gains ends and version 2)
revisit_when: a server can write machine secrets without also being able to run turns with a shell on that machine, or a secret's origin has to be shown to the person for another reason (an audit on the machine itself)
---
# Secrets a server wrote are treated like the ones the person added

## Context

With `--machine-secrets` a server may add or replace a secret in the store
(decision 0020), and the person may later hand that secret to a program with
`aib secret run`. A server could therefore choose what a program on the
machine receives: an environment variable through `--dotenv`, or a file a
program trusts as its config. The idea after 0.46.0 was to mark each secret
with who wrote it (a `written_by` field in `index.json`) and to refuse more in
`run --dotenv` for a secret a server wrote.

## Decision

- A secret a server wrote carries no marker, and `aib secret run` treats it
  exactly like one the person added. There is no `written_by` field and no
  extra refusal for it.
- The `--dotenv` denylist stays as it is: it refuses any secret, whoever wrote
  it, that sets a variable that makes programs load code (`LD_*`,
  `NODE_OPTIONS`, `PATH` and the rest in `src/secrets/run.ts`).

Decided by the repository owner on 2026-11-22.

## Consequences

- One rule for every secret, so nothing in the store or in `run` depends on a
  field a writer could get wrong or a later import would lose.
- A server that may write secrets can still write one a program later trusts
  as a config file; the README says so, and that is the program's to trust.
- `index.json` keeps its shape.

## Options considered

- Mark server-written secrets and refuse more for them in `run --dotenv`:
  rejected. A server that can run turns on the machine already has a shell
  there (in `workspace` or `native`) and can run code directly; marking its
  secrets adds no protection against it. A server that cannot run such turns
  writes only values the person then chooses to use.
- Drop the `--dotenv` denylist, by the same reasoning: rejected for now. It
  costs nothing, and it also catches a person's own mistake (a `.env` that sets
  `PATH`).
