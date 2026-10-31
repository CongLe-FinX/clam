# CL Agent Mesh

> **Distributed AI Agents. One Shared Workspace.**

CL Agent Mesh turns the computers of one person into an AI team. Each computer (a **Node**) runs one or more AI agents — the first supported runtime is [OMP](https://github.com/can1357/oh-my-pi) (`omp`) — behind a local web UI. Nodes pair with each other, delegate tasks to each other's agents, share project context through GitHub, and hand unfinished work from one node to another. A node going offline never interrupts work that is executing on another node.

**Current milestone: M5 — Remote access to a node's own UI, shared sessions and manual takeover** (on top of M4 — Agent-to-agent delegation, task engine and agent discussion; M3 — Node identity, Cloudflare Tunnel, Pairing, Agent Network; M2 — GitHub integration + Project; and M1 — Local Web + OMP RPC + Settings). M1 is a local server and browser UI that drive OMP over its RPC protocol (sessions, streaming chat, tool-call tracking, model selection, context usage and cost), plus Settings for GitHub accounts, OMP providers/login/model roles, and an LLM usage dashboard that keeps OMP-recorded usage and provider-reported quota apart. M2 adds real Git (see [Git and GitHub projects](#git-and-github-projects)): clone a GitHub repository into a new project, status/diff/history, branches, stage/commit, fetch / fast-forward pull / push (never forced), conflict check, pull requests, and a `.clmesh/` bootstrap — in the Git panel of each project. M3 connects nodes (see [Pair two machines](#pair-two-machines)): a Cloudflare Tunnel exposes a separate network listener that serves only the signed `/api/v1`, nodes pair with a short invitation code and verified fingerprints, show each other online/offline, and list each other's agents in an Agent Directory. M4 adds delegation (see [Delegate a task and let two agents talk](#delegate-a-task-and-let-two-agents-talk-m4)): a task is handed to an agent on a paired node, run there with a pushed task branch as the result, discussed in a shared thread whose messages are injected into both agents' sessions, and reconciled after either node was offline. M5 adds shared sessions (see [Share a session and continue it on another node](#share-a-session-and-continue-it-on-another-node-m5)): a session on one node is mirrored live to another, discussed in a shared thread, checkpointed to a shared git branch plus an OMP session snapshot, and continued on the other node by a manual takeover — and each node's own domain can serve its web UI to its owner ([Open a node's UI remotely](#open-a-nodes-ui-remotely)). Shared context and the planned handoff protocol are designed ([docs](#documentation)) but arrive in M6–M7; they appear in the UI as disabled entries with a milestone badge.

## Monorepo layout

```
apps/
  server/            Fastify 5 server: UI listener (/api/local REST, /ws WebSocket, static UI) + network listener (/api/v1 only)
  web/               React 19 + Vite + Tailwind v4 web app
packages/
  contracts/         Zod schemas + TS types shared by server and web (@clam/contracts)
  database/          SQLite (better-sqlite3) + Drizzle schema and migrations
  node-identity/     Node id, Ed25519 keypair, fingerprint, sign/verify primitives
  agent-network/     /api/v1 protocol library: request signing + verification, pairing cryptography, HTTPS client, SSE, wire schemas
  cloudflare-tunnel/ cloudflared lifecycle: quick and named tunnels, readiness, restart with backoff
  secret-store/      macOS Keychain / libsecret / encrypted-file secret store
  agent-runtime/     Runtime adapter interface + OMP RPC adapter (process supervision)
  github-integration/ GitHub OAuth device flow, gh import, repos, permission checks, pull requests
  git-engine/        Real `git` CLI wrapper: status, diff, branches, commit, clone/fetch/pull/push, askpass auth broker
  provider-usage/    Normalized `omp stats` / `omp usage` / `omp models` data
  task-engine/       Pure task rules (M4): state machine, epoch/budget rules, brief + injection texts, host-tool schemas, repo/branch helpers
docs/                Architecture and design documents
```

Planned packages (not yet): `context-engine`, `handoff-engine`, `shared-ui` — see the [module dependency diagram](docs/architecture.md#3-module-dependency-diagram).

Package scope is `@clam/*`. Versioned project metadata that may live in a repository is stored under `.clmesh/`.

## Prerequisites

* **Node.js ≥ 22.12**
* **pnpm 11** (`corepack enable` picks the version pinned in `package.json`)
* **OMP** (`omp`) installed and on `PATH` (or at `~/.bun/bin/omp`). Verified with `omp/18.14.0`. Log in to at least one provider with `omp login <provider>` or from **Settings → OMP Providers & Login**.
* **Git ≥ 2.38** on `PATH` (the server uses the system `git`; `merge-tree --write-tree` conflict checks need 2.38+; developed with 2.50), and optionally the GitHub CLI (`gh`) for the account import shortcut.
* A C/C++ toolchain only if a prebuilt `better-sqlite3` binary is not available for your platform.

## Quickstart

```bash
pnpm install --no-frozen-lockfile     # run from the repo root
pnpm dev                              # server (4317) + Vite dev server (5317)
```

Open **http://127.0.0.1:5317** (development). Vite proxies `/api` and `/ws` to the server.

Production-style run (server serves the built UI):

```bash
pnpm build
pnpm start
```

Open **http://127.0.0.1:4317**.

**Start at login (optional):** run `pnpm build` once, then switch on **Settings → General → Start automatically** in the UI. This writes only the OS login entry (macOS LaunchAgent, Linux systemd user unit, Windows scheduled task) pointing at `apps/server/dist/main.js`; it takes effect at your next login and never starts a second server. Without a built server the request fails with `autostart_not_built`. Details: [docs/architecture.md](docs/architecture.md#6-deployment).

Server-only scripts: `pnpm --filter @clam/server dev|build|start` (`build` bundles `dist/main.js` with workspace packages inlined; `better-sqlite3`, `fastify` and `drizzle` stay external; migrations are copied to `dist/migrations`). Web-only: `pnpm --filter @clam/web dev|build|preview|analyze`. Root: `pnpm typecheck`, `pnpm test` (the web package has no test script yet).

The server listens on loopback only (UI on `4317`, the `/api/v1` network listener on `4318`) and rejects requests with a foreign `Host` header or WebSocket `Origin` ([docs/security.md](docs/security.md)). Never expose the UI port to a network; remote access to a node goes only through its Cloudflare Tunnel, which points at the network listener.

## Git and GitHub projects

M2 turns a project into a real Git working copy. Everything runs the system `git` against real repositories and the real GitHub REST API; there is no simulated Git.

**Connect an account** (Settings → GitHub Accounts: device flow, or **Import from gh**). The token goes to the OS secret store only.

**Clone a project from GitHub:** open **Git** (or the workspace's *Clone* action), choose the account, pick a repository and an absolute target directory (suggested `~/clam/<owner>/<repo>`; it must not exist or be empty — a non-empty directory is refused, never overwritten). The clone runs in the background with live progress; when it finishes a project linked to the repository (`owner/repo`, account, default branch) appears. The same through the API:

```bash
curl -s -X POST http://127.0.0.1:4317/api/local/projects/clone -H 'content-type: application/json' \
  -d '{"workspaceId":"<ws>","accountId":"<github account id>","owner":"<owner>","repo":"<repo>","path":"/abs/path/<repo>"}'
# → 202 {"id":"gop_…","kind":"clone","state":"running",…}   poll GET /api/local/git/operations/<id> or subscribe to WS topic git-op:<id>
```

An existing folder that is already a clone of a github.com repository is linked automatically when you add it as a project.

**Day to day (Git panel / `/api/local/projects/:id/git/*`):** live status (updates when files change on disk or an agent finishes a tool call), diff viewer, history, branches, stage / unstage / commit, fetch, pull, push, conflict check against upstream, pull requests (open, list, status with checks), and **Initialise `.clmesh/`** (README + `config.json`, scanned for secrets, written but not committed).

**Safety rules (enforced and tested):**

* **Pull is fast-forward only** and refuses — leaving every file untouched — when uncommitted changes overlap the incoming commits or when the branches have diverged. You commit or discard (an explicit, confirmed action) and pull again.
* **Push is never forced** (no `--force`, no `--force-with-lease`). A non-fast-forward, protected-branch, permission or SSO rejection is shown with git's / GitHub's own message.
* **Checkout never overwrites** local changes; **discard** needs an explicit confirmation and touches only the files you name.
* **Credentials never touch Git state:** remotes are plain `https://github.com/<owner>/<repo>.git`; the token is handed to git through a one-time-nonce askpass broker (no token in remote URLs, `.git/config`, process arguments, environment or disk). SSH remotes are not managed.
* **Commit identity:** per-project override → the repository's own git config → derived from the linked GitHub account (verified primary email when the token has `user:email`, else `<id>+<login>@users.noreply.github.com`). A commit made for an agent session carries the trailer `Agent: <agentName>@<nodeName>`.

**Two machines (T2):** on each machine clone the same repository (each node has its own data directory and GitHub credentials); one commits and pushes, the other fetches and pulls. Details and exact semantics: [docs/github-integration.md §7–9](docs/github-integration.md#7-clone-management-branches-commits-prs--implemented-in-m2).

## Pair two machines

Two nodes — two computers, or two data directories on one — pair with a short code, verify each other's fingerprint, and from then on see each other online/offline and list each other's agents. Everything below is also available in the UI (**Settings → Cloudflare Tunnel**, **Network**); the `curl` forms use the local API on the UI port.

**1. Give each node a public address** (Cloudflare Tunnel). Install `cloudflared` (macOS: `brew install cloudflared`), then on each machine either:

* **Quick tunnel** — no Cloudflare account. Random `https://<words>.trycloudflare.com`, **new at every start** (your peers are told automatically and follow; a fresh hostname can take a few seconds to resolve). For trying things out; Cloudflare gives no uptime guarantee for it, and it buffers event streams, so peers poll instead.
  ```bash
  curl -s -X PUT  http://127.0.0.1:4317/api/local/tunnel/config -H 'content-type: application/json' -d '{"mode":"quick","autoStart":true}'
  curl -s -X POST http://127.0.0.1:4317/api/local/tunnel/start     # → {"state":"running","publicUrl":"https://….trycloudflare.com",…}
  ```
* **Named tunnel** — stable hostname you own. In the Cloudflare dashboard (Zero Trust → Networks → Tunnels) create a tunnel, copy its **token**, and add a public hostname (e.g. `node-a.example.com`) whose service is `http://127.0.0.1:4318` (this node's network port — **not** the UI port). Then give the token and hostname to the node; the token goes to the OS secret store and a `0600` file for `cloudflared --token-file`, never into argv, environment, logs or API responses.
  ```bash
  curl -s -X PUT http://127.0.0.1:4317/api/local/tunnel/config -H 'content-type: application/json' \
    -d '{"mode":"named","hostname":"node-a.example.com","token":"<tunnel token>","autoStart":true}'
  curl -s -X POST http://127.0.0.1:4317/api/local/tunnel/start
  ```

The tunnel exposes **only** `/api/v1` (signed node-to-node requests plus the public `GET /api/v1/node/info`); `https://<your tunnel>/` and `/api/local/*` answer 404.

**2. Invite** (on node A). Create an invitation for one of A's workspaces; A shows a one-time code `XXXX-XXXX` (valid ≤ 10 minutes, one use, five wrong attempts lock it), A's tunnel URL and A's **fingerprint**.
```bash
curl -s -X POST http://127.0.0.1:4317/api/local/network/invitations -H 'content-type: application/json' -d '{"workspaceId":"<ws id>"}'
```

**3. Join** (on node B). Enter A's URL and the code. B first shows the node behind that URL and its fingerprint — **compare it with the one shown on A** (read it out, or message it over a channel you trust); pairing refuses if the key behind the URL is not the one you verified.
```bash
curl -s -X POST http://127.0.0.1:4327/api/local/network/join/preview -H 'content-type: application/json' -d '{"url":"https://<A tunnel>"}'
curl -s -X POST http://127.0.0.1:4327/api/local/network/join -H 'content-type: application/json' \
  -d '{"url":"https://<A tunnel>","code":"XXXX-XXXX","expectedFingerprint":"<A fingerprint, 64 hex>"}'
```
B needs its own tunnel running so A can reach it to finish pairing.

**4. Approve** (on node A). A shows "node B (fingerprint …) wants to join"; choose the capabilities to grant (default: see agents, read events, send and receive tasks) and approve. Both nodes pin each other's keys, B gets a local copy of A's workspace (same id and name), and both list each other as online within seconds.
```bash
curl -s http://127.0.0.1:4317/api/local/network/pairing-requests
curl -s -X POST http://127.0.0.1:4317/api/local/network/pairing-requests/<id>/approve -H 'content-type: application/json' \
  -d '{"capabilities":["agents.read","events.read","tasks.send","tasks.receive"]}'
```

Afterwards **Network → Peers** (`GET /api/local/network/peers`) shows status, latency and capabilities in both directions, and **Agent Directory** (`GET /api/local/network/agents`) lists the agents of every paired node. **Revoke** (`POST …/network/peers/<id>/revoke`) cuts a peer off before the call returns and tells it; a revoked peer is re-paired with a new invitation. A node that is stopped shows `offline` on its peers after about two minutes and comes back by itself.

Developing without Cloudflare: set `CLAM_ALLOW_LOOPBACK_PEERS=1` on both nodes and use `http://127.0.0.1:<network port>` as the URL. This is **insecure** (no TLS) and only for development and tests. Two nodes on one machine need distinct ports and data directories, e.g.:
```bash
CLAM_PORT=4317 CLAM_NETWORK_PORT=4318 CLAM_DATA_DIR=$PWD/.data/a node apps/server/dist/main.js
CLAM_PORT=4327 CLAM_NETWORK_PORT=4328 CLAM_DATA_DIR=$PWD/.data/b node apps/server/dist/main.js
```

## Delegate a task and let two agents talk (M4)

Two paired nodes (see above) can hand work to each other. The node that delegates is the **sender**, the node whose agent does the work is the **executor**; the executor is the source of truth for status and result, the sender mirrors it. **A node going offline never stops the other one**: the executor keeps running and shows the task, the sender's queued calls are held in a durable outbox, and when the sender returns it reconciles by task id without anything running twice.

**Prerequisites.** Both nodes have the **same GitHub repository** as a project (clone it with the M2 clone flow; the project's linked repository `owner/name` is how the executor finds its copy), a GitHub account with push access on the node that will push, and OMP logged in. The executor's user must have granted the sender `tasks.send` (the default pairing grant does), and `tasks.cancel` if the sender should be able to cancel (not in the default grant — add it in the peer's settings). On the executor, switch on **Auto-accept tasks** for that peer to run delegated tasks without a click (default off; it only applies when exactly one local project is linked to the task's repository — otherwise a human picks the project):

```bash
curl -s -X PATCH http://127.0.0.1:4327/api/local/network/peers/<A node id> -H 'content-type: application/json' -d '{"autoAcceptTasks":true}'
```

**Delegate from the UI** (Agent Directory row, peer, project menu, command palette or the Tasks board → *Delegate*), or through the API on the sender:

```bash
curl -s -X POST http://127.0.0.1:4317/api/local/tasks -H 'content-type: application/json' -d '{
  "targetNodeId":"<B node id>", "projectId":"<A project id>", "title":"Create TASK_SMOKE.md",
  "description":"Create TASK_SMOKE.md in the repository root with one line of text.",
  "deliverAs":"branch", "constraints":{"maxCostUsd":0.5} }'
# → 201 Task (status "offered", delivery "pending" until B has it). Follow it: GET /api/local/tasks/<id>  or WS topics tasks / task:<id>
```

`deliverAs: "branch"` makes the executor create `clam/<node>/<task>-<id>` from `origin/<base>`, let its agent work there, then commit (trailers `Task:` and `Agent:`) and push it with its own GitHub account — never forced; if the push is refused you get a `git format-patch` artifact instead (download it from the task, `git am` it). The executor refuses to start when tracked files have uncommitted changes (the task shows `blocked` with the paths; fix and press *Accept* again). `deliverAs: "summary"` makes no git changes. The result — summary, branch, commit, compare URL, cost — appears on the sender's task; open the compare URL to make the pull request. The executor's agent runs in a normal session titled `Task: <title>` that you can watch on the executor node.

**Let an agent delegate and discuss.** Every agent session gets five host tools: `mesh_agents` (who is paired, their agents), `mesh_delegate` (hand a task to a node/agent from this session's project), `mesh_message` (talk on a task: `question`, `answer`, `note`, and `instruction` for the delegating side), `mesh_task` (status and recent thread) and `mesh_complete` (the executing agent reports `succeeded`/`failed`/`blocked`). Try it: on node A open a session in the shared project and ask

> Use mesh_delegate to ask node-b to add a GREETING.md. Tell its agent to ask me ONE clarifying question with mesh_message before writing the file, and answer it when it arrives.

The executing agent's question arrives in your session as a prompt starting with `[CL Agent Mesh] task <id> · "<title>" · from <agent>@<node> · kind question`; your agent answers with `mesh_message`; the executing agent writes the file, calls `mesh_complete`, and a note `[CL Agent Mesh] task <id> · "<title>" · status succeeded` (summary, branch, compare URL) is injected into your session. Humans can post in the same task thread from either node's UI at any time (human messages are always injected and never counted by the guard). To stop agents from looping, **each node's agents may post at most 12 messages per task without a human message in between**; after that `mesh_message` returns an error and the UI shows "a human must continue".

Notes: do not put secrets in task text or messages (they cross the network and Cloudflare); a task needs `tasks.send` granted by the executor; the executor chooses nothing the sender cannot see — the other node never gets your local paths or credentials, only what the task, thread and result contain ([docs/security.md §5a](docs/security.md#5a-task-delegation-m4-what-crosses-nodes-and-what-can-go-wrong)). Protocol: [docs/agent-network-protocol.md §5.5–5.8](docs/agent-network-protocol.md#55-post-tasks--taskssend-granted-by-the-executor-to-the-sender); design: [docs/architecture.md §4.6c](docs/architecture.md#46c-task-engine-executor-host-tools-and-recovery-m4).

## Share a session and continue it on another node (M5)

A session that runs on node A can be **shared** with an agent on node B: B shows A's conversation live (read-only), both agents and both humans talk in one shared thread, and A keeps **checkpoints** (a commit pushed to a shared git branch plus a session snapshot sent to B). If A goes offline, a person on B presses **Continue on this node** and B's agent carries on from the last checkpoint; A is fenced and shows a read-only "moved" copy when it returns. Reference: [docs/shared-sessions.md](docs/shared-sessions.md).

**Prerequisites.** Two paired nodes (above); the **same GitHub repository** linked as a project on both, with push rights; OMP logged in on both; the capability **`sessions.share` granted by each node to the other** (Network → the peer → capabilities, or `PATCH /api/local/network/peers/<id>`; it is not in the default grant). On B you may switch on **Auto-accept** for A (it applies when exactly one local project matches the repository). Give the session at least one prompt first: a never-prompted session cannot be snapshotted.

**1. Share (on A).** Open the session → **Share / Add agent**, pick the peer and optionally its agent (from the Agent Directory). A creates the shared branch `clam/shared/<slug>-<id>` from the project's HEAD, pushes it and sends the invitation.
```bash
curl -s http://127.0.0.1:4317/api/local/network/agents        # find <B node id> and <agent id>
curl -s -X POST http://127.0.0.1:4317/api/local/sessions/<A session id>/participants -H 'content-type: application/json' \
  -d '{"nodeId":"<B node id>","agentId":"<agent id on B>"}'   # → 201 SharedSession (shared id shs_…)
```

**2. Accept (on B).** The invitation appears in B's UI (or `GET /api/local/shared/invites`); accept it, choosing the local project and agent if more than one fits. B gets a read-only **mirror** of A's session and its own briefed agent session in B's clone.
```bash
curl -s -X POST http://127.0.0.1:4327/api/local/shared/invites/<invite id>/decide -H 'content-type: application/json' -d '{"decision":"accept"}'
```

**3. Work together in the group chat.** The shared session is a group chat: the owner (at either node's UI) and one agent per node talk in one log that **every node keeps a copy of** — it keeps working as long as one node is online, and a node that was away catches up when it returns. Post from either node (`POST /api/local/shared/<id>/messages {"text"}`): a message without a mention goes to the **lead** (A's agent while A drives); `@node-b`, an agent's name or `@all` address agents explicitly, and what an agent was not addressed with is put in front of its next addressed turn. The final text of every agent turn is posted to the group automatically; the agents also have the host tools `mesh_team` and `mesh_say`, and an agent wakes another only by mentioning it (at most 12 such messages per node without a human message in between). A checkpoint is taken automatically after settled turns (at most every 30 s) or on demand (`POST /api/local/shared/<id>/checkpoint`). Details: [docs/shared-sessions.md §4.3](docs/shared-sessions.md#43-the-group-chat).

**4. Take over (on B, e.g. when A is offline).** Wait until B holds a snapshot (the shared session shows the checkpoint as delivered), then press **Continue on this node** — or `POST /api/local/shared/<id>/takeover`. While A is still online CLAM answers `409 driver_online`; confirm (`{"force":true}`) to continue anyway. B checks out the shared branch (it refuses without touching your local changes if they overlap), unpacks the snapshot into a **new local session**, becomes the driver and starts with a continuation note saying what may be missing. Work A did after its last checkpoint is **not** on B.
```bash
curl -s -X POST http://127.0.0.1:4327/api/local/shared/<shared id>/takeover -H 'content-type: application/json' -d '{}'
```
Open **B's UI on B's own domain** to watch it ([below](#open-a-nodes-ui-remotely)). When A returns it learns that B drives: its session becomes read-only (`session_moved`), uncommitted or unpushed work in its clone is committed to `clam/rescue/<shared id>-<node>`, and A follows B as a participant.

**5. Hand over, with A online (one action).** On A's UI (its own domain works too) let A's agent code, then press **Hand over to node-B**. CLAM invites B if it is not a participant yet and waits until B accepted (auto-accept, or a person on B or on B's domain), stops the running turn (or waits for it to finish, depending on *stop running*), saves **everything** — commits all working-tree changes including untracked files, pushes the shared branch and snapshots the session — and B takes over in a new session whose first prompt says that nothing is missing. A then becomes a participant with a live mirror of B's session, and its old session is read-only with a link to B's. If the push or the snapshot fails, nothing is handed over. While it runs, the driving session takes no prompts (`409 transfer_in_progress`).
```bash
curl -s -X POST http://127.0.0.1:4317/api/local/sessions/<A session id>/handover -H 'content-type: application/json' \
  -d '{"toNodeId":"<B node id>","agentId":"<agent id on B>","stopRunning":true}'   # → 202 SharedSession; follow .transfer.phase
curl -s -X DELETE http://127.0.0.1:4317/api/local/shared/<shared id>/transfer          # cancel (until B is asked) or dismiss a finished record
```
`POST …/shared/<id>/transfer` takes the same body for an already shared session. Without `stopRunning` a running turn answers `409 session_busy`. Phases: `inviting`, `waiting_accept` (up to 15 min, then `accept_timeout`; the invitation stays open), `stopping`, `checkpointing`, `delivering`, `handing_over`, `continuing`. A participant leaves with `POST …/shared/<id>/leave`; the driver removes one with `DELETE …/shared/<id>/participants/<node id>`.

Notes: snapshots contain whole conversations and travel only to participants over the signed tunnel — do not share a session that must not reach the other node. Protocol: [docs/agent-network-protocol.md §5.9a](docs/agent-network-protocol.md#59a-shared-sessions--sessionsshare); design: [docs/architecture.md §4.6d](docs/architecture.md#46d-shared-sessions-takeover-and-the-nodes-own-domain-m5).

## Open a node's UI remotely

Each node's domain (its Cloudflare Tunnel) can also serve **that node's own web UI to you**, so you can watch a session from another machine — for example B's continuation after a takeover. It is **off by default** and can only be switched on **at the machine** (the loopback UI at `http://127.0.0.1:4317`): set an owner password (**Settings → Security**, at least 12 characters; the first one can only be set from loopback), then switch **Remote access** on. After that, `https://<node's tunnel domain>/` shows a login page; the session cookie is `HttpOnly`/`Secure`/`SameSite=Strict`, mutating requests need a matching `Origin`, and login attempts are throttled. `/api/v1` is unaffected: node-to-node calls still use signatures only. The UI port itself stays loopback-only. Everything about the credential, cookie, CSRF, lockout and headers is in [docs/security.md §5b](docs/security.md#5b-remote-ui-access-the-owner-logs-in-through-the-nodes-own-domain) — read it before enabling the switch, because a signed-in owner can run commands on that machine through its agents. With a quick tunnel the domain changes at every start; use a named tunnel for a stable address.

## Try two machines on one computer (Docker)

`deploy/docker/` runs two isolated Linux nodes (A and B), each with its own OMP, git, gh, `cloudflared`, data volume and a real Cloudflare quick tunnel as its domain; you drive both through their `https://*.trycloudflare.com` URLs with the owner login. `deploy/docker/clam-nodes.sh build | up | creds | init a | init b | stop a | start a | down` — see [deploy/docker/README.md](deploy/docker/README.md) for the full scenario and the credential notes (`down` deletes the volumes and every imported credential).

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLAM_HOST` | `127.0.0.1` | Bind address; only `127.0.0.1`, `::1`, `localhost` are accepted — anything else refuses to boot |
| `CLAM_PORT` | `4317` | UI server port (`0` = ephemeral) |
| `CLAM_NETWORK_HOST` | `127.0.0.1` | Bind address of the `/api/v1` network listener; loopback only, anything else refuses to boot |
| `CLAM_NETWORK_PORT` | `CLAM_PORT` + 1 (`4318`) | Port of the network listener — the origin your Cloudflare tunnel must point at (`http://127.0.0.1:4318`); must differ from `CLAM_PORT` |
| `CLAM_ALLOW_LOOPBACK_PEERS` | unset | `1` allows `http://127.0.0.1`, `http://localhost`, `http://[::1]` peer URLs (development/tests only; **insecure**). Peers must otherwise be `https://` |
| `CLAM_CLOUDFLARED_BIN` | auto-detected | Explicit path to the `cloudflared` binary |
| `CLAM_DATA_DIR` | `~/.clam` | SQLite database, identity key, secret-store fallback, OMP session directories, usage cache (`pnpm dev` defaults to `<repo>/.data/core`) |
| `CLAM_WEB_DIST` | `apps/web/dist` (when it contains `index.html`) | Built web app to serve statically |
| `CLAM_OMP_BIN` | auto-detected | Explicit path to the `omp` binary |
| `CLAM_OMP_PROFILE` | unset | Passed as `--profile` to every `omp` invocation (isolated OMP profile) |
| `CLAM_LOG_LEVEL` | `info` | pino log level |
| `CLAM_LOG_PRETTY` | on under `pnpm dev`, off otherwise | `1` forces human-readable logs (`pino-pretty`); any other value disables them |
| `CLAM_SECRET_BACKEND` | auto | `auto`, `macos-keychain`, `libsecret` or `encrypted-file`; a forced OS backend that is unusable fails instead of falling back |
| `CLAM_API_URL` | `http://127.0.0.1:4317` | Vite dev proxy target (web dev server only) |
| `WEB_PORT` | `5317` | Vite dev server port (web dev server only) |
| `SHELL_BUDGET_KB` | `180` | Gzip budget for initial JS, enforced by `pnpm --filter @clam/web build` (`scripts/check-budget.mjs`) |
| `ANALYZE` | unset | `1` makes `pnpm --filter @clam/web analyze` write a bundle treemap to `apps/web/dist/stats.html` (`json` → `stats.json`) |

## What lives where

* **Node data:** `<dataDir>/clam.db` (+ `.pre-migrate-<ts>.bak` snapshots), `<dataDir>/run/` (`0700`: git askpass helper and socket; the `tunnel-token` file, `0600`, only while a named tunnel runs), `<dataDir>/sessions/<sessionId>/` (one OMP session directory per CL session), `<dataDir>/identity/` (node keypair), `<dataDir>/secrets/` (only when the encrypted-file store is in use), `<dataDir>/cache/` (usage snapshots). Logs go to stdout.
* **Secrets:** GitHub tokens, the named-tunnel token and (until the joiner's hello is verified) an invitation's derived code key go to the OS secret store (macOS Keychain, Linux Secret Service, otherwise an AES-256-GCM encrypted file — also used on Windows in M1). The node's Ed25519 private key is a `0600` PEM file under `<dataDir>/identity/`. LLM provider credentials stay in OMP's own store; CL Agent Mesh never reads or writes them.
* **OMP:** driven only through its RPC (`omp --mode rpc`) and documented CLI JSON commands.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Control vs execution plane, module diagram, OMP process model, prompt data flow, deployment, failure model |
| [docs/database-schema.md](docs/database-schema.md) | All tables, M1 subset, `git_sync_states` (M2), network tables (M3), task tables (M4), shared-session tables (M5), migration plan |
| [docs/agent-network-protocol.md](docs/agent-network-protocol.md) | `/api/v1` node-to-node protocol: signing, Host binding, idempotency, ordering, fencing, pairing, tasks and discussion (M3–M5 implemented; handoffs are specification) |
| [docs/omp-rpc-compatibility.md](docs/omp-rpc-compatibility.md) | Verified OMP 18.14 capabilities, mapped to requirements, with explicit gaps |
| [docs/github-integration.md](docs/github-integration.md) | Device flow, multi-account, credential storage, repo permissions, M2 Git operations, askpass auth, `.clmesh/` |
| [docs/shared-sessions.md](docs/shared-sessions.md) | Shared sessions as built (M5): model, flows, checkpoints, takeover, transfer, former driver, data model, errors, limits, try-it |
| [docs/handoff-protocol.md](docs/handoff-protocol.md) | Handoff manifest, state machines, recovery, duplicate-execution prevention |
| [docs/security.md](docs/security.md) | Threat model and controls |
| [docs/ui-sitemap.md](docs/ui-sitemap.md) | Sitemap, responsive layout, wireframes |
| [docs/roadmap.md](docs/roadmap.md) | Reconciled milestones M1–M10, acceptance criteria, M1–M5 checklists |
