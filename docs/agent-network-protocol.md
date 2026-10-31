# CL Agent Mesh — Agent Network Protocol (`/api/v1`)

Status: **M5 implemented** (shared sessions, §5.9a — one capability, twelve additive endpoints, see [shared-sessions.md](./shared-sessions.md)); M4 implemented — everything of M3 (transport, identity, request signing, pairing, heartbeat, `GET /node/info`, `GET /node/health`, `POST /node/pair`, `GET /agents`, `GET /events` stream `node`, `POST /node/announce`, `POST /node/revoke`) plus the task endpoints `POST /tasks`, `GET /tasks/:id`, `POST /tasks/:id/cancel`, `POST /tasks/:id/messages`, `GET /tasks/:id/artifacts/:artifactId`, the `task.updated` frame on the `node` stream, the `(peer, Idempotency-Key)` response store (§6) and the durable outbox (§7). `POST /artifacts`, `/context/sync`, `/handoffs` and the `handoff:` event streams (§5.9–5.12, §5.14 upload, §9 beyond epoch checks) are **specification for M6–M7**: the listener answers `404` for them today. Code is authoritative: `packages/agent-network` (signing, verification, client, wire schemas incl. the task payloads, pairing cryptography), `packages/task-engine` (state machine, epoch/budget rules, texts) and `apps/server/src/network` + `apps/server/src/tasks` (listener, services). Where this text says "implemented as", it documents a decision taken in M3/M4. The local UI API (`/api/local`, [contracts `routes`](../packages/contracts/src/routes.ts)) is a different surface and never crosses nodes.

Goals: nodes of one person's mesh exchange tasks, messages, context references, artifacts and handoffs over HTTPS with mutual authentication, such that every call is attributable, replay-safe, idempotent, ordered and fenced against duplicate execution. The **OMP RPC is never exposed** on this API or over any network.

Conventions: JSON over HTTPS, `Content-Type: application/json; charset=utf-8`, UTF-8, ISO-8601 UTC timestamps, ids are opaque strings. Schemas below are written as TypeScript types; the normative form will be Zod schemas in `@clam/agent-network` (re-exporting shared payloads through `@clam/contracts`).

---

## 1. Transport and exposure

* HTTPS only. A node is reachable through its **Cloudflare Tunnel** (a `quick` tunnel's random `https://*.trycloudflare.com`, or a `named` tunnel on the user's own hostname such as `https://agentA.example.io`). Peer URLs must be `https://`; `http://127.0.0.1|localhost|[::1]` peers are accepted only when the node runs with `CLAM_ALLOW_LOOPBACK_PEERS=1` (development and tests; **insecure**, documented as such).
* **Implemented as:** a second Fastify instance in the server process (the *network listener*) bound to `127.0.0.1:<CLAM_NETWORK_PORT>` (default UI port + 1) serves **only** `/api/v1/*`; every other path is a plain `404`. The tunnel's origin is that listener, so `/api/local/*`, `/ws` and the static UI — served by the separate UI listener — cannot be reached through the tunnel. The listener's Host guard accepts loopback names and the node's own tunnel hostname only.
* TLS terminates at Cloudflare. Peer-to-peer integrity and authenticity **do not depend on TLS alone**: every request is additionally signed (§3).
* **Deviation from the original text:** the network listener is **always on** (loopback), because pairing needs it before any tunnel exists in dev and it is invisible from outside without one; what is switched on and off is the *tunnel*. `SecurityInfo.remoteApiEnabled` is true while a tunnel is up. A paired peer is not required to start it.
* Unauthenticated endpoints: only `GET /node/info` (public identity), `GET /node/health` (minimal liveness) and `POST /node/pair` (pairing handshake, rate-limited, secret-gated by the invitation code). Everything else requires a valid signature from a paired, non-revoked peer.
* **Quick tunnels and streaming:** Cloudflare quick tunnels (`trycloudflare.com`) **buffer** `text/event-stream` responses (measured with cloudflared 2026.10.5: events arrive only when the origin ends the response). Heartbeat polling (§12) is therefore authoritative and the event stream (§8) is an accelerator that may never open; nothing in M3 depends on it. Named tunnels were not measured.

---

## 2. Node identity

* Each node generates an **Ed25519** keypair on first run (`@clam/node-identity`). The private key is a PEM file `<dataDir>/identity/ed25519.key` (mode `0600`, directory `0700`; a looser mode found on load is tightened) next to `ed25519.pub`. **Decision (M3):** it stays a `0600` file rather than moving into the secret store, so the node can boot unattended and the key is never copied into a keychain that other tools can read. It never leaves the node or enters Git, logs, or manifests.
* **Node id** (implemented in `@clam/node-identity`): `node_` + the first 16 hex characters of the fingerprint; stable for the key's life.
* **Fingerprint** (as in `NodeInfo.fingerprint`): full SHA-256 of the raw 32-byte public key, hex, no separators. Displayed to the user for out-of-band verification during pairing (grouped in 4-char blocks in the UI).
* Public keys are encoded on the wire as base64url (no padding) of the raw 32-byte key. The node identity and the `peers` table keep the standard base64 spelling; every decoder accepts either and rejects anything that is not the canonical encoding of exactly 32 bytes. A payload whose `nodeId`/`fingerprint` does not derive from its `publicKey` is rejected as forged.
* **Key rotation** (later): a node announces `{newKey, signature_by_oldKey}` via `POST /node/rotate-key` to each peer; peers accept only when signed by the currently pinned key. Loss of the private key requires re-pairing.
* Peers **pin** each other's public key at pairing. A different key presented later for the same node id is a hard failure (`401 key_mismatch`) surfaced to the user, never silently accepted.

---

## 3. Request signing

Every authenticated request carries these headers:

| Header | Meaning |
| --- | --- |
| `X-Clam-Node-Id` | Sender node id |
| `X-Clam-Key-Id` | Fingerprint prefix (first 16 hex chars) of the signing key (supports rotation) |
| `X-Clam-Timestamp` | Sender's Unix time in **milliseconds** |
| `X-Clam-Nonce` | 128-bit random, base64url — unique per request attempt |
| `X-Request-Id` | ULID, unique per HTTP attempt (logged by both sides) |
| `X-Correlation-Id` | ULID shared by every request/event belonging to one logical operation (task, handoff, pairing) |
| `Idempotency-Key` | Required on every mutating request (§6) |
| `Content-Digest` | `sha-256=:<base64>:` of the exact body bytes (RFC 9530 style); for empty bodies, the digest of the empty string |
| `X-Clam-Signature` | `base64url(Ed25519(privateKey, canonicalString))` |
| `X-Clam-Version` | Protocol version the sender speaks, e.g. `1` (§13) |

Header syntax (a violation is `400 invalid_request`; none may contain a comma, so a header sent twice — which `node:http` folds into `a, b` — is detected): `X-Clam-Node-Id` `[A-Za-z0-9_-]{1,64}`; `X-Clam-Key-Id` 16 lowercase hex; `X-Clam-Timestamp` digits (ms); `X-Clam-Nonce` base64url of 16 bytes; `X-Request-Id`/`X-Correlation-Id` `[A-Za-z0-9_.:-]{1,128}`; `Idempotency-Key` `[A-Za-z0-9._:~@/+=-]{1,128}`; `Content-Digest` `sha-256=:<standard base64, 44 chars>:`; `X-Clam-Signature` base64url of 64 bytes. Requests without `X-Clam-Version` at all are answered `426 unsupported_version`.

### Canonical string

Lines joined by `\n`, no trailing newline:

```
CLAM-SIG-V1
<UPPERCASE HTTP METHOD>
<request path including prefix, e.g. /api/v1/tasks/tsk_01H.../cancel>
<query string sorted by key then value, percent-encoded, or empty>
<host header value, lower-case>
<X-Clam-Node-Id>
<X-Clam-Key-Id>
<X-Clam-Timestamp>
<X-Clam-Nonce>
<X-Request-Id>
<X-Correlation-Id>
<Idempotency-Key or empty>
<Content-Digest value>
```

Including host, method, path, query and body digest binds the signature to exactly one request and target; including the receiver's host prevents cross-node relay of a captured request.

Normalization (both sides): the host is the `Host` header lower-cased with a default port (`:443`, `:80`) dropped; the path is signed exactly as sent/received (no case or trailing-slash folding — `/api/v1/node/info/` is a different, unknown route); the query is split into `key=value` pairs, each component percent-decoded then re-encoded per RFC 3986 (upper-case hex, `+` is a literal plus, not a space), pairs sorted by key then value and joined with `&`.

**Host binding — measured behaviour.** With a real quick tunnel (cloudflared 2026.10.5) the origin receives `Host: <random>.trycloudflare.com` — the **public** hostname, no port — and **no** `X-Forwarded-Host`; it adds `X-Forwarded-For`, `X-Forwarded-Proto: https`, `CF-Connecting-IP`, `CF-Ray` and friends, forwards path and query unchanged and passes custom request headers through. Hence the receiver binds the signature to `req.headers.host` as received and never consults `X-Forwarded-Host`; a sender signs `new URL(peerUrl).host`. A local, non-tunnelled call (tests, loopback peers) carries `127.0.0.1:<port>` instead, which is just as good because that host includes the receiver's own port. The network listener also uses `CF-Connecting-IP` (only when present) as the source address for its pre-authentication and pairing rate limits.

