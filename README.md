# @tetrixdev/ai-bridge

A local CLI bridge that connects your AI command-line tools (Codex, Claude, Gemini) to web applications via WebSocket. The bridge runs on your machine, receives AI requests from a server, pipes them through your locally installed CLI tools, and streams normalized responses back -- letting web apps use your own AI subscriptions without touching your credentials.

## Quick Start

The **connection token** is generated from the web application that uses the AI Bridge server package (for example, `php artisan ai-bridge:token` for Laravel apps). The **server URL** is the WebSocket server address provided by that application (typically `wss://your-app.com/api/ai-bridge/ws`).

```bash
npx @tetrixdev/ai-bridge --server wss://your-app.com/api/ai-bridge/ws --token YOUR_CONNECTION_TOKEN
```

Or using environment variables:

```bash
export AI_BRIDGE_SERVER=wss://your-app.com/api/ai-bridge/ws
export AI_BRIDGE_TOKEN=YOUR_CONNECTION_TOKEN
npx @tetrixdev/ai-bridge
```

## Running in the background

A bridge has to be running for the web application to reach this machine, so it
usually wants to start when the machine does. `install` sets that up — a user
service on Linux, a launch agent on macOS:

```bash
ai-bridge install --server wss://your-app.com/api/ai-bridge/ws --token YOUR_TOKEN --allow-dir ~/work
ai-bridge list
ai-bridge uninstall your-app-com
```

**Every install has a name, and more than one can run at once.** The name
defaults to the server's hostname, so pointing this machine at a second
application — a test instance beside production is the ordinary case — installs
a second bridge beside the first rather than replacing it.

Re-running `install` for the same server and the same machine replaces that one,
which is what you want after rotating a token or changing `--allow-dir`. Doing it
for a *different* server under the same name is refused:

```
"your-app-com" is already installed and it is paired to your-app.com,
and this would point it at staging.your-app.com.
Give this one a name of its own with --name, or pass --force to replace what is there.
```

That refusal exists because the alternative is silent: the credentials are
overwritten, the running service keeps its old ones until something restarts it,
and the machine then answers a different server than the one it reports to.

Pass `--name` when you want two bridges to the *same* server — one allowed into
one repository and one into another, say.

| Command | What it does |
|---|---|
| `ai-bridge install` | Install or replace a named bridge, and start it |
| `ai-bridge list` | Every bridge on this machine, what it is doing, and where it points |
| `ai-bridge uninstall <name>` | Stop one and remove its service and credentials |

On Linux a user service stops when you log out, which on a machine you reach
over SSH means it stops when you disconnect. `sudo loginctl enable-linger <user>`
keeps it running; `install` says so when it applies.

On Windows the service is a logon task, and its credentials go in a file the
task is pointed at with `--env-file`. They used to go in the user's environment
variables, which is why a Windows machine could hold only one pairing however
many bridges were installed: two of them reading `AI_BRIDGE_TOKEN` read the same
one.

### Following the server's version

A server can say which bridge version every machine should run
(`desired_bridge_version` in its welcome; see PROTOCOL.md). A bridge that runs as
a systemd service follows it by itself, upgrade or downgrade: it fetches that
version, waits until nothing is in progress, pins it and restarts onto it. If
the fetch fails it stays on what it runs and tries again later. It tells the
server whether it will follow, as `self_update` in its hello.

It acts only when all of this is true, and otherwise just logs that the server
wants another version:

- it runs inside a systemd unit (user or system) with `Restart=always` or
  `Restart=on-failure`;
- the unit starts `@tetrixdev/ai-bridge@${AI_BRIDGE_VERSION}`, so the version
  comes from the environment;
- exactly one of the unit's env files sets `AI_BRIDGE_VERSION`, and the bridge
  can write it (`AI_BRIDGE_ENV_FILE=<path>` names it when the unit loads more
  than one);
- it is not turned off with `--no-self-update` or `AI_BRIDGE_SELF_UPDATE=0`.

`ai-bridge install` writes exactly that shape on Linux, pinned to the version
doing the install. A host application with an install script of its own can
write the same thing:

```ini
# ~/.config/ai-bridge-myapp.env   (mode 600)
AI_BRIDGE_SERVER=wss://your-app.com/api/ai-bridge/ws
AI_BRIDGE_TOKEN=...
AI_BRIDGE_VERSION=0.24.0
```

