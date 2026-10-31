# Two-machine CLAM test bench (Docker)

Two isolated Linux containers, **node A** and **node B**, each running its own CL Agent Mesh node with its own
OMP, git, gh, `cloudflared`, data volume and a **real Cloudflare quick tunnel** as its domain. They behave like two
separate machines: no ports are published, the nodes cannot see each other except through their public
`https://*.trycloudflare.com` URLs, and you drive everything from your host browser through those URLs
(remote UI with owner login).

| file | what |
| --- | --- |
| `Dockerfile` | multi-stage image `clam-node:dev` (Debian bookworm-slim, Node 24, native arch — arm64 on Apple Silicon) |
| `compose.yml` | services `node-a` / `node-b` (containers `clam-node-a` / `clam-node-b`), one named volume each |
| `clam-nodes.sh` | helper: `build up creds init url status logs stop start exec down` |
| `../../.dockerignore` | keeps `node_modules`, `dist`, `.data`, `.git`, `docs`, `deploy` out of the build context |

Each container has: Node 24, `git`, `gh` 2.95.0, `cloudflared` 2026.10.5, `jq`, `curl`, **bun 1.4.4 + OMP 18.14.0**
(`@oh-my-pi/pi-coding-agent`, same version as the host's `omp`; its native addon comes from the
`@oh-my-pi/pi-natives-linux-arm64` package), the built server (`/opt/clam/server`, production `node_modules` with the
compiled `better-sqlite3`) and the built web app (`/opt/clam/web`). It runs as the non-root user `clam`; `HOME=/home/clam`
is a volume holding the OMP profile (`~/.omp`), the gh config (`~/.config/gh`), CLAM data (`~/.clam`: database, node
identity, encrypted secret store) and project clones. Environment: `CLAM_HOST=127.0.0.1`, `CLAM_PORT=4317`,
`CLAM_NETWORK_PORT=4318`, `CLAM_DATA_DIR=/home/clam/.clam`, `CLAM_SECRET_BACKEND=encrypted-file`,
`CLAM_OMP_BIN`, `CLAM_CLOUDFLARED_BIN`, `CLAM_WEB_DIST`. Restart policy `unless-stopped`; healthcheck =
`curl http://127.0.0.1:4317/api/local/health` inside the container.

## Prerequisites

* Docker with Compose v2 (OrbStack or Docker Desktop), internet access (npm, GitHub releases, Cloudflare).
* On the host: `curl`, `jq`, and — for `creds` — a logged-in `omp` and `gh` (`omp auth export`, `gh auth token`).
* Run everything from the repo root (the script works from anywhere, paths are resolved from its own location).

## The scenario, step by step

```bash
alias clam='deploy/docker/clam-nodes.sh'

clam build                      # 1–2 min: pnpm install --frozen-lockfile, pnpm build, bun + OMP, gh, cloudflared
clam up                         # creates volumes + containers, waits until both are healthy
clam creds                      # streams OMP + gh credentials into both nodes (no file on disk), imports gh into CLAM

# Owner password: >= 12 characters, read from STDIN so it never shows up in a process list or shell history.
read -rs PW                     # type the password, Enter
printf '%s' "$PW" | clam init a "Node A"     # name, password, remote UI on, quick tunnel, waits for DNS, prints URL A
printf '%s' "$PW" | clam init b "Node B"     # same for B (use another password if you like)
```

1. **Open both URLs** (`clam url a`, `clam url b` print them again) in two browser windows and **log in** with the owner
   password.
2. **Pair through the UI.** On A: *Network → Invite a node* → *Create invitation* (workspace, capabilities) — it shows the
   one-time code, A's URL and A's fingerprint. On B: *Network → Join a node* → paste A's URL, the code and compare the
   fingerprint → *Join*. Back on A, *Approve* the pairing request. Both nodes then list each other as **online**.
3. Do the rest of your scenario (workspaces, projects cloned from GitHub, sessions, tasks, shared sessions, …). Useful
   while you do: `clam status` (container, tunnel URL, peers), `clam logs a -f`,
   `clam exec b -- bash` (shell as `clam`), `clam exec a -- git -C ~/clam/CongLe-FinX/clam-sandbox log --oneline`.
4. **A goes offline:** `clam stop a`. B reports A `degraded` after ~10–20 s and `offline` after ~1–1.5 min. Work on B continues.
5. **A comes back:** `clam start a`. The quick-tunnel URL **changes**; A announces the new address to B (signed
   address-change announcement, see `docs/agent-network-protocol.md`), B shows A **online** again. `clam start a` prints A's new URL (use it for the browser; the
   old tab must be reopened and you must log in again).