### Verification (receiver), in order

0. *(implemented, before step 1)* a per-source token bucket (burst 600, 100/s) answers `429 rate_limited` — verification records every accepted nonce, so without this anyone who knows a peer id could flood `nonce_log`.
1. `X-Clam-Version` supported, else `426 unsupported_version` (`details.supportedVersions`). A header sent twice or malformed → `400 invalid_request`.
2. Sender node id is a paired peer, else `401 unknown_peer`; revoked → `403 peer_revoked`; `X-Clam-Key-Id` is the pinned key's id, else `401 key_mismatch` (key rotation is not implemented).
3. **Clock skew:** `|now − X-Clam-Timestamp| ≤ 60 s` (default; configurable 30–300 s). Otherwise `401 clock_skew` with `details: { serverTime, maxSkewMs }` so the sender can report/diagnose; the sender never auto-adjusts its clock.
4. **Replay window:** `(peerId, nonce)` must be unseen within the window `skew × 2` (= 120 s default; the entry expires at `now + 2 × skew`). Seen → `409 replayed_request` (without executing). Accepted nonces are stored in `nonce_log` **before** the digest and signature are checked (exactly this order) and pruned after the window; memory-first with SQLite persistence (`INSERT … ON CONFLICT DO UPDATE WHERE expires_at <= now`; warmed from disk at boot) so a restart cannot reopen the window. A retry is a **new attempt**: new nonce and request id, **same** idempotency key and correlation id.
5. `Content-Digest` equals the digest of the received body; reject mismatch with `400 digest_mismatch`.
6. Verify the signature over the canonical string. Failure → `401 bad_signature` (constant-time compare; no detail about which field).
6b. A mutating method without `Idempotency-Key` → `400 invalid_request` (checked after the signature, so the method is already authenticated).
7. Authorization (§10). Failure → `403 forbidden` with `details: { missing: [...] }`.
8. Rate limiting per peer (token bucket, burst 120, 30/s); excess → `429 rate_limited` with `Retry-After`.

Responses are **not** signed in v1 (TLS + the request being signed is sufficient for the threat model of one user's nodes); `Content-Digest` is included on responses and event frames carry their own integrity (§8). Response signing is a v2 candidate.

---

## 4. Common types

```ts
type Id = string;
type IsoDate = string;

interface ApiError {                          // same envelope as the local API (ApiErrorBody)
  error: { code: string; message: string; details?: unknown };
}

interface NodeRef { nodeId: Id; name: string; fingerprint: string; publicUrl?: string }
interface AgentRef { nodeId: Id; agentId: Id }

type Capability =
  | "tasks.send" | "tasks.receive" | "tasks.cancel"
  | "context.sync" | "artifacts.write" | "artifacts.read"
  | "handoff.send" | "handoff.receive"
  | "events.read" | "agents.read"
  | "sessions.share";          // M5: shared sessions (§5.9a)

type TaskStatus =
  | "offered" | "accepted" | "rejected" | "running" | "blocked"
  | "succeeded" | "failed" | "cancelled" | "handed_off";
```

Error `code` values are stable machine strings: `invalid_request`, `unsupported_version`, `bad_signature`, `clock_skew`, `replayed_request`, `key_mismatch`, `forbidden`, `not_found`, `conflict`, `idempotency_conflict`, `stale_epoch`, `rate_limited`, `unavailable`, `internal`. Additive in M3 (§13): `unknown_peer` (401), `peer_revoked` (403), `digest_mismatch` (400), `fingerprint_mismatch` (409, announce), `url_unreachable` (502, announce). The client adds local-only codes: `invalid_peer_url`, `network_error`, `timeout`, `aborted`, `invalid_response`, `response_too_large`, `stream_idle`, `stream_error`.

---

## 5. Endpoints

All paths are under `/api/v1`. "Auth" = signed request from a paired peer with the listed capability.

### 5.1 `GET /node/info` — public

```ts
// 200
interface NodeInfoV1 {
  protocolVersions: number[];            // e.g. [1]
  nodeId: Id; name: string;
  publicKey: string;                     // base64url
  fingerprint: string;                   // hex sha-256
  appVersion: string; platform: string; arch: string;
  publicUrl: string | null;
  capabilities: Capability[];            // what this node offers at all
  runtimes: string[];                    // e.g. ["omp"]
  startedAt: IsoDate;
}
```

### 5.2 `GET /node/health` — public (minimal) / authenticated (full)

```ts
// unauthenticated 200:  { status: "ok" | "degraded" | "down"; time: number }   (database ping only; no details)
// authenticated 200 (any paired, non-revoked peer; no capability needed):
interface NodeHealthV1 {
  status: "ok" | "degraded" | "down"; uptimeMs: number; time: number;
  activeRuntimes: number; maxConcurrentRuntimes: number;
  runningTasks: number; queuedTasks: number;          // M4: executor tasks running|blocked / accepted (waiting for a free working tree)
  checks: { name: string; status: "ok" | "degraded" | "down"; message?: string }[];  // database, omp, runtime
  // additive (§13), consumed by the heartbeat so it never depends on an event stream:
  agentsRevision: string;                // changes whenever GET /agents would answer differently
  grantedCapabilities: Capability[];     // what the answering node currently grants the CALLER
}
```

A request that carries signature headers but fails verification is an error, never a silent downgrade to the minimal answer.

### 5.3 `POST /node/pair` — pairing (see §11)

Unauthenticated by headers; authenticated by the invitation-code proof (hello) or the inviter's transcript signature (confirm). Exact shapes (`wire.PairRequest` in `@clam/agent-network`; public keys base64url):

```ts
// joiner → inviter
{ step: "hello"; invitationId: string; node: { nodeId; name; publicKey; publicUrl }; nonce: string; proof: string }
// inviter → joiner (response): the inviter's user has not approved yet
{ step: "hello"; node: { nodeId; name; publicKey; publicUrl }; nonce: string; proof: string;
  status: "pending_user_approval"; workspaceId: string; workspaceName: string; expiresAt: string }
// inviter → joiner, after the user decided (a separate POST to the joiner's /node/pair)
{ step: "confirm"; invitationId: string; status?: "approved" | "rejected";   // default approved
  capabilities: string[];            // what the inviter grants the joiner = the transcript's capabilities; [] when rejected
  signature: string;                 // inviter's transcript signature; for a rejection over the transcript with capabilities ["rejected"]
  reason?: string }
// joiner → inviter (the HTTP response to that confirm): one round trip, replayable
{ step: "confirm"; signature: string; grantedCapabilities: string[]; status: "paired" }   // what the joiner grants the inviter
```

`invitationId` is derived from the code (`invitationIdFromCode`), because the joiner only knows URL and code. Anything that is not a valid proof, or targets an invitation that is unknown, expired, consumed, revoked or locked, answers an identical `404 not_found`.

### 5.4 `GET /agents` — `agents.read`

```ts
// 200
{ agents: { agentId: Id; name: string; role: string; runtime: string;
            capabilities: string[]; status: "online" | "busy" | "offline";
            activeTasks: number;               // M4: tasks accepted|running|blocked that this node executes with this agent
            acceptsTasks: boolean;             // status !== "offline"
            activeSessions: number }[] }       // additive: runtime sessions open for this agent
```

`role` is free text; callers must not branch on specific role names. **M4:** `activeTasks` counts the executor-side tasks (`accepted`, `running`, `blocked`) assigned to the agent; the agent's `status` is `busy` when its runtime is busy **or** it has a `running`/`blocked` task; `activeTasks` is part of the `agentsRevision` of the health answer, so peers notice a change within one heartbeat.

### 5.5 `POST /tasks` — `tasks.send` (granted by the executor to the sender)

Delegates a task. The caller is the task's **sender**, the answering node its **executor**. Idempotent by `Idempotency-Key` (§6) **and** by `taskId`.

```ts
// wire.CreateTaskRequest (packages/agent-network/src/wire.ts)
interface CreateTaskRequest {
  taskId: Id;                            // `tsk_<ULID>` chosen by the sender; stable across retries
  workspaceId: Id;                       // must be a workspace both nodes are (non-revoked) members of
  projectRef: { repoUrl: string; branch?: string | null; commit?: string | null };  // the task's GitHub repository (+ base branch); the executor maps it to one of ITS projects
  title: string;                         // ≤ 200
  description: string;                   // ≤ 50 000: the instructions
  targetAgentId?: Id;                    // omitted = the executor chooses its agent
  deliverAs: "summary" | "branch";       // additive to §5.5 as first drafted; default "branch"
  constraints: { maxCostUsd?: number; deadline?: IsoDate; approvalMode?: "always-ask" | "always-ask-cached" | "write" | "yolo" };  // advisory; see §10
  epoch: number;                         // ownership epoch (0 for a fresh task)
  correlationId: Id;
  sender: { agentId?: Id | null; agentName?: string | null };   // the delegating agent (display only); empty when a human created the task
}
// 201 (created and not waiting for a human), 202 (created, status "offered": a human on the executor must accept), 200 (replay: known taskId of that peer)
interface TaskRecord {                   // wire.TaskRecord — the executor's view
  taskId: Id; status: TaskStatus; epoch: number;
  agentId?: Id | null; agentName?: string | null; reason?: string | null;   // reason: why rejected / failed / blocked
  createdAt: IsoDate; updatedAt: IsoDate; startedAt?: IsoDate | null; finishedAt?: IsoDate | null;
  result?: { summary: string; autoCompleted: boolean; branch: string | null; commit: string | null; pushed: boolean; compareUrl: string | null;
             artifacts: { artifactId: Id; name: string; sha256: string; size: number }[] } | null;
  cost?: number | null;                  // executor-reported spend, USD
  lastEventSeq: number;                  // seq of the latest task event
}
// 409 idempotency_conflict: the same key with a different body, or the same taskId owned by another peer / by an outgoing task
// 403 forbidden: workspace unknown to the executor or the caller is not one of its members, or tasks.send not granted
// 400 invalid_request: malformed body, repository that is not on github.com, unknown targetAgentId (code unknown_agent)
```

**What the executor does with it.** It stores the task as `offered` (first event, seq 1) and resolves the repository to local projects: the normalized GitHub `owner/name` (`normalizeRepoUrl`, case-insensitive; credentials in a URL are dropped) is compared with the repository linked to each local project. **Auto-accept** happens only when the sender's peer row has `autoAcceptTasks` **and exactly one** project matches; otherwise the task waits as `offered` until a human on the executor accepts it (choosing the project, or cloning the repository first) or rejects it with a reason (`rejected`, terminal). An accepted task is queued as `accepted` and starts when no other task holds the working tree of the same project (one running task per project).

**What the executor runs.** A normal agent session titled `Task: <title>` in the resolved project, so humans on the executor can watch it. The first prompt is a brief composed by CL Agent Mesh (task, delegator, repository/branch, `deliverAs` semantics, how to use the mesh host tools). Approval mode is the stricter of the node's setting and `constraints.approvalMode`; `maxCostUsd` becomes OMP's `--max-cost`. For `deliverAs: "branch"` the executor refuses to start when the working tree has tracked uncommitted changes (task `blocked`, a human fixes it and re-accepts), fetches, creates `clam/<node-slug>/<task-slug>-<shortid>` **from the commit of `origin/<base>`** (so the branch has no upstream and can never push onto the base branch) and, on success, commits (`Task: <id>` and `Agent: <agent>@<node>` trailers) and pushes with the executor's own GitHub account — never forced. A refused or failed push attaches a `git format-patch` artifact and reports `pushed: false`; the original branch is checked out again when the tree is clean. Cancelling or failing never destroys work: the branch and files stay and the reason says where.

### 5.6 `GET /tasks/:id` — any paired peer, **only for its own task**

Returns `TaskRecord` plus, when `?since=<seq>` is given, `events: TaskEvent[]` — the executor's timeline entries with `seq > since`, oldest first and gap-free (`{seq, type: status|progress|tool|message|result|note, at, summary, payload?}`; at most 2000 per answer, the sender polls again while it is behind). A task that does not exist **or belongs to another peer** answers `404 not_found` (existence is never revealed). No capability beyond being paired is needed, because both the sender and the executor of a task must be able to read it. **This poll is authoritative for the sender's mirror** (§12): the sender calls it every ~5 s while the task is active and immediately when the executor comes back online; the `task.updated` frame (§8) only makes it call sooner.

### 5.7 `POST /tasks/:id/cancel` — `tasks.cancel` (granted by the executor to the sender)

```ts
interface CancelRequest { epoch: number; reason?: string }     // wire.CancelTaskRequest
// 200 TaskRecord — "cancelled", or the existing terminal status (idempotent)
// 409 stale_epoch (details.currentEpoch) if epoch < task epoch; 409 conflict if epoch > task epoch
// 404 for a task that is not the caller's / not executed here
```

The default pairing grant does **not** include `tasks.cancel`; the executor's user adds it in the peer's settings. Without it the sender's UI refuses to cancel a delivered task (`409 capability_missing`), while a task that was **never delivered** (its create still queued with zero attempts) is cancelled locally and never leaves the sender. Cancellation maps to OMP `abort` on the executing node: a queued task is cancelled directly; a running one has its session aborted, the leftovers (branch, uncommitted files) are recorded in `reason`, and the runtime slot and the working tree are released. A task that already reached a terminal state is returned unchanged.

### 5.8 `POST /tasks/:id/messages` — both directions

Each task has a **discussion thread** shared by both nodes. Whoever authors a message stores it locally (`delivery: pending`) and queues it in the outbox (§7); the receiving node stores it under the **same id** and injects it into its own agent session.

```ts
interface TaskMessageRequest {           // wire.TaskMessageRequest
  messageId: Id;                         // author-chosen `msg_<ULID>`; dedupe key (with Idempotency-Key)
  epoch: number;
  kind: "instruction" | "question" | "answer" | "note";   // `question` is the additive M4 kind an executing agent uses to ask its delegator
  body: string;                          // ≤ 20 000
  author: { kind: "human" | "agent"; agentId?: Id | null; agentName?: string | null };
  createdAt: IsoDate;
}
// 202 { messageId: Id; accepted: true; eventSeq: number }       (also for a duplicate delivery)
// 403 forbidden — capability missing; 404 — not the caller's task; 409 stale_epoch / conflict — epoch; 400 — kind not allowed for the author's role
```

Capability by **role of the receiver**: the executor needs the sender to hold `tasks.send`; the sender needs the executor to hold `tasks.receive` (what each granted the other at pairing, §10). Rules enforced on both ends (`canSendKind`): only the task's **sender** may send an `instruction`; the executing agent asks with `question` and the delegating side answers with `answer`/`note`. Messages are ordered by `(createdAt, id)` on both nodes, so out-of-order deliveries still produce the same thread; a replay of a known `messageId` changes nothing. The executor additionally records every message as a `message` event in the task timeline (so the sender's mirror carries the discussion too).