```ini
# ~/.config/systemd/user/ai-bridge-myapp.service
[Service]
EnvironmentFile=%h/.config/ai-bridge-myapp.env
Environment=PATH=%h/.local/bin:%h/.nvm/versions/node/current/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/env npx --yes @tetrixdev/ai-bridge@${AI_BRIDGE_VERSION} --allow-dir /srv/app --allow-native
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

To pin by hand instead, pass `--no-self-update` (or `install --no-self-update`)
and change `AI_BRIDGE_VERSION` yourself, then restart the unit.

**Not covered: macOS and Windows.** `install` pins the installing version into
the launch agent, but launchd and Windows logon tasks do not read a version
from an env file, so those bridges report `self_update: false` and are updated
by reinstalling with the version you want (`npx @tetrixdev/ai-bridge@<v> install …`).

`install` also takes `--allow-native` and `--local-tools`, written into the
unit, for a host that needs them.

`--env-file` is available on its own, too, for anyone running the bridge some
other way. A flag or an environment variable still wins over the file, so a
service can be pointed at one and overridden by hand for a single run.

`install` takes the same `--attachment-*` flags as a direct run and records them
in that bridge's credentials file, where the service reads them back — as its
environment on Linux, through `--env-file` elsewhere. A reinstall that does not
name a setting keeps the one already recorded, so rotating a token does not put
the size caps back to their defaults, and lines somebody else added to the file
are left where they are.

## Options

| Flag | Environment Variable | Description |
|------|---------------------|-------------|
| `--server <url>` | `AI_BRIDGE_SERVER` | WebSocket server URL (`wss://...`) |
| `--token <token>` | `AI_BRIDGE_TOKEN` | Connection token from the web app |
| `--test` | | Test mode -- responds with mock data instead of calling real CLIs |
| `--debug` | | Enable verbose debug logging |
| `--log-file <path>` | `AI_BRIDGE_LOG_FILE` | Also append logs to this file. Rotates once past 5 MB, keeping one previous copy (`<path>.1`) |
| `--local-tools` | | Allow the server to run tools **on this machine, as you**. Off unless you pass it |
| `--engram <url>` | `ENGRAM_URL` | Engram base URL, for resolving secrets into local tools |
| `--engram-token <token>` | `ENGRAM_TOKEN` | Bearer credential for Engram. Defaults to `--token` |
| `--device-label <label>` | | How this machine appears when you approve it |
| `--device-mode <mode>` | | `transcript` or `isolated`. Self-reported |
| `--identity-file <path>` | `ENGRAM_IDENTITY` | Where the device keypair lives (default `~/.engram/device.json`) |
| `--local-data-dir <path>` | `AI_BRIDGE_DATA_DIR` | Where npm packages for local tools are installed, one directory per space (default `~/.ai-bridge`) |
| `--allow-dir <path>[=<label>]` | `AI_BRIDGE_ALLOWED_DIRS` | Permit the server to run turns in this directory. Repeatable; the environment variable is path-separator delimited (`:` on POSIX, `;` on Windows). **Off unless you pass it** — without it a named working directory is refused, and so is `workspace` isolation. Read [Working in a repository](#working-in-a-repository) first |
| `--api <url>` | `AI_BRIDGE_API` | Base URL of the server's HTTP API for attachments, when it is not the same host as `--server`. Defaults to the `https://` origin of `--server` |
| _(no flag)_ | `AI_BRIDGE_DISABLE_PARTIAL_STREAMING` | Set to `1` to make Claude answers arrive one block at a time instead of streaming in chunks. An escape hatch for a CLI whose partial output misbehaves; the bridge already falls back on its own when the CLI does not support partial messages at all |
| `--attachment-max-mb <n>` | `AI_BRIDGE_ATTACHMENT_MAX_MB` | Largest single attachment to download (default `25`) |
| `--attachment-total-mb <n>` | `AI_BRIDGE_ATTACHMENT_TOTAL_MB` | Largest total of attachments per request (default `100`) |
| `--attachment-max-count <n>` | `AI_BRIDGE_ATTACHMENT_MAX_COUNT` | Most attachments one request may carry (default `50`) |
| `--attachment-stall-seconds <n>` | `AI_BRIDGE_ATTACHMENT_STALL_SECONDS` | Give up on a download that has received nothing for this long (default `60`). A download that keeps moving is never cut off by this |
| `--attachment-timeout-minutes <n>` | `AI_BRIDGE_ATTACHMENT_TIMEOUT_MINUTES` | Longest one attachment may take in total, however steadily it arrives (default `60`). Raise it with the size caps if you allow files in the gigabytes |
| `--attachment-cache-ttl-hours <n>` | `AI_BRIDGE_ATTACHMENT_CACHE_TTL_HOURS` | Keep a downloaded attachment for later turns until it has gone unused this long (default `72`). `0` turns the cache off |
| `--attachment-cache-max-mb <n>` | `AI_BRIDGE_ATTACHMENT_CACHE_MAX_MB` | Cap on what is kept for later turns; least recently used go first (default `1024`). `0` turns the cache off |
| `--allow-native` | | Permit the server to select `native` isolation — the CLI's full local environment, including your own MCP servers, hooks, plugins and a shell. **Off unless you pass it.** Only for a bridge you run against your own machine |
| `--no-self-update` | `AI_BRIDGE_SELF_UPDATE=0` | Do not follow the version the server asks for; pin `AI_BRIDGE_VERSION` by hand. See [Following the server's version](#following-the-servers-version) |
| `--keep-attachments` | | Keep downloaded attachments after a turn instead of deleting them. Debugging aid |
| `--mcp-upstreams <file>` | `AI_BRIDGE_MCP_UPSTREAMS` | MCP servers this bridge connects to itself and offers to the CLI, with their MCP Apps views passed to the web application. See [MCP servers of your own](#mcp-servers-of-your-own-mcp-apps) |

## Working in a repository

By default every CLI is spawned in a dedicated empty directory, so a chat can talk about code but cannot touch any. Pass `--allow-dir` and the server may ask the assistant to work inside a real checkout instead — read a repository, edit it, run the tests, commit.

```bash
npx @tetrixdev/ai-bridge \
  --server wss://studio.example.com/api/ai-bridge/ws \
  --token "$AI_BRIDGE_TOKEN" \
  --allow-dir ~/zp-studio=Studio
```

### The posture is server-sent; the capability is yours

> Full detail — how `isolated` is enforced, what it does not stop, and how to
> check it on your own machine — is in [docs/isolation.md](docs/isolation.md).

The server chooses how much the CLI may do, by sending `cli_isolation` on the
handshake. [PROTOCOL.md](PROTOCOL.md) gives the per-CLI flags; the shape is:

| Posture | The CLI may... | Your own environment... |
|---|---|---|
| `isolated` (the default, and what an older server gets) | reach server-declared tools only. No shell, no edits — **subject to the caveat below**. | stays out, except your permission settings. |
| `workspace` | **also use its own file and shell tools**, in the directory the server named. | stays out — your MCP servers, hooks and plugins are still excluded. |
| `native` | do anything the CLI can do. | is fully in play. |

> **What `isolated` does and does not enforce.** The bridge states the posture
> explicitly rather than trusting whatever the CLI happens to be configured to
> do: Claude is run with `--permission-mode manual` and Codex with
> `sandbox_mode=read-only`, so a `permissions.defaultMode: "auto"` in your
> `~/.claude/settings.json` — or a permissive `~/.codex/config.toml` — no
> longer widens what a server can do on your machine. Verified against Claude
> 2.1.260 both ways: with the flag an isolated turn is denied an arbitrary file
> read and an arbitrary shell command; without it, that same setting allowed
> both.
>
> **Gemini is the exception.** It offers no equivalent lever — `--yolo` is on or
> off, and its built-in tools otherwise stall on an approval that headless mode
> cannot answer — so an `isolated` Gemini turn is bounded by Gemini's own
> defaults and by whatever is in `~/.gemini/settings.json`. If your server is
> reachable by people you do not trust, do not offer Gemini.
>
> **What still leaks in `isolated`, on every provider:** user-level instruction
> files, skills, hooks and plugins load, because suppressing them needs `--bare`
> (Claude) or HOME redirection, and `--bare` breaks subscription auth. Those are
> the operator's own configuration rather than something a server chooses, but
> they do shape the turn.

The bridge tells the server which posture it settled on, so an app can show "running `isolated`, because this bridge was started without `--allow-native`" rather than leaving you to find it in this machine's log.

**Both of the permissive postures require an operator opt-in.** `workspace`
needs `--allow-dir`; `native` needs `--allow-native`. A bridge started without
them refuses that posture and runs `isolated` instead, saying so in the log.

This matters more than it looks. `workspace` is what enables the shell, and a
shell in an empty scratch directory is still a shell — so if the allow-list
bounded only the *directory*, a server could switch the capability on by
sending a field. And gating `workspace` alone would have been theatre, because
`native` is strictly broader: a server refused the shell one way would simply
ask for it the other way and get the operator's own MCP servers, hooks and
plugins along with it. Same rule as `--local-tools`, in all three cases: the
operator opts in, never the server.

The bridge advertises what you allowed in its handshake, so the app can show a picker of your checkouts rather than asking you to type a path. A request naming anything outside those roots is refused, and so is one naming a directory that does not exist — the bridge never creates it, because a typo that silently starts an empty session looks exactly like a session that worked.

A working directory belongs to a CLI session for that session's life: a later turn on the same conversation that names a different directory is refused rather than resumed into a session whose history is about somewhere else.

Once cwd is a real checkout, that repository's own `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` load. That is intended — it is the point of working in a checkout.

### Read this before using it

> Once a server may name a working directory and the CLI has shell, the bridge runs code chosen by the server, on this machine, as you. The allow-list bounds where the assistant **starts**, not what it can **reach**: `cd ..` and `~/.ssh` are one command away, and no flag in this table changes that.
>
> The controls that actually carry the weight are: the allow-list is opt-in and empty by default, so a bridge started without `--allow-dir` cannot be pointed anywhere; the connection token is per person and revocable; and you should only connect a bridge to a server you would give a shell to.

`workspace` is a narrower blast radius than `native`, and a real one. It is **not** a sandbox, and nothing here should be read as claiming otherwise. Codex is bounded more tightly than the others (`sandbox_mode=workspace-write` rather than `danger-full-access`); Gemini is bounded least, because `--yolo` is the only lever it offers and there is no middle setting.

### Gemini leaves a file in your checkout, briefly

Gemini has no per-invocation MCP config flag — it reads `.gemini/settings.json` from its working directory. Pointed at a checkout, the bridge therefore writes one there. It handles that explicitly: it **refuses the turn rather than overwriting** a `.gemini/settings.json` your repository already has, deletes the one it wrote when the turn ends — on success, error, cancel, and on the bridge process exiting, so a SIGTERM mid-turn does not leave a stale file that blocks that checkout for good — and removes the `.gemini` directory too if it created it and left it empty. A `SIGKILL` is the one case nothing can clean up; delete the file by hand if you ever see one. Two Gemini turns cannot run in one directory at the same time — the second is refused, because the file holds a per-spawn credential and the loser would read the winner's.

Claude and Codex take their MCP configuration per invocation and never write anything into your checkout.

Two Gemini turns *without* a working directory still share the bridge's scratch
directory and so still race on that one file — a pre-existing wrinkle this
release does not fix, because the fix is a per-turn scratch directory for every
provider. Claude and Codex are unaffected.

## Attachments

A file attached in the chat does not travel over the WebSocket — the server's frame cap is 1 MB, so a screenshot would not fit, and would not fit as a *dropped message* rather than an error. The server sends a reference instead and the bridge fetches it:

- only from the origin it is connected to (or `--api`), only over HTTPS, and never following a redirect;
- into a per-request directory under `~/.cache/ai-bridge/attachments/`, **never into your checkout**;
- verified against the declared size and SHA-256, failing the turn loudly on a mismatch rather than handing the model a truncated file it will describe as corrupt;
- given up on when nothing has arrived for a minute (`--attachment-stall-seconds`), not after a fixed two minutes: a large file on a slow link that keeps moving is fine however long it takes, and a dead one fails in a minute rather than making somebody wait out the clock. An hour per file (`--attachment-timeout-minutes`) remains as the outer bound;
- deleted when the turn ends — on success, error, cancel, and on the bridge process exiting.

### Kept for later turns

The per-turn copy still goes when the turn does, but the same bytes are also kept, for a while, under `~/.cache/ai-bridge/attachment-cache/`, named by their SHA-256. When a later turn attaches the same file it is hard-linked (or copied, on a filesystem that will not link) into that turn's directory instead of being downloaded again, so a 200 MB dump attached in three turns crosses the network once. The assistant is told, in one line of the preamble, that this may happen.

It is a cache, and behaves like one:

- **A miss is an ordinary download.** Anything wrong with the kept copy — gone, expired, the wrong size — means it is fetched again, never that the turn fails.
- **A hit is re-verified** against the checksum the server sent for *this* turn before the assistant sees it. The kept file and the turn's copy are one inode, so an assistant that edits its copy in place has edited the kept one too; the check turns that into a re-download rather than a wrong answer.
- **It has a lifetime.** A file unused for 72 hours expires, and the store is capped at 1 GB, least recently used first. Both are settable, and `0` for either turns the store off (and empties it). It is swept on start, after each turn that brought attachments, and hourly.
- **One store per installed bridge, never per machine.** Two bridges on one machine answer two different servers, and a shared store would hand a file one server's user sent to a turn another server asked for. The store is keyed by the install's name plus a digest of the server and device, so a name later pointed at a different server does not inherit the old server's files either. A bridge run by hand against a server shares the store of the service installed for that same server by default.

`--keep-attachments` is unrelated and unchanged: it keeps the per-turn directories, for debugging, and never cleans them up.

The assistant can send a file back the same way, by calling a bridge-owned tool with a path inside the working directory or that turn's attachment directory. That tool is offered in `workspace` and `native` only. In `isolated`, Claude reaches server-declared tools plus — on a turn that has attachments — permission to read that turn's attachment directory, and nothing else. Codex and Gemini have no equivalent per-path grant: Codex sits at its own read-only sandbox and Gemini at its own defaults, both of which are broader than that. See the posture table in [PROTOCOL.md](PROTOCOL.md). It has to nominate the file itself: nothing else can tell which of the files a turn touched is the answer.

### Files a person sends straight to this machine

A server can also stream a file somebody picks in its chat composer **through** itself and into this machine, keeping no copy of its own (`upload_offer` in [PROTOCOL.md](PROTOCOL.md#person-uploads)). That file is not an attachment in the sense above: it is the only copy, so it is not a cache entry and it is not deleted when a turn ends. It lands in **`<working folder>/file-uploads/`** — the folder the chat works in, one you allowed with `--allow-dir` — and stays there like anything else you put in that folder. Delete it when you are done with it.

- A bridge started without `--allow-dir` has no folder anybody chose, so it refuses the upload rather than inventing one.
- The file is written as a hidden `.part` and only given its real name once the SHA-256 the server computed from the browser's bytes matches the one computed here. A cancelled, stalled, oversized or mismatched upload leaves nothing behind.
- An existing file is never replaced: a second `report.pdf` becomes `report-2.pdf`. The name is reduced to its last path component, so it cannot leave `file-uploads/`, and a `file-uploads` that is a symlink is refused rather than written through.
- When the bridge creates `file-uploads/` it puts a `.gitignore` (`*`) in it, so files a client sent do not show up in `git status` or get committed by accident. Delete the ignore file if you want them tracked.
- The per-file cap is `--attachment-max-mb`, the same one reported in `hello`.

### Handing files back

The person can open or download a file that lives on this machine — one they sent into `file-uploads/`, or one the assistant handed back — without the server keeping a copy: the bridge POSTs the bytes to a one-time server URL and the server pipes them to the browser ([`file_read`](PROTOCOL.md#handing-files-back)). The bridge serves **only files it recorded itself, by an id it minted**, never a path the server names, so a compromised server cannot use this to read anything else on the machine. The record lives in `~/.cache/ai-bridge/served-files/`. At serve time the file must still be a regular file (no symlink) of the recorded size, or the person is told it was changed or removed.

## Local tools

By default every tool call round-trips to the server, and the server runs it.
That is what the bridge has always done, and nothing below changes it unless you
ask for it.

`--local-tools` lets a server mark a tool `execute: "local"`, which the bridge
then runs **here**, with secrets it decrypts locally. This is a real step up in
trust: the server stops being something that runs code on its own machine and
becomes something that runs code on yours, as you. It is the same trust you
extend to any npm package you install, but it should be chosen rather than
inherited, so:

- without `--local-tools`, a tool marked `local` is **refused**, whatever the
  server sends, and the refusal is logged rather than silent
- a `local_call` frame, which is a server asking the bridge to run a tool
  directly rather than a model calling one, goes through the same gate and is
  refused outright by the same flag. There is one way in, not one per message
  type
- a server cannot turn it on by sending a field
- an absent `execute` field means `server`, so existing servers are unchanged

### A sealed value is read through the space that sealed it

A local tool fills its roles with vault items a person chose for it, and an
item may live in a different space from the tool: a tool in a shared space can
run with a login from your private space, because you picked it for that tool.
Engram decides whether you may (it records your choice against a hash of the
tool's whole definition, so a changed tool asks again). What the bridge holds
to is narrower and mechanical: it keeps decrypted values space by space, and a
sealed value is opened only through the space the call names for it, and only
as the field of the item the call says it belongs to. Anything else reads as a
value this device does not hold, and the call fails rather than running without
it.

This is worth stating plainly because an earlier design got it wrong in a way
that looked fine: everything the device could decrypt went into one flat map,
names were exposed bare, and a bare name resolved against all of it.

### Roles and fields, not item names

A tool does not name items. It declares roles, each with the label of the item
that fits and the fields it reads:

```json
{
  "name": "fetch_mail",
  "needs": [{ "role": "mailbox", "kind": "azure_app",
              "fields": ["tenant_id", "client_id", "client_secret"] }]
}
```

and a person chooses which item fills each role. The tool reads
`ENGRAM_MAILBOX_TENANT_ID`, `ENGRAM_MAILBOX_CLIENT_ID` and
`ENGRAM_MAILBOX_CLIENT_SECRET` (`ENGRAM_<ROLE>_<FIELD>`, plain and sealed alike)
and never learns what the item is called, so one `fetch_mail` serves three Azure
app registrations instead of being written three times. The bridge receives
plain fields as values and sealed ones as ids, never a sealed value.

### Why the secret never reaches the server

A local tool call never becomes a `tool_call` frame. The bridge holds a keypair
whose private half never leaves the machine, Engram hands back a space key
wrapped to that public half, and the secret is opened here. The server stores
ciphertext and cannot read it.

```
ai-bridge --server wss://app.example.com/bridge --token ... \
          --local-tools --engram https://engram.example.com
```

On first run this generates a keypair, enrols it, and prints a fingerprint:

```
  This device is waiting to be approved.
  Open Engram, go to Vault, and check these five groups match:

      S35F M2C7 F2SY FDH7 NQHP
```

**Compare them and do not skip it.** That check is what catches a server that
substituted a key of its own during enrolment. Without it the encryption still
runs, every screen still looks right, and the server can read everything.

### What the sandbox covers, and what it does not

Two mechanisms, verified on this machine rather than assumed, and neither
covers what the other does.

**Filesystem: Node's permission model.** When the command is `node`, the tool
runs with `--permission`, may read only its own package directory, may not
write anywhere unless a writable directory was declared, and may not spawn
child processes, load native addons or use WASI. `--allow-child-process` is
never passed, because a child of a permissioned process runs with no permission
model at all and would hand back every restriction in one flag.

**Network: a namespace.** The permission model does **not** cover the network:
a permissioned process still fetches `https://example.com` perfectly well. So a
tool that declares `"network": false` is run under `unshare -rn`, which works
rootless on an ordinary Linux box and leaves the tool with no resolver and no
route.

What that adds up to, per platform:

| Tool runs | Linux | macOS / Windows |
|-----------|-------|-----------------|
| `node`, `network: false` | filesystem confined, network blocked | filesystem confined, **network open** |
| `node`, network unspecified | filesystem confined, network open | filesystem confined, network open |
| anything else (`python`, a shell script, a binary), `network: false` | **filesystem open**, network blocked | **no sandbox at all** |
| anything else, network unspecified | **no sandbox at all** | **no sandbox at all** |

Where a row says the sandbox did not apply, the bridge says so too: every
`local_result` carries a `sandbox` object naming what was and was not enforced,
and the bridge logs a warning when a tool that asked for no network gets one
anyway. Declaring a **host list** rather than `false` is recorded as *not
enforced*: per-host filtering is not implemented, and a tool that declares hosts
gets the whole network.

None of this is a substitute for approving the tool. It bounds an ordinary bug;
it does not contain code that is trying to get out.

### Packages

A tool can name an npm package, pinned exactly:

```json
{ "package": "@scope/fetch-mail@1.2.3" }
```

It is installed with `--ignore-scripts`, into a directory of its own per space,
under `~/.ai-bridge` (see `--local-data-dir`). Ranges, dist-tags, `file:` specs
and git URLs are refused: what runs here has to be the same bytes every time,
and the approval a person gave was for the code they looked at. The integrity
hash npm resolved is recorded, and a later install of the same spec that
resolves to **different bytes** is refused rather than installed quietly.

### Rate limits

Per space, at most 2 local tools run at once, and starts are spaced at least
250ms apart. A third concurrent call is refused rather than queued. This exists
because a panel with a render-loop bug would otherwise spawn processes at UI
speed, each one holding a decrypted credential, and a queue would be the same
thing with a delay.

### What redaction does and does not do

Sealed values reach a tool as environment variables, and the bridge removes those
exact values from stdout and stderr before the model sees them. Plain fields are
not scrubbed: they are not secret. That turns an
accidental `echo $ENGRAM_MAILBOX_CLIENT_SECRET` from a leak into
`[redacted: ENGRAM_MAILBOX_CLIENT_SECRET]`, and catches the likelier accident, which is
a tool printing a connection string in an error message.

Scrubbing happens **before** the output is parsed, so a credential cannot
survive inside a JSON string on its way to the model. A tool's stdout must be
exactly one JSON document; anything else fails the call loudly rather than being
passed back as text, because raw text arriving where a result belongs reads to a
model exactly like a tool that worked.

It is hygiene, not containment. `| base64` defeats it in one word, as does
writing the value to a file. A tool you approved can always use a secret it was
given; what redaction buys is that the value stays out of a transcript that gets
logged, cached and stored elsewhere.

## App backends

With `--local-tools`, this bridge also runs the backends of Engram apps: code
an agent wrote into an app, run on YOUR machine because it uses your logins and
your files. Engram asks you once per version of an app, showing what its
manifest lets it use (endpoints, your data, folders, programs, hosts, vault
roles), before the bridge is ever asked to run it.

- **One process per app version**, started on the first request, stopped after
  10 minutes idle or when the bridge stops, started again by the next request
  after a crash (and not for 30 seconds after three crashes in a minute).
- **Its files** are fetched from Engram by content hash, checked, and cached in
  `<local data dir>/apps/` (`~/.ai-bridge/apps` by default).
- **What confines it:** Node's permission model. It reads its own files and the
  folders its manifest lists, writes only where the manifest says, and starts
  other programs only if the manifest says it runs a shell or programs, and a
  program it starts is NOT confined.
- **Its network (0.29.0):** only the hosts its manifest declares, on ports 443
  and 80, and Engram's own API. Every connection it makes goes through a relay
  in the bridge that checks which host it is for (the TLS server name, or each
  HTTP request's Host), resolves the name itself and refuses private and local
  addresses; UDP, local sockets, listening and DNS for other names are refused
  inside the process. A manifest with `"public_images": true` may also have
  the bridge fetch images (GET only, images only, 3 MB) from any public
  address. What this does not hold: what is said inside TLS to a declared host
  (a shared front end serving other sites), data sent to a declared host
  itself, and any program it starts with `shell` or `programs`.
- **Vault values** reach it as `ENGRAM_<ROLE>_<FIELD>`, like local tools, and
  are scrubbed from what it answers. These are the DEFAULT items you linked to
  the app. For a role that takes several (one account per client), a request
  that names another linked item gets that item's values on its own request
  line, as `vault`, never in the process's environment (0.22.0).

It talks to the bridge over stdin and stdout, one JSON line per request and
per response, so nothing listens on your machine. See PROTOCOL.md "App
backends".

## Subagent prompt per request

A server can add text to the system prompt of every subagent Claude starts in a turn with the optional `subagent_prompt` string on `ai_request` (next to `system_prompt`, which only reaches the main assistant). The Claude adapter writes it to a temp file, passes `--append-subagent-system-prompt-file <file>`, and deletes it when the turn ends. Nested subagents get it; forks do not (they reuse the main system prompt). Needs Claude Code 2.1.261+; on an older CLI the flag is skipped with a warning. Codex and Gemini ignore it. Details in [PROTOCOL.md](PROTOCOL.md#additive-field-subagent_prompt--text-for-every-subagent).

## Thinking level per request

A server can pick Claude's thinking level for a turn with `options.effort` on `ai_request`: one of `low`, `medium`, `high`, `xhigh`, `max`, passed as `--effort <level>` on fresh and resumed turns. Any other value is ignored (logged at debug) and the turn runs at the CLI's default; no value changes nothing. The bridge lists the levels in `hello.effort_levels`. Codex and Gemini ignore it. Since 0.32.0; `xhigh` needs Claude Code 2.1.111+. Details in [PROTOCOL.md](PROTOCOL.md#additive-option-effort--the-claude-thinking-level).

## MCP servers of your own (MCP Apps)

`--mcp-upstreams <file>` makes the bridge an MCP client of servers you choose
(stdio or Streamable HTTP) and offers their tools to the CLI as
`<server>__<tool>`, in `workspace` isolation. When a tool names an
[MCP Apps](https://github.com/modelcontextprotocol/ext-apps) view
(`_meta.ui.resourceUri`), the web application draws it next to the call: the
bridge tells it which call has a view, hands it the whole result (the model
only reads the text), and relays the view's own requests (reading its `ui://`
resource, calling the tools it may call). The view's declared CSP and
permissions reach the web application unchanged, for it to ask you before
granting them.

- Tools marked `visibility: ["app"]` are never offered to the model; tools
  without `"app"` are refused to a view.
- Secrets in the file are references, never values: `{"env": "NAME"}` or
  `{"vault": {"space_id", "secret_id"}}` (an Engram sealed value, as for local
  tools). A literal value under a credential-looking name is refused at start,
  and every resolved value is redacted from what leaves the bridge.
- A stdio server gets only a safe default environment plus what you name, never
  the bridge's own (which holds its token).
- A server that fails is retried with backoff; one that drops is reconnected on
  next use. Its tools stay listed meanwhile.
- An HTTP server that requires OAuth (`"auth": "oauth"`) is signed in to the
  way claude.ai connects a custom connector: discovery, dynamic client
  registration and PKCE by the bridge, a "Connect" link the web application
  shows you, and the code relayed back over the WebSocket. Tokens stay on the
  bridge (`AI_BRIDGE_DATA_DIR/mcp-oauth`, 0600), are refreshed by it, and never
  reach the web application. PROTOCOL.md, "Upstream sign-in (OAuth)".

The file format, secrets and reconnect rules: [docs/mcp-upstreams.md](docs/mcp-upstreams.md).
The wire frames (`hello.mcp_apps`, `tool_result.ui`, `mcp_request`/`mcp_result`):
PROTOCOL.md, "MCP Apps".

## Supported Providers

| Provider | CLI Binary | Session Resume | Streaming | Thinking | Server Tools |
|----------|-----------|----------------|-----------|----------|--------------|
| **Codex** (OpenAI) | `codex` | Yes | NDJSON | Yes | Yes |
| **Claude** (Anthropic) | `claude` | Yes | NDJSON | Yes | Yes |
| **Gemini** (Google) | `gemini` | Yes | NDJSON | Partial | Yes |

The bridge auto-detects which CLIs are installed on startup.

**Server-defined tools** registered by the web application are exposed to every provider through a small MCP server the bridge runs on loopback, with a per-spawn bearer token; a tool call travels back over the WebSocket for the server to resolve. (Earlier versions injected Bash wrapper scripts onto the CLI's `PATH`. That mechanism is gone — the bridge no longer modifies `PATH` at all.)

Codex's own sandbox is set by the isolation posture and not by whether tools are present: `isolated` leaves it at its read-only default, `workspace` sets `workspace-write`, and `native` sets `danger-full-access`. See [Working in a repository](#working-in-a-repository).

## Test Mode

Use `--test` to verify your WebSocket connection and protocol behaviour without needing a real CLI installed. Note that `--server` and `--token` are still required in test mode — the WebSocket connection to the server is what test mode exercises.

```bash
npx @tetrixdev/ai-bridge --server wss://your-app.com/api/ai-bridge/ws --token TOKEN --test
```

In test mode, AI requests receive mock streaming responses (thinking block + text block + done event) that exercise the full protocol.

## Troubleshooting

**Get detailed diagnostics with `--debug`**
For detailed diagnostic output, add `--debug` to the command. This logs each WebSocket message, provider command, and session operation, which is the fastest way to pin down a confusing error before filing a support request.

**"Authentication token is required" / "Server URL is required"**
The token is generated by your web application (e.g. `php artisan ai-bridge:token` for Laravel apps). The server URL is the WebSocket endpoint exposed by that application (typically `wss://your-app.com/api/ai-bridge/ws`). See your application's documentation for the exact values.

**"Connection rejected: invalid or expired token"**
Your token has expired or was revoked. Generate a new one from your web application's admin interface and restart the bridge.

**"No AI CLI tools detected"**
Install one or more supported CLIs:
- Codex: https://github.com/openai/codex
- Claude: https://claude.ai/download
- Gemini: https://github.com/google-gemini/gemini-cli

**"Authentication required — run \`<provider\> auth login\`"**
Your AI CLI's authentication session has expired. Run the indicated login command (e.g. `claude auth login`) and then restart the bridge.

**Where are sessions stored?**
Session mappings are persisted to `~/.ai-bridge/sessions.json` so conversations can be resumed across bridge restarts. You can delete this file to clear all sessions.

## Protocol

See [PROTOCOL.md](./PROTOCOL.md) for the full wire format specification.

## License

MIT