6. **Clean up:** `clam down` removes both containers **and** both volumes (all credentials, identities, clones).
   The image `clam-node:dev` stays; `docker rmi clam-node:dev` removes it.

### Command reference

| command | effect |
| --- | --- |
| `build` | `docker compose build` of `clam-node:dev` |
| `up` | create + start both nodes, wait for `healthy` (idempotent) |
| `creds` | `omp auth export \| docker exec -i <node> omp auth import -`, `gh auth token \| docker exec -i <node> gh auth login --with-token`, then `POST /api/local/github/import-gh` — per node, streamed |
| `init <node> <name>` | password from STDIN; `PATCH settings {nodeName}`, `PUT access/password`, `PATCH access {remoteUiEnabled:true}`, `PUT tunnel/config {mode:quick, autoStart:true}`, `POST tunnel/start`; then waits for `publicUrl`, for the hostname to resolve in public DNS (DoH) **and** for `GET <url>/api/v1/node/info` = 200 from the host; prints the URL. Safe to re-run (it re-sets the password, which signs out remote sessions) |
| `url <node>` | current public URL |
| `status` | container health, node id/fingerprint, tunnel state + URL, peers |
| `logs <node> [args]` | `docker logs` (default `--tail 200`; `-f` follows) |
| `stop <node>` / `start <node>` | machine off / on; `start` waits for the new tunnel URL and prints it |
| `exec <node> -- <cmd>` | `docker exec` as user `clam` (TTY when interactive) |
| `down` | `docker compose down -v` — containers **and** volumes |

`<node>` is `a`, `b`, `node-a`, `node-b` or the container name. Loopback-only admin calls the script makes are plain
`docker exec clam-node-a curl http://127.0.0.1:4317/api/local/...`; you can do the same by hand.

## Notes and gotchas

* **Build cache / lockfile.** The image installs with `pnpm install --frozen-lockfile`; if `pnpm-lock.yaml` and the
  `package.json` files disagree the build fails (fix the lockfile in the repo, not here). `.dockerignore` excludes
  `docs/` and `deploy/`, so editing them does not invalidate the build.
* **Quick tunnels get a new hostname on every start** (`start`, container restart, `docker restart`). A new
  hostname lags in DNS for a few seconds to minutes; `init` / `start` wait for it. Peers learn it through the
  signed address-change announcement.
* **OMP refresh tokens.** `omp auth import` copies OAuth refresh tokens. Providers that rotate refresh tokens on use
  accept only the newest one, so after a node refreshes, your host (or the other node) may be signed out of that account
  and need `omp` login again. Prefer API-key providers or a throwaway account for long runs.
* The OMP optional local speech/embedding packages (onnxruntime, sherpa-onnx, transformers, ~500 MB) are removed from the
  image; they are not used by agents running through CLAM.
* Models: choose them as `provider/id` (e.g. `anthropic/claude-haiku-5-5`); a bare id is rejected with `400`. A fresh
  OMP session already costs ~15k cache-write tokens of system prompt.

## Security notes

* **Credentials live only in the per-node volumes** (`clam-node-a-home`, `clam-node-b-home`): the OMP credential store
  and the gh `hosts.yml` under HOME, and CLAM's AES-256-GCM secret file (`CLAM_SECRET_BACKEND=encrypted-file`, key beside it
  at `0600`; containers have no keychain). `creds` streams them over `docker exec -i` stdin pipes: no file on the host,
  nothing in an image layer, nothing in this repo. `clam down` deletes the volumes and with them every credential. Do not
  `docker commit` or `docker export` a running node.
* The containers publish **no ports**. The CLAM servers bind `127.0.0.1` only (CLAM refuses to boot otherwise); the
  only exposure is `cloudflared` inside each container pointing at the network listener (`127.0.0.1:4318`).
* A quick tunnel is a **public URL** anyone can open. What protects it: with remote UI on, the owner web UI requires the
  owner password (rate-limited login, `__Host-` session cookie, CSRF/Origin checks, see `docs/security.md` §5b), and
  `/api/v1` requires node signatures from paired peers (the unauthenticated `GET /api/v1/node/info` only reveals the
  node's public identity). The local admin API (`/api/local/*`) answers `401` without a login on the tunnel. Use a strong
  owner password (≥ 12 characters, one per node) and run `clam stop` / `clam down` when you are done.
* The nodes share the host's Docker daemon only; they have no mounts from the host.