**Loop guard.** Each node lets its **agents** author at most **12** messages per task without a human message in between (either node's human message replenishes the budget); `mesh_message` (the agent tool) returns an error after that telling the agent that a human must continue, and the UI shows the remaining budget (`Task.agentMessageBudget`). The limit is a constant of `@clam/task-engine` (`AGENT_MESSAGE_LIMIT`).

**Injection.** A received message — and a human-authored message on this node — is injected into the local agent session of the task as a prompt: the executing session on the executor, the delegating session (`sender.sessionId`, only when an agent created the task) on the sender. Delivery follows the agent's state: idle → plain prompt (wakes the agent), busy + `instruction` → `steer`, busy otherwise → `followUp`. The text starts with the line `[CL Agent Mesh] task <taskId> · "<title>" · from <agent>@<node> · kind <kind>` and ends with a one-line reminder of how to reply. When the executor finishes, the sender's delegating session gets the note `[CL Agent Mesh] task <taskId> · "<title>" · status <status>` with summary, branch and compare URL.

### 5.8b `GET /tasks/:id/artifacts/:artifactId` — the task's sender only

Serves a stored task artifact (today: the patch of a refused push) with `Content-Type`, `Content-Length`, `Content-Disposition: attachment`, `Content-Digest: sha-256=:…:` and the bytes. Only the **sender** of a task the caller delegated to this node may fetch it (`404` for anyone else, for unknown artifacts, and for tasks that are not executed here). Artifacts are stored on the executor under `<dataDir>/artifacts/<taskId>/` with their sha256, capped at **25 MiB**, and **text artifacts are scanned for credentials with the git engine's secret scanner before they are stored — a hit refuses the artifact** (the task reports it in the result note instead; the finding's content is never echoed). The sender's local route `GET /api/local/tasks/:id/artifacts/:artifactId` fetches it on demand from the executor (signed request, size cap, sha256 verified against the result's entry) and streams it to the UI; only artifacts listed in the task result are downloadable.

### 5.9a Shared sessions — `sessions.share`

Additive in M5 (section number `5.9a` because `5.9` and up keep their numbers). One piece of work, driven by an OMP session on one node (the **driver**), is shared with agents on other nodes (the **participants**): live read-only mirror, shared discussion thread, checkpoints (git + OMP session snapshot), manual takeover with a fencing **epoch**, transfer. Behaviour and flows: [shared-sessions.md](./shared-sessions.md); schemas: `wire.Shared*` in `packages/agent-network/src/wire.ts`.

**Common rules.**

