# API walkthrough (curl and HTTP reference by milestone)

The step-by-step *user* guide is the [README](../README.md). This page keeps the developer-oriented walkthroughs: for each feature the UI steps **and** the equivalent calls to the local API (`http://127.0.0.1:4317/api/local/...`), with the exact semantics, limits and safety rules. Nothing here is required to use the app.

## Status

CL Agent Mesh turns the computers of one person into an AI team. Each computer (a **Node**) runs one or more AI agents — the first supported runtime is [OMP](https://github.com/can1357/oh-my-pi) (`omp`) — behind a local web UI. Nodes pair with each other, delegate tasks to each other's agents, share project context through GitHub, and hand unfinished work from one node to another. A node going offline never interrupts work that is executing on another node.

**Current milestone: M7 — Handoff: move a running task to another node, with dependency setup and a durable acknowledgement** (on top of M6 — Shared context; M5 — Remote access to a node's own UI, shared sessions and manual takeover; M4 — Agent-to-agent delegation, task engine and agent discussion; M3 — Node identity, Cloudflare Tunnel, Pairing, Agent Network; M2 — GitHub integration + Project; and M1 — Local Web + OMP RPC + Settings). M1 is a local server and browser UI that drive OMP over its RPC protocol (sessions, streaming chat, tool-call tracking, model selection, context usage and cost), plus Settings for GitHub accounts, OMP providers/login/model roles, and an LLM usage dashboard that keeps OMP-recorded usage and provider-reported quota apart. M2 adds real Git (see [Git and GitHub projects](#git-and-github-projects)): clone a GitHub repository into a new project, status/diff/history, branches, stage/commit, fetch / fast-forward pull / push (never forced), conflict check, pull requests, and a `.clmesh/` bootstrap — in the Git panel of each project. M3 connects nodes (see [Pair two machines](#pair-two-machines)): a Cloudflare Tunnel exposes a separate network listener that serves only the signed `/api/v1`, nodes pair with a short invitation code and verified fingerprints, show each other online/offline, and list each other's agents in an Agent Directory. M4 adds delegation (see [Delegate a task and let two agents talk](#delegate-a-task-and-let-two-agents-talk-m4)): a task is handed to an agent on a paired node, run there with a pushed task branch as the result, discussed in a shared thread whose messages are injected into both agents' sessions, and reconciled after either node was offline. M5 adds shared sessions (see [Share a session and continue it on another node](#share-a-session-and-continue-it-on-another-node-m5)): a session on one node is mirrored live to another, discussed in a shared thread, checkpointed to a shared git branch plus an OMP session snapshot, and continued on the other node by a manual takeover — and each node's own domain can serve its web UI to its owner ([Open a node's UI remotely](#open-a-nodes-ui-remotely)). Shared context and the planned handoff protocol are designed ([docs](#documentation)) but arrive in M6–M7; they appear in the UI as disabled entries with a milestone badge.

## Scripts and ports

**Start at login (optional):** run `pnpm build` once, then switch on **Settings → General → Start automatically** in the UI. This writes only the OS login entry (macOS LaunchAgent, Linux systemd user unit, Windows scheduled task) pointing at `apps/server/dist/main.js`; it takes effect at your next login and never starts a second server. Without a built server the request fails with `autostart_not_built`. Details: [docs/architecture.md](architecture.md#6-deployment).

Server-only scripts: `pnpm --filter @clam/server dev|build|start` (`build` bundles `dist/main.js` with workspace packages inlined; `better-sqlite3`, `fastify` and `drizzle` stay external; migrations are copied to `dist/migrations`). Web-only: `pnpm --filter @clam/web dev|build|preview|analyze`. Root: `pnpm typecheck`, `pnpm test` (the web package has no test script yet).

The server listens on loopback only (UI on `4317`, the `/api/v1` network listener on `4318`) and rejects requests with a foreign `Host` header or WebSocket `Origin` ([docs/security.md](security.md)). Never expose the UI port to a network; remote access to a node goes only through its Cloudflare Tunnel, which points at the network listener.

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

**Two machines (T2):** on each machine clone the same repository (each node has its own data directory and GitHub credentials); one commits and pushes, the other fetches and pulls. Details and exact semantics: [docs/github-integration.md §7–9](github-integration.md#7-clone-management-branches-commits-prs--implemented-in-m2).

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

Notes: do not put secrets in task text or messages (they cross the network and Cloudflare); a task needs `tasks.send` granted by the executor; the executor chooses nothing the sender cannot see — the other node never gets your local paths or credentials, only what the task, thread and result contain ([docs/security.md §5a](security.md#5a-task-delegation-m4-what-crosses-nodes-and-what-can-go-wrong)). Protocol: [docs/agent-network-protocol.md §5.5–5.8](agent-network-protocol.md#55-post-tasks--taskssend-granted-by-the-executor-to-the-sender); design: [docs/architecture.md §4.6c](architecture.md#46c-task-engine-executor-host-tools-and-recovery-m4).

## Work without a git repository

Git is optional everywhere. You can work with agents on A and B on a plain folder:

* **A project without git.** In the UI choose *New empty folder* (or `POST /api/local/projects {"workspaceId","name"}` with **no `path`**): CL Agent Mesh creates `<dataDir>/projects/<id>` and the project is `managed`. Pointing a project at any existing folder works too; `vcs` (`git`/`none`) is read from the folder every time. Deleting the project keeps the folder unless you ask for `DELETE /api/local/projects/<id>?deleteFiles=true` (managed projects only).
* **A task without a repository.** `POST /api/local/tasks` with just `targetNodeId`, `title`, `description` (plus `workspaceId` if the target shares several) runs in a fresh folder on the executor and returns a summary. Add `projectId` + `inputPaths` to send files along, and `deliverAs: "files"` to get back the files the agent created or changed:

```bash
curl -s -X POST http://127.0.0.1:4317/api/local/tasks -H 'content-type: application/json' -d '{
  "targetNodeId":"<B node id>", "projectId":"<A managed project id>", "inputPaths":["notes.txt"], "deliverAs":"files",
  "title":"Append and summarize", "description":"Append a line to notes.txt and create summary.md." }'
curl -s "http://127.0.0.1:4317/api/local/tasks/<id>/files/preview?projectId=<A project id>"   # per file: new | unchanged | update | conflict, + diffs
curl -s -X POST http://127.0.0.1:4317/api/local/tasks/<id>/files/apply -H 'content-type: application/json' -d '{"projectId":"<A project id>","overwrite":[]}'
```

  A file you changed locally since you sent it is a **conflict** and is only replaced when you list it in `overwrite`; nothing is ever deleted. Credential-looking files are refused as input and left out of results (rule names only).
* **A shared session without git.** Share a session of a plain folder exactly as in M5 (`POST /api/local/sessions/<id>/participants`, or hand over). The shared session is in **files mode**: the driver's folder travels as a bundle with every checkpoint, B accepts into a managed folder (or one of its plain projects), takeover and hand-over restore the folder from the last bundle (a conflicting local edit refuses a takeover unless you confirm; your version is saved as a rescue bundle first), and a former driver's work after its last checkpoint is kept as a rescue bundle you can look at and apply (`/api/local/shared/<id>/rescue/preview|apply`). Details: [docs/shared-sessions.md §11](shared-sessions.md#11-files-mode-shared-sessions-without-a-git-repository-migration-0006_nogit).

## Chats with agents: no project, no repository, files both ways

"Ask agent A and agent B to research a topic, write a report, make a video" needs no GitHub repository and no project picker:

* **A chat without a project.** `POST /api/local/sessions {"title"?}` with no `projectId` gives the conversation a working folder of its own, `<dataDir>/projects/<id>` (a managed folder, `Project.origin = "chat"`, in the node's first workspace or the `workspaceId` you pass; a default workspace is created on a fresh node). The agent writes its notes, reports, images, audio and video there.
* **See, preview and download the files** from any node's UI, including a remote UI over the node's own domain: `GET /api/local/projects/<id>/raw?path=…` streams the bytes with the right content type and HTTP range support (video/audio seeking, PDF), `&download=1` forces a download; `POST …/upload?path=…` stores raw bytes (streamed to disk up to 2 GB, parent folders created, `409` when the file exists unless `&overwrite=1`). Both stay inside the project folder (no `..`, no symlink escape, never `.git`).
* **Files in a group chat.** In a shared session (files mode) a person attaches files to a message (`POST /api/local/shared/<id>/attachments?name=…` with the raw bytes, then `attachmentIds` in the message). The message carries the file's metadata; every member node stores the bytes once under `<dataDir>/attachments/<sha256>`, fetching them from any member that has them and verifying the digest — at once up to 100 MB, otherwise the first time somebody opens the file. When a message reaches an agent, its files are first copied into that agent's working folder under `attachments/<name>` (never overwriting: `name (2).ext`) and the prompt lists the paths. Agents post what they produce with the host tool **`mesh_share_file({path, caption?})`**; it appears in the chat as a message from that agent, and `POST …/attachments/<attId>/save` copies any posted file into a local project folder.

## Shared context: memory, plans and decisions (M6)

A **context** is a short markdown document — a lasting fact (*memory*), a *decision*, a *plan*, a *summary* or a *note* — that belongs to a workspace or to one project. Every context is **private to your node** until you mark it **shareable**; then it is copied to every node that shares the workspace (no git needed), searched in milliseconds, told to agents, and — for a git project — can be written to `.clmesh/` in the repository. Versions are immutable; if two nodes edit the same context at once it is reported as a **conflict** and a person chooses (nothing is merged automatically).

```bash
# create a shareable memory (type: memory | plan | decision | summary | note; omit projectId for the whole workspace)
curl -s -X POST http://127.0.0.1:4317/api/local/contexts -H 'content-type: application/json' -d '{
  "workspaceId":"<ws>", "type":"memory", "title":"Coding style", "body":"Tabs, no semicolons.", "shareable":true }'
curl -s "http://127.0.0.1:4317/api/local/contexts/search?q=semicolons&workspaceId=<ws>"            # ranked, with «hit» excerpts
curl -s -X PATCH http://127.0.0.1:4317/api/local/contexts/<id> -H 'content-type: application/json' \
  -d '{"baseVersion":1,"body":"Tabs, no semicolons, trailing commas."}'                             # 409 stale_version if someone edited first
curl -s -X POST http://127.0.0.1:4317/api/local/contexts/<id>/resolve -H 'content-type: application/json' -d '{"keep":"merged","body":"…"}'   # keep: local | remote | merged
curl -s http://127.0.0.1:4317/api/local/workspaces/<ws>/members                                      # this node + paired peers sharing the workspace
curl -s -X POST http://127.0.0.1:4317/api/local/workspaces/<ws>/members -H 'content-type: application/json' -d '{"nodeId":"<peer node id>"}'
```

* **Sync between nodes.** Pair the nodes and let each one grant the other the capability **`context.sync`** (peer settings → capabilities; it is not part of the default grant). A shareable context then appears on every member node within a second or so, edits flow both ways, an offline node catches up when it returns, and deleting a shareable context removes it everywhere. The sender must also be a **member of the workspace** on the receiver (pairing makes the first membership; `POST /workspaces/<ws>/members` adds a paired node to another workspace and creates it there). Stopping to share a context is only possible on the node that created it. Protocol: [docs/agent-network-protocol.md §5.9](agent-network-protocol.md#59-post-contextsync--contextsync).
* **Project-level contexts** follow the project: a project linked to the same GitHub repository on both nodes (or, for a plain folder, with the same name in the workspace) shares them; workspace-level contexts are not tied to any project.
* **Agents.** Every agent session has two tools: `mesh_memory` (search / read / list the project's memory) and `mesh_remember` (save a note — **always private**, 12 per session, and it cannot change anything that has been shared). The **first prompt of a new session** in a project with contexts starts with a short "Project memory" section (titles and first lines, about 2 000 characters; memory first, then newest).
* **`.clmesh/` in a git project** (never committed for you): `POST /api/local/projects/<id>/context/export` writes the shareable contexts to `.clmesh/memory|decisions|plans|notes|summaries/*.md` plus `context/index.json`, refusing any context that contains something that looks like a secret (rule and line are reported, never the value); review and commit them like any change. After a `git pull`, `POST /api/local/projects/<id>/context/import` reads them back (created / updated / unchanged / conflicts / skipped). Details: [docs/github-integration.md §9](github-integration.md#9-clmesh-layout-versioned-in-the-repo).
* **Search** is SQLite FTS5 over the current text of every context (answers in well under 100 ms with 10 000 snapshots). Schema and design: [docs/database-schema.md §3.3](database-schema.md#33-context-and-git-sync--m2--m6); what crosses nodes and the threats: [docs/security.md §5c](security.md#5c-workspace-context-and-working-folder-bundles-m6-wave-what-crosses-nodes-and-what-can-go-wrong).

## Share a session and continue it on another node (M5)

A session that runs on node A can be **shared** with an agent on node B: B shows A's conversation live (read-only), both agents and both humans talk in one shared thread, and A keeps **checkpoints** (a commit pushed to a shared git branch plus a session snapshot sent to B). If A goes offline, a person on B presses **Continue on this node** and B's agent carries on from the last checkpoint; A is fenced and shows a read-only "moved" copy when it returns. Reference: [docs/shared-sessions.md](shared-sessions.md).

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

**3. Work together in the group chat.** The shared session is a group chat: the owner (at either node's UI) and one agent per node talk in one log that **every node keeps a copy of** — it keeps working as long as one node is online, and a node that was away catches up when it returns. Post from either node (`POST /api/local/shared/<id>/messages {"text"}`): a message without a mention goes to the **lead** (A's agent while A drives); `@node-b`, an agent's name or `@all` address agents explicitly, and what an agent was not addressed with is put in front of its next addressed turn. The final text of every agent turn is posted to the group automatically; the agents also have the host tools `mesh_team` and `mesh_say`, and an agent wakes another only by mentioning it (at most 12 such messages per node without a human message in between). A checkpoint is taken automatically after settled turns (at most every 30 s) or on demand (`POST /api/local/shared/<id>/checkpoint`). Details: [docs/shared-sessions.md §4.3](shared-sessions.md#43-the-group-chat).

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

Notes: snapshots contain whole conversations and travel only to participants over the signed tunnel — do not share a session that must not reach the other node. Protocol: [docs/agent-network-protocol.md §5.9a](agent-network-protocol.md#59a-shared-sessions--sessionsshare); design: [docs/architecture.md §4.6d](architecture.md#46d-shared-sessions-takeover-and-the-nodes-own-domain-m5).

## Hand a running task to another node (M7)

A task that runs on node **B** (delegated by node **A**) can be **handed off** to node **C** while it is in flight: B stops, C restores the work, installs what the work needs, starts a NEW agent session, and from then on C owns the task. A's Task shows the new executor and follows its events and result; B can never run the task again, even if it comes back after a crash (ownership **epochs** and a fencing token). Nothing is released until C wrote a **durable acknowledgement**.

**Prerequisites.** Nodes paired (A–B, A–C and B–C, all in the task's workspace); **`handoff.receive` granted in both directions** between B and C (Network → the peer → capabilities; the Hand-off dialog only offers peers that granted it) and `tasks.receive` from A to C; the task's sender A must be a paired workspace member on C. Git tasks need the same GitHub repository linked on both; files/summary tasks work without any repository.

**1. Hand off (on B).** Task → **Hand off…** (or `POST /api/local/handoffs`). B freezes the task, lets or makes the agent settle (`stopRunning`), asks OMP for a summary (secret-scanned), commits and pushes the work in progress to the task branch (or ships a patch), or bundles the task folder, records the environment (runtimes, package manager, setup/check commands you listed), and offers it to C.
```bash
curl -s -X POST http://127.0.0.1:5127/api/local/handoffs -H 'content-type: application/json' \
  -d '{"taskId":"<task id>","targetNodeId":"<C node id>","stopRunning":true,"setupCommands":["npm ci"],"checkCommand":"npm test"}'   # → 202 Handoff
```
**2. Accept and set up (on C).** In **Handoff Center** C accepts (choosing the project/agent), or accepts automatically (**Settings → Handoffs → Accept handoffs automatically**). **Settings → Handoffs → Dependency setup** decides what happens to the install/setup commands: *Ask me* (each command waits for your approval in the Handoff Center; denied commands are skipped and reported to the agent), *Run automatically*, or *Never run*.
```bash
curl -s -X POST http://127.0.0.1:5137/api/local/handoffs/<id>/decide -H 'content-type: application/json' -d '{"decision":"accept"}'
curl -s -X POST http://127.0.0.1:5137/api/local/handoffs/<id>/setup  -H 'content-type: application/json' -d '{"approve":["<setup command id>"],"deny":[]}'
```
**3. What you see.** Both nodes show the same timeline (`GET /api/local/handoffs/<id>`, topic `handoff:<id>`); C shows the ten steps. B stays the owner (and keeps the task frozen) until C's ack arrives; a deadline (30 min, **Extend** it) ends in `ack_timeout`, where you can **Reclaim** the task on B (needs proof that C did not ack, otherwise an explicit override). A failed setup/validation on C can be fixed and **Retried**.

Crash safety: every state is saved before its side effect, so both nodes recover at boot and when the peer reconnects. To rehearse a crash, start a node with `CLAM_FAULT=handoff:source:awaiting_ack` (or `target:acked`, `*`…): it exits right after that state became durable. Details: [docs/handoff-protocol.md](handoff-protocol.md#11-implemented-as-m7).

## Open a node's UI remotely

Each node's domain (its Cloudflare Tunnel) can also serve **that node's own web UI to you**, so you can watch a session from another machine — for example B's continuation after a takeover. It is **off by default** and can only be switched on **at the machine** (the loopback UI at `http://127.0.0.1:4317`): set an owner password (**Settings → Security**, at least 12 characters; the first one can only be set from loopback), then switch **Remote access** on. After that, `https://<node's tunnel domain>/` shows a login page; the session cookie is `HttpOnly`/`Secure`/`SameSite=Strict`, mutating requests need a matching `Origin`, and login attempts are throttled. `/api/v1` is unaffected: node-to-node calls still use signatures only. The UI port itself stays loopback-only. Everything about the credential, cookie, CSRF, lockout and headers is in [docs/security.md §5b](security.md#5b-remote-ui-access-the-owner-logs-in-through-the-nodes-own-domain) — read it before enabling the switch, because a signed-in owner can run commands on that machine through its agents. With a quick tunnel the domain changes at every start; use a named tunnel for a stable address.

## The machine's Browser

Every machine has its **own Browser** in its web UI (**Browser** in the sidebar): a real headless Chromium-family browser that runs **on that machine** and is streamed to the page, so `localhost:1234` is *that machine's* localhost. Agent X on machine A is serving a web app on `localhost:5173`? Open A's UI (`http://127.0.0.1:4317` at A, or A's domain from anywhere), open **Browser**, type `localhost:5173` — or click the **Running on this machine** chip (`Todo demo · :5173`, web servers found with `lsof`/`ss`/`netstat`, labelled with the page title, newest first; CL Agent Mesh's own servers and system daemons left out). It is the machine's browser, not yours: Vite HMR, websockets and absolute paths just work, and it works through a quick tunnel too.

* **Using it.** Tabs (title, favicon, loading bar), address bar (`localhost:3000`, `3000` and `:3000` become `http://localhost:3000`; other bare hosts get https), back/forward/reload/stop, mouse, touch, keyboard, IME and paste (**Copy** button for the page's selection), page dialogs (`alert`/`confirm`/`prompt`), file uploads from the device you are sitting at, downloads (saved in `<dataDir>/browser-downloads`, offered as links), and a **Console / Network errors** panel for debugging the agent's app. **Fit / Desktop 1440 / iPhone 16 Pro Max** switches the emulated viewport (the iPhone mode adds touch and a mobile user agent) so you can test the app responsively. A debug overlay shows FPS, KB/s and latency.
* **Which browser.** `CLAM_BROWSER_PATH`, then an installed Google Chrome / Chromium / Edge / Brave, then Playwright's cached Chromium (`~/Library/Caches/ms-playwright`, `~/.cache/ms-playwright`). None found: the page offers **Install Chromium** (`npx playwright install chromium` into `<dataDir>/browsers`, with progress). One process, started on first use with a dedicated profile (`<dataDir>/browser-profile`, never your own), controlled over a private pipe (no debugging port), closed after 15 idle minutes without a viewer (`CLAM_BROWSER_IDLE_MS`).
* **Who may use it.** On the machine's own UI it is always available. Through the machine's domain it is **off by default**: switch **Remote Browser** on in **Settings → Security** (from the machine itself, or from a signed-in remote session by re-entering the owner password); logging out everywhere or switching it off closes the live sockets at once. Nothing is relayed through the mesh `/api/v1`: another machine's **Open <machine>'s Browser** button on the peer page opens *that machine's own UI* (`<its public URL>/browser`) in a new tab, where you sign in. See [docs/security.md §5e](security.md#5e-machine-tools-the-browser).

## The machine's own Terminal

Every machine has its **own Terminal** in its web UI (**Terminal** in the sidebar, or **Open terminal here** on a project): real shells (PTYs, `node-pty`) running as the user that runs the node, in that machine's own home or a project/chat folder. `ls`, `vim`, `top`, `htop`, `ssh` and every other full-screen program work.

* **Using it.** Several terminals as tabs (rename with a double-click, close with ×); the starting folder is Home, a project or a chat folder; a login shell (`$SHELL -l`) or any shell listed in `/etc/shells`; `TERM=xterm-256color`, `COLORTERM=truecolor`. Find in output (⌘F), copy/paste, text size (also pinch on a phone); light and dark themes follow the app. On a phone an accessory key bar (Esc, Tab, Ctrl, Alt, arrows, `|`, `~`, `/`, `-`, paste) sits right above the keyboard. Terminals **keep running when the browser closes**: reload or come back later and the page reattaches and replays the last 2 MiB of scrollback. Limits: 12 terminals per machine; a finished shell stays readable for 10 minutes.
* **Another machine's terminal.** From machine A open **Machines → B → Open B's Terminal**: it opens **B's own UI** (B's public address, `/terminal`) in a new tab and you sign in there. Nothing is relayed through the mesh, so a paired machine never gets a shell on yours.
* **Who may use it.** On the machine's own (loopback) UI it is always available. Through the machine's domain it is **off by default**: switch it on under **Settings → Security → Terminal and Browser** (at the machine, or from a signed-in remote session by re-entering the owner password), and opening a terminal through the domain asks for the owner password again (10 minutes). Switching it off, logging out or "sign out everywhere" closes its sockets at once. Details and threat notes: [docs/security.md §5d](security.md#5d-machine-terminal-a-shell-on-the-node-and-the-gate-that-guards-the-machine-tools).
* **API.** `GET/POST /api/local/terminal/sessions`, `GET|PATCH|DELETE /api/local/terminal/sessions/:id`, `GET /api/local/terminal`; the bytes travel on the WebSocket `/ws/terminal/:id` (binary frames both ways, small JSON control frames: `resize`, `ping`; contracts in `packages/contracts/src/terminal.ts`).
* **Docker.** The node image compiles `node-pty` (build tools are in the builder stage) and ships `bash`, `less` and `nano`; a build-time check spawns a PTY from the production tree.

## Try two machines on one computer (Docker)

`deploy/docker/` runs two isolated Linux nodes (A and B), each with its own OMP, git, gh, `cloudflared`, data volume and a real Cloudflare quick tunnel as its domain; you drive both through their `https://*.trycloudflare.com` URLs with the owner login. `deploy/docker/clam-nodes.sh build | up | creds | init a | init b | stop a | start a | down` — see [deploy/docker/README.md](../deploy/docker/README.md) for the full scenario and the credential notes (`down` deletes the volumes and every imported credential).
