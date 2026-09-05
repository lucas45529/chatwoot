# Recovering Hermes and reconnecting a Mac

These utilities prepare private recovery data and an authenticated Mac endpoint.
They do **not** activate a cloud restore or establish the cloud-to-Mac tunnel.
A missing original machine cannot be reconstructed beyond surviving snapshots.

## Preserve both sides first

Do not use `provision-host.sh install` to recover a running server: its renderer
omits session databases and its `rsync --delete` can remove newer cloud data.
Capture the current cloud data separately before reconciling any local backup.
Do not overwrite live `state.db`, credentials, profiles, memory, or cron jobs.
Old provider tokens and Mac/DGX paths need explicit reconciliation; do not replay
old scheduled jobs or start a second Telegram poller during recovery.

Create a new private destination **outside** the source directory:

```sh
python3 deployment/hermes/scripts/snapshot-hermes-state.py create \
  --source /path/to/hermes-data --output /private/recovery/hermes
python3 deployment/hermes/scripts/snapshot-hermes-state.py verify \
  --snapshot /private/recovery/hermes
node deployment/hermes/scripts/snapshot-memory.mjs \
  --source /path/to/memory-mcp --output /private/recovery/memory
node deployment/hermes/scripts/snapshot-memory.mjs verify \
  --snapshot /private/recovery/memory --source /path/to/memory-mcp
```

Hermes snapshots retain configuration without rewriting model/provider choices.
The manifest lists exclusions: caches, logs, code repositories, prior backups,
and symlinks (never followed). SQLite uses the backup API, including committed
WAL data. Each file/database is captured independently, not as a global transaction.
Review exclusions before claiming completeness. Manifests detect accidental
changes; they are not cryptographic signatures against malicious replacement.

Memory capture requires the source's built `dist/local-store.js` and installed
`better-sqlite3`. It holds the store's lock while copying metadata, vectors, and
tombstones, and checks backup JSONL files for changes during copying. FTS is
rebuilt by streaming into the destination; the live index is not changed. ANN is
omitted, so a destination must use its brute-force fallback until rebuilt.
Failed memory captures have no trusted manifest; retain or remove only that
exact new partial destination before retrying with a fresh path.
When multiple Node versions are installed, set `MEMORY_FTS_NODE` to the Node
executable compatible with the source's native `better-sqlite3` build.

## Mac endpoint

```sh
python3 deployment/hermes/scripts/mac-access.py prepare \
  --output /private/hermes-mac-access
python3 deployment/hermes/scripts/mac-access.py serve \
  --config /private/hermes-mac-access/sshd_config
python3 deployment/hermes/scripts/mac-access.py probe \
  --output /private/hermes-mac-access
```

The endpoint listens only on `127.0.0.1:22022`. A dedicated key authenticates as
the current non-root Mac user; the host key is pinned. Password login, TTYs,
forwarding, and user SSH startup scripts are disabled. This grants shell/file
access as that user, **not** an application sandbox. Keep the private client key
only on the Mac and the intended Hermes gateway, never in Git or logs.
`probe --read /path/to/file` checks readability and byte count without displaying
contents. Verify an actual document and rejection without the client key too.
If key generation is interrupted, preserve the partial bundle and prepare a
different new path; do not overwrite or silently regenerate existing keys.

For persistence, a user LaunchAgent may run the same absolute `/usr/sbin/sshd`
command with `RunAtLoad`, `KeepAlive`, private logs, and umask `077`. It must not
enable system-wide Remote Login or add a public/LAN listener.

The planned cloud transport is an **outgoing** authenticated IAP SSH connection
from the Mac, with a reverse Unix socket in a private server directory, mounted
only into the gateway. Do not publish port 22022. Pin the Mac host key there too.
Keep cloud activation pending until the authenticated tunnel and a real file
read from inside the Hermes gateway pass, plus rejection without credentials.

macOS privacy permissions still apply. `EPERM` on Documents/Desktop/cloud files
means those files are unavailable, even when SSH authentication works. Resolve
that OS permission explicitly and re-test; never report blanket document access
based on a successful health check. The Mac must be awake and connected.

## Local regression checks

Memory tests use `MEMORY_TEST_SOURCE` (default `~/.claude/memory-mcp`) only to
resolve the installed native SQLite dependency. Test records and locks are
synthetic and live in temporary directories; no personal memory is read.

```sh
python3 -B deployment/hermes/spec/snapshot-hermes-state_test.py
python3 -B deployment/hermes/spec/mac-access_test.py
node --test deployment/hermes/spec/snapshot-memory.test.mjs
```