* **Auth:** every endpoint below is a signed `/api/v1` request ([§3](#3-request-signing)) and needs the capability **`sessions.share` granted by the RECEIVING node to the caller**. It is not part of the default pairing grant. A node also checks, before it queues anything, that it holds `sessions.share` from the peer and has granted it back: `409 capability_missing` (`details.missing`) otherwise.
* **Visibility:** a shared session is visible to its participants only; an unknown id, or a caller that is not a participant, gets `404 not_found`. Role violations (e.g. a non-driver announcing a checkpoint) answer `403 forbidden`.
* **Idempotency:** every mutating call except `/mirror` and `/messages/sync` requires `Idempotency-Key` and runs under the response store of §6 (same key + same body replays the answer with `Idempotent-Replay: true`, another body → `409 idempotency_conflict`), plus natural keys (`inviteId`, `messageId`, checkpoint `seq`). Mirror frames are idempotent by `(streamId, seq)` instead (below); `messages/sync` is a read (below).
* **Epoch:** `epoch` is a fencing token, 1 at creation, +1 at each driver change. On a driver-only call (`mirror`, `checkpoints`, `membership` with `action: "remove"`, `transfer`, `driver`) a receiver at a **higher** epoch answers `409 stale_epoch` (`details.currentEpoch`, usually `driverNodeId`); a receiver at a **lower** epoch answers `409 epoch_unknown` and reconciles (it calls `GET /shared/:id` on the sender); a `driver` notice must carry an epoch **greater** than the receiver's (equal from another node: `409 split_brain`; equal from the known driver: a duplicate, `200`). Only the node the receiver knows as driver may send mirror, checkpoint and transfer calls (`403 forbidden`).
* **Delivery:** the sender uses the durable outbox of §7 for invite, decision, message, checkpoint, ack, driver and membership calls (at-least-once, ordered per shared session and peer); `GET` calls, `mirror` and `messages/sync` are not queued. A group message whose delivery died is still found by the peer's `messages/sync`.

| Endpoint | Caller → receiver | Body | Success |
| --- | --- | --- | --- |
| `POST /shared/invites` | driver → invited node | `SharedInviteRequest` | `201 SharedInviteAccepted` (auto-accepted), `202` (pending a human), `200` (repeat) |
| `POST /shared/:id/decision` | invited node → driver | `SharedDecisionRequest` | `200 {ok:true}` |
| `POST /shared/:id/messages` | any participant node → each other (its own messages) | `SharedMessageRequest` | `202 {messageId, accepted:true}` |
| `POST /shared/:id/messages/sync` | any participant node → any other | `SharedMessagesSyncRequest` | `200 SharedMessagesSyncResponse` |
| `POST /shared/:id/mirror` | driver → participant | `SharedMirrorRequest` | `200 SharedMirrorAccepted` |
| `POST /shared/:id/checkpoints` | driver → participant | `SharedCheckpointNotice` | `202 {ok:true}` |
| `POST /shared/:id/checkpoints/:seq/ack` | participant → driver | `SharedCheckpointAck` | `200 {ok:true}` |
| `GET /shared/:id/snapshots/:seq` | participant → driver | — | `200` octet-stream |
| `POST /shared/:id/driver` | new driver → every participant | `SharedDriverNotice` | `200 {ok:true}` |
| `POST /shared/:id/membership` | leaver or driver → participants | `SharedMembershipRequest` | `200 {ok:true}` |
| `POST /shared/:id/transfer` | driver → chosen participant (last step of a hand-over) | `SharedTransferRequest` | `202 SharedTransferAccepted` |
| `GET /shared/:id` | any participant | — | `200 SharedStateResponse` |

**`POST /shared/invites`** — `SharedInviteRequest {inviteId, sharedSessionId, workspaceId, title ≤ 200, goal ≤ 50 000 (default ""), repo {url, branch, baseBranch?, baseCommit?}, epoch, targetAgentId?, model?, driver {agentId?, agentName?, uiUrl?}}`. `repo.branch` is the shared branch `clam/shared/<slug>-<6>` the driver created and pushed; `model` is the driving session's `provider/id` (display and cost parity, never required); `driver.uiUrl` is the driver's UI base URL when it has remote access on. The caller must be a member of `workspaceId` on the receiver (`403 forbidden`); `repo.url` must be a GitHub URL (`400`); an unknown `targetAgentId` is `400 unknown_agent`; a known `inviteId` from another sender is `409 idempotency_conflict`, from the same sender answers `200` with the current state. The receiver auto-accepts when the caller's `autoAcceptTasks` is on and exactly one local project is linked to the repository; otherwise `state: "pending"` until its user decides. `SharedInviteAccepted {inviteId, state: pending | accepted | declined}`.

**`POST /shared/:id/decision`** — `SharedDecisionRequest {inviteId, decision: accept | decline, agent? {agentId, agentName}, agentSessionId?, uiUrl?, reason?}`. Only the driver answers (`404` elsewhere). `accept` activates the participant; the driver then queues the group log so far, syncs the mirror and ships the latest checkpoint. A repeat is harmless.

**`POST /shared/:id/messages`** — one message of the **group chat** (the shared session's conversation: a log every member node keeps; the model is in [shared-sessions.md §4.3](./shared-sessions.md#43-the-group-chat)). Body `SharedMessageRequest`:

```ts
interface SharedMessageRequest {          // wire.SharedMessageRequest
  messageId: string;                      // natural key; the receiver stores a message once per id
  epoch: number;                          // informational: chat is never fenced by epoch
  kind: "chat" | "reply" | "system" | "instruction" | "question" | "answer" | "note";
  body: string;                           // 1..20 000
  author: { kind: "human" | "agent" | "system"; agentId?: string; agentName?: string };
  to: { mode: "all" | "lead" | "agents"; agents: { nodeId: string; agentId: string }[] };   // ≤ 64; resolved by the origin from @mentions
  origin: { nodeId: string; nodeName: string; seq: number };  // the node that accepted it; seq = per-origin sequence 1, 2, 3 …
  hlc: string;                            // hybrid logical clock /^\d{15}-\d{5}$/ — compares as a string
  createdAt: string;
}
```

The log order on every node is `(hlc, origin.nodeId, messageId)`. A **system** message has `author.kind = "system"` and nothing else does (`400`). The sender must be an **active participant** (`403 forbidden`) and may push **its own** messages only: `origin.nodeId` must be the caller (`403 forbidden`; other nodes' messages travel by `messages/sync`). A repeat of a stored message (same id, same origin and sequence) is answered `202` and ignored; the same id with another origin or sequence, or another id on an origin sequence already used, is `409 idempotency_conflict`. No role or epoch check applies: any online member accepts and fans out, and the receiver never refuses chat because of who drives. The receiver merges `hlc` into its clock and decides for its own agent (wake it when addressed, buffer otherwise). The loop guard (an agent message that wakes another agent counts; 12 per node without a human message in between) is enforced at the **author's** node (`429 agent_message_limit` on its local post), not on the wire.

**`POST /shared/:id/messages/sync`** — catch-up pull (any active participant → any active participant). Body `SharedMessagesSyncRequest {cursor: {<origin nodeId>: seq ≥ 0, …} (≤ 256 origins), limit: 1..200 (default 100)}`: per origin, the highest sequence `N` such that the caller holds `1..N`; an origin not named counts from 0. Answer `200 SharedMessagesSyncResponse {messages: SharedMessageRequest[], cursor, hasMore}`: the replicated messages **beyond the cursor**, in log order, at most `limit`, of any origin (relayed messages keep their origin and stamp); `cursor` is the request's cursor advanced past the page (per origin, the highest sequence served), `hasMore` tells the caller to ask again with it. The caller recomputes its cursor from its own log before each pull (so a gap is asked for again) and ignores relayed messages whose origin is not a member of the shared session. Notes of one node only (`system` lines about what only it observed) are never served. `400` for a malformed cursor (a key that is not a node id, a negative or fractional sequence), limit or JSON; `403 forbidden` for a caller that is not an active participant; `404` for an unknown id. It is a **read carried in a POST body**: it is naturally idempotent, so it is **not** stored in the response store (a replayed page would be stale); the signed `Idempotency-Key` header is still required like on every POST.

**`POST /shared/:id/mirror`** — `SharedMirrorRequest` is a union:
* `{type:"events", epoch, streamId, seq ≥ 1, events: SharedMirrorEvent[1..2000]}` — `SharedMirrorEvent.type` ∈ `state, agent_start, agent_end, message_start, message_delta, message_end, message_removed, tool_start, tool_update, tool_end, prompt_result, settled, notice` (extra fields passed through, validated by the receiver). Applied only when `seq` is the stored `lastSeq + 1` of the same `streamId`; a duplicate answers `{applied:false, lastSeq}`; a gap or an unknown stream answers `409 mirror_resync` (`details.lastSeq`).
* `{type:"sync", epoch, streamId, seq ≥ 0, index, final, messages: UiMessage[], state?}` — a full replay in chunks: `index` 0 resets the mirror, chunks must arrive in order (`409 mirror_resync` otherwise), the `final` chunk carries `state` (a `SessionLiveState`) and sets `lastSeq = seq`.
Answer `SharedMirrorAccepted {applied, lastSeq}`. Not stored in the response store.

**`POST /shared/:id/checkpoints`** — `SharedCheckpointNotice {seq, epoch, branch, commit?, pushed, snapshot? {sha256 (64 hex), size, messageCount}, model?, note?, at}`. Stale or unknown epoch: see above. The receiver records it (idempotent by `seq`) and downloads the snapshot when `snapshot` is present.

**`GET /shared/:id/snapshots/:seq`** — streams the checkpoint's snapshot (OMP session archive, `application/octet-stream`) with `Content-Length`, `Content-Digest: sha-256=:<base64>:` and `Content-Disposition: attachment; filename="session-snapshot.tar"`. Allowed for **active participants** only (`404` otherwise or when the file is not held). The receiver verifies size and sha-256 against the notice **while writing**, refuses anything above **100 MiB**, stores it `0600`, and then acknowledges.

**`POST /shared/:id/checkpoints/:seq/ack`** — `SharedCheckpointAck {sha256, size}`; only an active participant; `404` when the checkpoint or digest is unknown. The driver records the node as holder of that snapshot.

**`POST /shared/:id/driver`** — `SharedDriverNotice {epoch, reason: takeover | transfer, checkpointSeq?, commit?, sessionId?, uiUrl?, agentId?, agentName?, at}`; the **sender is the new driver**. The receiver applies the higher epoch: it follows the new driver with a mirror, and if it was the driver it becomes a read-only **moved** copy, rescues unpushed work to `clam/rescue/<sharedId>-<node>` and becomes a participant ([shared-sessions.md §4.8](./shared-sessions.md#48-former-driver-returns)). The sender must be an active participant (`403`); lower epoch `409 stale_epoch`.

**`POST /shared/:id/membership`** — `SharedMembershipRequest {epoch, action: leave | remove, nodeId, reason?}`. `leave`: a node announces its own departure (`nodeId` must be the sender). `remove`: only the driver, epoch checked (`409 stale_epoch`); the removed node tears its side down.

**`POST /shared/:id/transfer`** — `SharedTransferRequest {epoch, checkpointSeq, sha256, interrupted?}`; only the current driver (`403 forbidden`), `epoch` must **equal** the receiver's (`409 stale_epoch`), and the receiver must hold that snapshot (`409 no_snapshot`). It answers `202 SharedTransferAccepted {accepted:true, epoch}` and then performs the takeover from that checkpoint in the background and announces the new epoch with `POST /shared/:id/driver`. `interrupted: true` says the driver aborted a running turn for this hand-over; the continuation note of the new session then asks it to check the last steps (otherwise it states that nothing is missing, because the checkpoint was taken at the hand-over).

*Local side (not part of the wire protocol):* this call is the last step of the driver's **hand-over**, a single user action (`POST /api/local/sessions/:id/handover` or `POST /api/local/shared/:id/transfer`, body `{toNodeId, agentId?, stopRunning?}` → `202 SharedSession`; progress in `SharedSession.transfer` with the phases `inviting → waiting_accept → stopping → checkpointing → delivering → handing_over → continuing | failed | cancelled`; `DELETE …/transfer` cancels or dismisses). Before it the driver invites the node when needed, waits for its acceptance, stops or waits for the running turn, takes a final checkpoint of everything (a push or snapshot failure fails the hand-over) and waits until the target acknowledged the snapshot. Details: [shared-sessions.md §4.7](./shared-sessions.md#47-hand-over-planned-driver-online).

**`GET /shared/:id`** — `SharedStateResponse {sharedSessionId, title, workspaceId, epoch, driverNodeId, branch, driverSessionId?, driverUiUrl?, participants[] {nodeId, nodeName, role: driver | participant, state: invited | active | declined | left | removed, agentId?, agentName?, uiUrl?}, lastCheckpoint? {seq, epoch, commit?, pushed, snapshotSha256?}}`. The authoritative answer to "who drives now?": nodes call it on every peer at boot, when a peer comes online and every 30 s, and apply a higher epoch they find.

**Additive error codes (M5):** `capability_missing` (409, sender side and when the receiver lacks the grant), `not_driver`, `driver_online`, `no_snapshot`, `snapshot_invalid`, `stale_epoch`, `epoch_unknown`, `split_brain`, `mirror_resync` (409), `session_read_only`, `session_moved`, `shared_session_active` (409, local), `agent_message_limit` (429, local), `forbidden` (403) and `idempotency_conflict` (409) also on group messages (a pushed message whose origin is not the sender; a message id or per-origin sequence already used), and git-related refusals (`not_a_git_repo`, `git_operation_in_progress`, `shared_branch_failed`, `git_fetch_failed`, `git_checkout_failed`, all 409, local). The full list with meanings is in [shared-sessions.md §7](./shared-sessions.md#7-error-codes).

### 5.9 `POST /context/sync` — `context.sync`

Exchanges **references and shareable snapshots**, never private conversation history.

```ts
interface ContextSyncRequest {
  workspaceId: Id; projectId?: Id;
  have: { contextId: Id; version: number; sha256: string }[];     // sender's index
  push?: { contextId: Id; type: string; version: number; sha256: string; body: string }[];  // shareable only
}
interface ContextSyncResponse {
  want: { contextId: Id; sinceVersion: number }[];                 // what the receiver is missing
  accepted: { contextId: Id; version: number }[];
  conflicts: { contextId: Id; localVersion: number; remoteVersion: number }[];  // never auto-merged
}
```

Large or git-resident content is exchanged via Git (`.clmesh/`) and `contextRefs`; this endpoint carries indexes and small snapshots (≤ 1 MiB each).

### 5.10 `POST /handoffs` — `handoff.send` / `handoff.receive`

Source proposes a handoff. Manifest schema in [handoff-protocol.md](./handoff-protocol.md#2-manifest).

```ts
interface CreateHandoffRequest {
  handoffId: Id; taskId: Id;
  fromEpoch: number; toEpoch: number;     // toEpoch === fromEpoch + 1
  manifest: HandoffManifest;              // JSON, no secrets
  manifestSha256: string;
  expiresAt: IsoDate;
}
// 201 { handoffId: Id; state: "received" }
// 409 stale_epoch if fromEpoch != the receiver's known epoch for the task
```

### 5.11 `POST /handoffs/:id/accept` — `handoff.receive`

Target tells the source it agrees to take the work and is starting the restore steps.

```ts
interface AcceptHandoffRequest { epoch: number; targetAgentId?: Id }
// 200 { handoffId: Id; state: "accepted" | "rejected"; reason?: string }
```

### 5.12 `POST /handoffs/:id/ack` — `handoff.receive`

**Durable acknowledgement**, sent by the target only after steps 1–7 succeeded and the acknowledgement has been written to the target's database.

```ts
interface AckHandoffRequest {
  epoch: number;                          // the new epoch the target will own
  targetSessionId: Id;                    // the NEW runtime session on the target
  manifestSha256: string;
  validation: { gitCommit: string; workspaceClean: boolean; depsOk: boolean };
  ackedAt: IsoDate;
}
// 200 { handoffId: Id; state: "acked"; fencingToken: string }
```

`fencingToken` is defined in §9. The source must not release ownership before receiving a valid ack.

### 5.13 `GET /events` — SSE — `events.read`

Server-Sent Events stream of everything the receiver wants the caller to know. The stream is **`node`**, with event `type`s `agents_changed`, `health`, `peer_revoked`, `peer_updated` and, since M4, **`task.updated`**: `{taskId, seq, status}`, addressed to the one peer the task is exchanged with (audience-scoped like `peer_updated`: every other subscriber receives the frame with an empty payload so `seq` stays gap-free). It is a pure hint — the receiver polls `GET /tasks/:id?since=` — so a lost or late frame costs nothing. Per-task streams (`task:<id>`) are served to the **local UI** over `/ws` (topics `tasks`, `task:<id>`); on the wire the task's events travel in `GET /tasks/:id?since=`. Handoff streams arrive with M7. See §8 for ordering, resume and the quick-tunnel caveat.

```
GET /api/v1/events[?stream=node][&cursor=<opaque>]
Accept: text/event-stream
Last-Event-ID: <opaque cursor>          // alternative to ?cursor; sent unsigned
```

### 5.14 `POST /artifacts` — `artifacts.write`

Uploads a blob (patch, working-tree snapshot, result file).

```
POST /api/v1/artifacts
Content-Type: application/octet-stream | application/x-tar | …
X-Artifact-Name: working-tree.patch
X-Artifact-Sha256: <hex>              // required; verified server-side
X-Artifact-Task: <taskId>             // optional association
Content-Length: <≤ configured cap, default 256 MiB>
// 201 { artifactId: Id; sha256: string; size: number }
// 422 digest_mismatch if the stored bytes do not hash to X-Artifact-Sha256
```

`GET /artifacts/:id` (`artifacts.read`) returns the bytes with `Content-Digest`. Large uploads support `Content-Range` resumption. Artifacts are scanned for secret patterns before being offered cross-node ([security.md](./security.md#6-what-may-enter-git-and-handoff-artifacts)).

### 5.15 `POST /node/announce` — any paired peer (additive, M3)

A peer's address changes whenever its quick tunnel restarts. The peer tells everyone it is paired with:

```ts
{ url: string; name?: string }          // → 200 { ok: true }
```

The receiver verifies the signature (pinned key), requires `https://` (loopback `http` only with `CLAM_ALLOW_LOOPBACK_PEERS=1`), and **before ever sending a signed request to the new address** probes its unsigned `GET /node/info`: the answer must carry the peer's node id and fingerprint, else `409 fingerprint_mismatch`; an unreachable address is `502 url_unreachable` (the sender retries for several minutes, since a fresh hostname lags in DNS). Only then are `peers.url` / `peers.name` updated and the peer's event connection restarted on the new address. Idempotent by nature; the idempotency key is still required.

### 5.16 `POST /node/revoke` — any paired peer (additive, M3)

Signed, best-effort notice that the sender revoked the receiver: `{ reason?: string }` → `200 { ok: true }`. The receiver marks the sender `revoked` with `revokedBy: "remote"` and stops talking to it. Revocation never depends on this notice: the revoking node refuses the peer from the moment it decides (§10), and the peer also learns through `403 peer_revoked` on its next heartbeat or a `peer_revoked` event.

---

## 6. Correlation, request ids, idempotency

* **Request id** (`X-Request-Id`): one per HTTP attempt; echoed in the response and logged by both sides.
* **Correlation id** (`X-Correlation-Id`): one per logical operation (one delegated task, one handoff, one pairing). Preserved across retries, SSE events and OMP session notes so a whole cross-node flow can be traced from either node's logs.
* **Idempotency key** (`Idempotency-Key`, ≤ 128 chars): **required** on `POST /tasks`, `/tasks/:id/cancel`, `/tasks/:id/messages`, `/context/sync`, `/handoffs`, `/handoffs/:id/accept`, `/handoffs/:id/ack`, `/artifacts`, `/node/pair`. Receivers store `(peerId, key) → {requestHash, status, responseBody}` for **24 h** (task/handoff keys for the life of the task, since they are also the entity ids).
  * Same key + same body hash → return the stored response with `Idempotent-Replay: true` and **do not** re-execute.
  * Same key + different body → `409 idempotency_conflict`.
  * Same key while the first attempt is still in flight → `409 conflict` with `Retry-After`.
  * Natural keys (`taskId`, `handoffId`, `messageId`) make the receiver idempotent even if a sender loses its key table.
  * **Implemented as (M4):** the response store is the table `idempotency_records` `(peer_id, key) → {method, path, request_hash, status, response_body, expires_at}`, kept **24 h** (pruned every 10 minutes), used by `POST /tasks`, `/tasks/:id/cancel` and `/tasks/:id/messages`. The hash is SHA-256 over `METHOD\npath\nbody bytes` (`requestHash`). Same key + same hash replays the stored answer (status and body, header `Idempotent-Replay: true`) without executing; same key + another request is `409 idempotency_conflict`; an overlapping attempt with the same key while the first runs is `409 conflict` with `Retry-After: 1`. **Only 2xx answers are stored**, so a failed attempt (a 400, a 403, a 5xx) can be retried with the same key. The natural keys are enforced independently of the store: a known `taskId` answers 200 with the current record, a known `messageId` answers 202 without a second insert — a sender that lost its key table (or sends a new key) still cannot duplicate anything. `/node/pair`, `/node/announce` and `/node/revoke` stay idempotent by nature and do not use the store.

---

## 7. Retry policy

Senders deliver mutating requests **at least once** from a durable `outbox` table (survives restarts); receivers dedupe via idempotency. **Implemented as (M4):** one row per logical call — `task.create` (`POST /tasks`), `task.message` (`POST /tasks/:id/messages`, both directions) and `task.cancel` — holding method, path, the exact body, the idempotency key (`<kind>:<taskId|messageId>`, so enqueueing the same logical call twice is a no-op) and the correlation id; every attempt re-sends **the same body with the same key**, with a fresh nonce/request id/timestamp. The outbox worker ticks every second and also runs when a peer comes back online (`peer` status `offline → online/degraded`) or its address changes. Rules:

* Items are sent per peer, oldest first; an item is **never sent while an earlier item of the same task is still pending** (a message or cancel never overtakes the `task.create`; if the create dies, its dependents die with it). Different tasks proceed independently.
* A peer that is `offline`/`revoked` is not contacted: its items stay `pending` and **do not consume attempts** — time spent offline is not a failure. Transport failures against an `online` peer (no HTTP answer) keep the item pending with full-jitter backoff and never kill it; the heartbeat decides when the peer counts as offline.
* An HTTP answer from the peer is classified by the table below. Retryable answers use `decideAfterFailure` (max **10** attempts, then `dead`); permanent answers are `dead` at once. `401 clock_skew` is retried. `dead` is visible: a dead `task.create` fails the task on the sender (`Could not deliver the task to <peer>: <error>`), a dead `task.message` shows `delivery: failed` on the message, a dead `task.cancel` is logged and re-armed if the user cancels again.
* The delivery state of the **task itself** is visible to the UI as `Task.delivery` (`pending` / `delivered` / `failed`, attempts, last error) and of each message as `TaskMessage.delivery`.
* A lost response is reconciled by polling: when `GET /tasks/:id` shows the executor knows a task whose create is still `pending`, the create is marked `sent`.

| Condition | Action |
| --- | --- |
| Network error, timeout (connect 5 s, total 30 s; artifacts scale with size), `502/503/504`, `429` | Retry |
| `408`, `409 conflict` (in flight) | Retry after `Retry-After` |
| `401 clock_skew` | Do not retry blindly; surface "clock out of sync" (retry once after a fresh timestamp is fine) |
| `400/401 (bad_signature, key_mismatch)/403/404/409 stale_epoch/409 idempotency_conflict/422` | **Do not retry**; permanent failure recorded |
| `5xx` other | Retry up to max attempts |

Backoff: exponential with full jitter — `delay = random(0, min(cap, base × 2^attempt))`, `base = 1 s`, `cap = 60 s`, honour `Retry-After` if larger. Max 10 attempts or 15 minutes for ordinary calls; handoff `ack` retries until the handoff deadline. Every attempt uses a fresh nonce/request id/timestamp but the same idempotency key. Read calls (`GET`) retry up to 3 times with the same backoff.

A peer that fails 3 consecutive heartbeats is marked `offline` (§12); queued outbox items stay pending and drain when it returns. Circuit breaker: after repeated failures the sender backs off to the heartbeat interval instead of hammering.

---

## 8. Event ordering and `GET /events`

* **Streams.** Events are partitioned into streams: `node` (peer-level: agents, health), `task:<taskId>`, `handoff:<handoffId>`. Within one stream, every event has a gap-free, monotonically increasing integer `seq` assigned by the **owner of that entity** (the executing node for task events; the source for handoff events until ack, the target after). **On the wire the `node` stream is the only one served** (task events are fetched with `GET /tasks/:id?since=` and announced by `task.updated` frames on `node`); it is persisted in `network_events` (`stream`, `seq`, `type`, `payload`, `audience`); `seq` is allocated inside the same SQLite statement that inserts the row.
* **Task event `seq`** is allocated by the **executor** (gap-free per task, in the same transaction as the state change) and **copied unchanged** by the sender's mirror: duplicates and out-of-order batches are dropped by `seq` (`applyMirroredEvents`), a status change is applied only once the mirror is caught up with the record, so a terminal status never appears without its events.
* **Frame format**:

```
id: <cursor>
event: <type>                  // agents_changed | health | peer_revoked | peer_updated | task.updated | stream.reset  (M7: handoff.*)
data: {"stream":"node","seq":42,"eventId":"evt_node_42","at":"2026-10-31T05:52:42.212Z",
       "correlationId":"corr_node_42","type":"agents_changed","payload":{…}}
```

* **Cursor** is an opaque, url-safe token (`base64url` of `{"node":42}`) encoding `{stream → lastSeq}`; the SSE `id:` field carries it, so `Last-Event-ID` resumes exactly after the last event received. A connection without a cursor starts at "now" (history is not replayed). The receiver replays from its persisted log — retained at least 7 days / 10 000 events per stream.
* **Delivery** is at-least-once; consumers dedupe by `(stream, seq)` and process strictly in order. A gap (`seq` jumps) means a lost frame → the consumer reconnects with its cursor. If the cursor lies beyond what the receiver has (it lost data) or before what it still retains, the receiver emits one **`stream.reset`** frame (cursor = its newest seq) and continues live from there; the consumer refetches the entity state (`GET /agents`) instead of assuming continuity.
* **Audience-scoped events.** `peer_updated` (the capabilities the emitting node now grants one peer) and `peer_revoked` are addressed to a single peer (`audience`); every other subscriber receives the frame — so its `seq` stays gap-free — with an empty payload, and consumers act only when `payload.peerId` is their own node id. A revoked peer receives nothing more except its own `peer_revoked` frame, after which the server ends the stream.
* **Keepalive**: an immediate `: open` comment, then `: ping` every 15 s. Consumers treat 45 s of silence as a dead connection and reconnect with backoff (same schedule as §7).
* **Quick tunnels buffer SSE** (§1): the consumer treats the stream as live only if the response arrives within 5 s; otherwise it aborts, does not retry for 10 minutes, and relies on heartbeat polling plus the `agentsRevision` / `grantedCapabilities` fields of the signed health answer.
* **Ordering across streams is not guaranteed**; causal relations are expressed in payloads (e.g. handoff `acked` carries the new task epoch).
* Local UI events (`/ws`, `session:<id>` topics) are unrelated to this stream; they never cross nodes.

---

## 9. Fencing tokens and ownership epochs

Every task has a monotonically increasing **ownership epoch** (integer). Exactly one node owns a task per epoch. Ownership changes only through a handoff, which increments the epoch.

* The **fencing token** for epoch *n* is `"<taskId>:<n>:<sig>"` where `sig` = Ed25519 signature by the **new owner** over `taskId|n|handoffId|manifestSha256` (verifiable by any paired peer with the pinned key).
* Every mutating call about a task (`cancel`, `messages`, event emission, result submission, artifact association) carries the epoch it was issued under (`epoch` in the body; `X-Clam-Fencing-Token` header on writes that change task state). Receivers reject anything with `epoch < currentEpoch` with `409 stale_epoch` and `details.currentEpoch`.
* A node that was the owner at epoch *n* and sees epoch *n+1* (on return from being offline, or through any `/events`/`GET /tasks/:id` response) **must** stop executing the task before doing anything else (see [handoff-protocol.md §8](./handoff-protocol.md#8-duplicate-execution-prevention-when-the-source-returns)).
* **Implemented as (M5), shared sessions:** the same idea with a different owner of the epoch: a shared session has one `epoch` (1 at creation), the *driver* is the node that works, and the epoch rises when a participant takes over or the driver transfers the role. Driver-only calls carry it (`409 stale_epoch` / `epoch_unknown`, §5.9a); a returning former driver learns the higher epoch from the new driver's notice or from `GET /shared/:id` and becomes a read-only participant. No signed fencing tokens: the epoch is checked against the pinned, signed sender.
* **Implemented as (M4):** every task row carries `epoch` (always 0 until M7). `cancel` and `messages` carry it in the body and are checked with `checkEpoch`: lower → `409 stale_epoch` with `details.currentEpoch`, higher → `409 conflict`; the sender's mirror ignores a record with a lower epoch and adopts a higher one. Fencing tokens, `X-Clam-Fencing-Token` and `task_assignments`/`handoffs` arrive with M7. State changes use compare-and-set (`TaskStore.transition` with an expected-status guard inside one SQLite transaction).

---

## 10. Permission model

* **Capabilities** (strings, §4) are granted per peer per workspace at pairing and editable afterwards; they are checked on every request in step 7 of verification. **Implemented as:** each peer row holds two lists — `granted_capabilities` (what this node lets the peer do; enforced) and `received_capabilities` (what the peer lets this node do; informational, learned at pairing and kept current through `peer_updated` events and the `grantedCapabilities` field of the signed health answer) — and `workspace_members.permissions` mirrors the grant per shared workspace. Capability changes by the user (`PATCH /api/local/network/peers/:id`) take effect on the next request. Default grant for a new peer: `agents.read`, `tasks.send`, `tasks.receive`, `events.read`. `handoff.*`, `artifacts.*`, `context.sync` and `tasks.cancel` require explicit grant.
* **Task capabilities (M4), precisely.** Capabilities are checked on the **receiving** node against what it granted the caller (`granted_capabilities`); what we hold from the peer (`received_capabilities`) decides what our UI offers.

  | Call | Receiver checks |
  | --- | --- |
  | `POST /tasks` (sender → executor) | caller holds `tasks.send` |
  | `POST /tasks/:id/messages`, receiver is the **executor** | caller (the task's sender) holds `tasks.send` |
  | `POST /tasks/:id/messages`, receiver is the **sender** | caller (the task's executor) holds `tasks.receive` |
  | `POST /tasks/:id/cancel` | caller holds `tasks.cancel` and is the task's sender |
  | `GET /tasks/:id` | caller is paired and is the task's sender or executor |
  | `GET /tasks/:id/artifacts/:artifactId` | caller is the task's sender (no capability) |

  Before queueing, the sender's own node also requires the matching capability in `received_capabilities` (`tasks.send` to delegate or message, `tasks.receive` to message back, `tasks.cancel` to cancel a delivered task): `409 capability_missing` with `details.missing`. Granting `tasks.send` never obliges execution: the executor's `autoAcceptTasks` policy (a flag per peer, editable in the peer's settings, default off) decides whether a human must accept first.
* **Workspace scoping:** `workspaceId` in a request must be one both nodes are members of; the receiver enforces membership from its own `workspace_members` table.
* **Shared sessions (M5).** One capability, `sessions.share`, checked on the receiving node for every `/shared*` endpoint (§5.9a). It is **not** in the default pairing grant: each user enables it per peer, and shared sessions need it granted in **both** directions (what the peer grants us decides what our UI offers; what we grant decides what the peer may reach: mirror, thread, snapshots).
* **Roles** are named bundles of capabilities (`owner`, `admin`, `member`, `observer`); roles are a UI convenience — enforcement uses capabilities only. Orchestration never hard-codes role names.
* **Receiver autonomy:** a node may always reject a task (`rejected`, reason) or require human acceptance (`offered`). Granting `tasks.send` never obliges execution.
* **Tool approval is local policy.** A delegated task runs under the receiving node's `approvalMode` (the sender's `constraints.approvalMode` can only request something **equal or stricter**, never looser — `strictestApprovalMode`); the executing session gets it as a per-session override at spawn.
* **Revocation:** revoking a peer sets `peers.status = revoked`, empties `granted_capabilities`, marks its `workspace_members` rows `revoked_at` and removes capabilities immediately — in one transaction, before the call returns; `verifyRequest` then answers that peer `403 peer_revoked` on every endpoint, its open event streams are ended after delivering its own `peer_revoked` frame, and the monitor stops contacting it. The row is kept (history, `revokedBy: "local" | "remote"`). A best-effort signed `POST /node/revoke` tells the peer, which records `revokedBy: "remote"`; if that notice is lost the peer learns from the `403 peer_revoked` of its next heartbeat. Re-pairing a revoked peer is an ordinary new invitation: the inviter drops the stale row when its user approves, and the new pairing creates a fresh active one; in-flight tasks the peer owns (epoch) are marked `blocked (peer revoked)` for user decision rather than silently killed or silently continued.

---

## 11. Pairing handshake

Goal: two nodes mutually authenticate and exchange public keys using a short-lived **invitation code**, resistant to a passive observer and to a malicious tunnel operator, with user confirmation.

```mermaid
sequenceDiagram
  autonumber
  participant UA as User on A (inviter)
  participant A as Node A
  participant B as Node B
  participant UB as User on B (joiner)

  UA->>A: Create invitation (workspace, capabilities, TTL ≤ 10 min)
  A->>A: code = 8 Crockford-base32 symbols (exactly 40 bits), store code_hash + expiry, max_attempts=5; code key kept in the secret store
  A-->>UA: show code + A's URL + A's fingerprint
  UA-->>UB: share code and URL out of band
  UB->>B: enter code + A's URL
  B->>A: GET /node/info  (learn A's publicKey, fingerprint)
  B->>B: confirm fingerprint shown to UB matches the one shown to UA
  B->>A: POST /node/pair {step:"hello", invitationId, node:B, nonceB, proof=HMAC(codeKey, "hello"|A.id|B.id|B.pub|nonceB)}
  A->>A: verify proof with code-derived key, attempts++ (lockout at max)
  A-->>B: {step:"hello", node:A, nonceA, proof=HMAC(codeKey, "reply"|…|nonceA), status:"pending_user_approval"}
  B->>B: verify A's proof (mutual possession of the code)
  A-->>UA: "Node B (fingerprint …) wants to join — approve?"
  UA->>A: approve + choose capabilities
  A->>B: POST /node/pair {step:"confirm", capabilities, signature = Ed25519_A(transcriptHash)}
  B->>B: verify A's signature, pin A's key, create the shared workspace, store peer
  B-->>A: 200 {step:"confirm", signature = Ed25519_B(transcriptHash), grantedCapabilities}
  A->>A: verify B's signature, pin B's key, store peer + capabilities, consume invitation
  Note over A,B: From now on every request is signed (section 3)
```

Details:

* `codeKey = HKDF-SHA256(code, salt = invitationId, info = "clam-pair-v1")`. The code itself is never sent; the `proof` shows possession without revealing it. Offline brute force by a network observer requires guessing the code against an HMAC transcript: the code space (≥ 2⁴⁰) combined with a 10-minute TTL and 5 server-side attempts makes online guessing infeasible, and a captured transcript only enables offline guessing within the TTL — mitigated by also showing and **comparing fingerprints** (the user-verified step). A future version may upgrade to a PAKE (SPAKE2/OPAQUE-style) to remove offline guessing entirely.
* `transcriptHash = SHA-256(A.id | A.pub | B.id | B.pub | nonceA | nonceB | invitationId | capabilitiesGranted)`; both signatures bind exactly these values, so neither side can be tricked into pairing with a substituted key.
* **Single use**: the invitation is consumed on first successful confirm; expired, consumed, revoked or locked invitations return `404 not_found` (no distinction, to avoid oracle behaviour).
* **Revoke**: either side can revoke at any time; the other learns at the next request (`403 peer_revoked`), via `POST /node/revoke` or a `peer_revoked` event (§10).

Implementation details (M3):

* **Code and ids.** The code is displayed `XXXX-XXXX` (Crockford base32, no `I L O U`; entry is case-insensitive, ignores separators and folds `O→0`, `I/L→1`). The joiner knows only URL and code, so `invitationId = "inv_" + 24 hex of SHA-256("clam-invitation-id-v1\0" + code)` — both sides derive it. Only `code_hash = SHA-256("clam-invitation-code-v1\0" + invitationId + "\0" + code)` is stored. Verifying the joiner's proof needs `codeKey`, so the inviter keeps the HKDF-derived key (not the code) in the secret store under `pairing.codekey.<invitationId>` and **deletes it** as soon as the hello is accepted, or the invitation is locked, revoked, consumed or expired. The code never appears in SQLite, logs or events.
* **Proofs.** `proof = HMAC-SHA256(codeKey, frame("clam-pair-proof-v1", role, …parts))`, base64url, length-prefixed framing. Hello parts bind the invitation, both node ids, the joiner's key and nonce; the reply additionally binds the inviter's key and nonce. Transcript signatures are Ed25519 over `"CLAM-PAIR-SIG-V1\0" ‖ transcriptHash`, so they are not valid plain node-key signatures; a rejection signs the transcript with capabilities `["rejected"]` (never a real grant).
* **Attempts.** Every hello is counted *before* it is checked (a crash cannot hand out a free guess); after 5 the invitation is `locked` and even the right code answers `404`. Lockout is per invitation; additionally `/node/pair` has a per-source token bucket (burst 10, one per 2 s). TTL 1–10 minutes (default 10). A retried identical hello (same joiner, same nonce) is answered with the stored reply and does not count.
* **Joiner.** `preview` fetches `GET /node/info` and shows the fingerprint; `join` compares the **full** SHA-256 fingerprint with what the user verified (separators and case ignored) and sends nothing on a mismatch (`409 fingerprint_mismatch`); it refuses to pair when it has no public URL (`409 no_public_url`: start the tunnel first); it verifies that the inviter's reply proof is valid and that the replying node is the one whose fingerprint was checked. The inviter's address is the URL the user typed (normalized to its origin).
* **Inviter approval.** The joiner's request waits for the inviter's user (`awaiting_approval`, visible until the invitation's expiry) who chooses the capabilities to grant. Approve sends the signed confirm; the joiner's counter-signature (in the response) is verified before anything is pinned. An unreachable joiner leaves the pairing `confirming` and the confirm is re-sent every 10 s until the invitation's expiry plus 10 minutes. Reject sends a signed `status: "rejected"` confirm (best effort); the joiner also expires its wait at the invitation's expiry.
* **Persistence and restart.** `pairing_invitations`, `pairing_requests` (inviter) and `pairing_joins` (joiner) hold nonces, remote identity and the stored hello reply — never the code. Awaiting and `confirming` pairings resume after a restart of either side. A joiner whose hello was sent but not answered cannot be resumed (the code is gone by design) and is marked `failed`: join again.
* **Workspace.** The invitation names a workspace of the inviter. On success the joiner creates a local workspace with the **same id and name** (if the name is already taken locally it becomes `"<name> (<inviter name>)"`; `workspaces.owner_id` points at the joiner's own node row because of the foreign key, while `workspace_members` lists the inviter as `owner`), and both sides record the other node in `workspace_members` (`role` `owner` for the inviter on the joiner, `member` for the joiner on the inviter, `permissions` = the grant).
* **Grants.** The inviter grants what its user approved; the joiner grants the defaults (`agents.read`, `tasks.send`, `tasks.receive`, `events.read`) and tells the inviter in its confirm response. Both are editable afterwards.
* Pairing works with the control plane absent: the code and URL are exchanged by the user. When a control plane exists (later), it may broker the invitation and URL discovery but is **never** trusted with keys — nodes verify fingerprints themselves.

---

## 12. Heartbeat

* Each node calls the signed `GET /node/health` on every non-revoked peer every **30 s** (jittered ±20 %), starting immediately when a peer is paired or the server boots. **This poll is authoritative.** While a peer is online the node additionally tries to hold an SSE connection to its `/events` (see the quick-tunnel caveat in §1 and §8); the stream only accelerates `agents_changed`, `peer_updated` and `peer_revoked`.
* Status per peer: `online` (last success; health `ok`), `degraded` (health `degraded`/`down`, or at least one missed beat), `offline` (3 consecutive misses ≈ 90–120 s), `revoked` (`403 peer_revoked` → `revokedBy: "remote"`). `401 unknown_peer` / `key_mismatch` (the peer no longer recognises us, or presents another key) are shown as `offline` with the reason — except within the first minute after pairing, when the other side may not have pinned us yet and the beat is retried after 1 s. The heartbeat uses its own client with an 8 s timeout and no retries.
* Heartbeats update `peers.last_seen_at`, `latency_ms` and `last_error`. Marking a peer `offline` never deletes anything: its cached agents stay (shown offline) and cancels no task it owns. The UI shows the error ("HTTP 530" while a quick tunnel is gone, clock skew, …).
* `peer_agents` are refreshed when the peer first becomes online, when an `agents_changed` event arrives, when the health answer's `agentsRevision` changes, when the health answer's `grantedCapabilities` changes, and at least every 5 minutes. A peer that does not grant us `agents.read` shows no agents.
* The node's own address changes when a quick tunnel restarts: it then sends a signed `POST /node/announce` to every peer (after the new hostname resolves, retrying for minutes) so peers keep it online on the new URL (§5.15).
* On reconnect the node resumes `/events` from `peers.last_event_cursor` and **reconciles every task it was waiting on via `GET /tasks/:id?since=`** (M4): the mirror polls each active outgoing task every ~5 s while the peer is online and once immediately when it returns; the outbox drains at the same moment. While the sender is down the executor keeps running and shows the task locally; on return the sender applies status, result and events from the executor's record and never executes anything itself.

---

## 13. Versioning

* The protocol version is an integer in the path-independent header `X-Clam-Version` and in `GET /node/info` → `protocolVersions`. URL prefix `/api/v1` is the major version of the **resource model**; breaking changes create `/api/v2` served side by side.
* Within a version, changes are **additive only**: new optional fields, new event types, new capabilities, new error codes. Receivers ignore unknown fields and unknown event types (log and skip, preserving seq).
* Negotiation: sender picks the highest version in `protocolVersions` of the receiver that it also supports. No common version → `426 unsupported_version` with the receiver's list.
* The canonical-string prefix (`CLAM-SIG-V1`) is versioned independently so a signature scheme change does not require a new resource model.
* Deprecations are announced in `GET /node/info` (`deprecations[]`) at least one minor release before removal (none exist yet, so the field is absent).
* M3's additive surface: `POST /node/announce`, `POST /node/revoke`, error codes `unknown_peer` / `peer_revoked` / `digest_mismatch` / `fingerprint_mismatch` / `url_unreachable`, `agents[].activeSessions`, `agentsRevision` and `grantedCapabilities` in the authenticated health answer, `stream.reset`, and `status`/`reason` on the pairing confirm.
* M4's additive surface: `POST /tasks`, `GET /tasks/:id[?since=]`, `POST /tasks/:id/cancel`, `POST /tasks/:id/messages`, `GET /tasks/:id/artifacts/:artifactId`; the `task.updated` node event; the task wire schemas (`wire.CreateTaskRequest`, `TaskRecord`, `GetTaskResponse`, `CancelTaskRequest`, `TaskMessageRequest`, `TaskMessageAccepted`); message kind `question`; `deliverAs` and `sender` on the create request; `result.artifacts[].size`; error codes `capability_missing` (409, sender-side), `stale_epoch` and `idempotency_conflict` now emitted, `agent_message_limit` (429, local tool result), `artifact_contains_secrets` (422), `artifact_too_large` (413).
* M5's additive surface: the capability `sessions.share`; `POST /shared/invites`, `POST /shared/:id/decision|messages|messages/sync|mirror|checkpoints|driver|membership|transfer`, `POST /shared/:id/checkpoints/:seq/ack`, `GET /shared/:id`, `GET /shared/:id/snapshots/:seq` (§5.9a); the `wire.Shared*` schemas; error codes `not_driver`, `driver_online`, `no_snapshot`, `snapshot_invalid`, `epoch_unknown`, `split_brain`, `mirror_resync`, `session_read_only`, `session_moved`, `shared_session_active`, git refusals; `capability_missing` and `stale_epoch` also on shared calls.
