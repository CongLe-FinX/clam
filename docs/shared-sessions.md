# CL Agent Mesh — Shared sessions, manual takeover and the moved copy (M5)

Status: **implemented** (roadmap [M5](./roadmap.md#m5--remote-access--shared-sessions--takeover-p0--implemented-checklist-5d)). This document is the as-built reference; the wire schemas live in `packages/agent-network/src/wire.ts`, the local API contracts in `packages/contracts/src/shared.ts` and `routes.ts`, the code in `apps/server/src/shared/`. The endpoints are specified for implementers of other nodes in [agent-network-protocol.md §5.9a](./agent-network-protocol.md#59a-shared-sessions--sessionsshare); how a node's web UI is reached through its own domain is [security.md §5b](./security.md#5b-remote-ui-access-the-owner-logs-in-through-the-nodes-own-domain).

## 1. Purpose and the use case

Two nodes **A** and **B** are two machines. Each has its **own workspace copy, its own domain (tunnel) and its own web UI**, and they are paired ([README: pair two machines](../README.md#pair-two-machines)).

1. The user creates a working session in a project on A. A's agent works there as usual.
2. The user **shares** the session and adds B's agent. B's user (or B's auto-accept policy) accepts; B gets a read-only **live mirror** of A's session and its own agent session, briefed for the work. From then on the session is a **group chat** (§4.3): the owner (a human, at either node's UI) and one agent per node talk in one timeline that **every node keeps a copy of**; the group works as long as **one** of the nodes is online.
3. While A works, it takes **checkpoints**: the work is committed and pushed to a **shared git branch** and the OMP session is packed into a **snapshot** that is shipped to B.
4. **A goes offline.** The user opens B's UI — on B's own domain if remote access is enabled — and presses **Continue on this node** (**manual takeover**). B checks out the shared branch, unpacks the last snapshot into a **new local session**, becomes the driver (epoch + 1) and its agent carries on from a continuation note. A stays a participant.
5. The user **watches B continue on B's domain**. When A comes back it learns it is no longer the driver: its session becomes a read-only **moved** copy pointing at B, unpushed work in its clone is saved on a **rescue branch**, and A follows B through a mirror.

Takeover is **manual only**. A planned **hand-over** while A is online is one user action (§4.7): CLAM invites B if needed, waits for it, saves everything with a final checkpoint, and B takes over. Nothing in a takeover or hand-over is automatic and nothing is ever discarded.

## 2. Model

* A **shared session** is one piece of work with a shared id `shs_<ULID>`. Every participating node keeps its own row (`shared_sessions`) with the same id; there is no central copy.
* **Driver**: the one node whose local OMP session does the work. All others are **participants**. The driver is the only node that writes the shared branch, serves snapshots and streams the mirror. In the group chat (§4.3) its agent is the **lead**: the agent a human message without a mention is addressed to.
* **Group chat**: the shared session's conversation is a log every member node keeps a copy of, ordered by a hybrid logical clock, with no host and no fencing (§4.3).
* **Epoch**: an integer fencing token, 1 at creation, +1 at every driver change. Every driver-only wire call carries it; a receiver at a higher epoch answers `409 stale_epoch`, a receiver at a lower epoch answers `409 epoch_unknown` and reconciles (asks the sender who drives, `GET /shared/:id`). Two nodes claiming the same epoch is logged as split brain and refused (`409 split_brain`).
* **Local role** of a node for a session (`shared_sessions.local_role`): `driver`, `participant`, or `former_driver` (transient: it lost the role and is finishing the rescue/moved/mirror steps, §4.8).
* **Sessions per node** (`agent_sessions.kind` = `local` | `mirror`):

| On | Session | Kind | Writable |
| --- | --- | --- | --- |
| driver | the driving session (`local_session_id`) | `local` | yes |
| participant | **mirror** of the driver's conversation (`mirror_session_id`) | `mirror` | no — `409 session_read_only` |
| participant | **participant agent session** (`shared_participants.agent_session_id`), briefed, addressed through the group chat | `local` | yes (the agent works in the participant's own clone) |
| former driver | the moved copy (`agent_sessions.moved_to` set) | `local` | no — `409 session_moved` |

* Sharing needs the capability **`sessions.share` granted in both directions** (each node grants it to the other, §5); otherwise `409 capability_missing` before anything is sent.
* The shared session lives on a branch `clam/shared/<slug>-<6 chars of the session id>` of the project's GitHub repository. The invited node maps the repository to one of its local projects; each node therefore needs its own clone ([README: git and GitHub projects](../README.md#git-and-github-projects)).

## 3. Local API (UI side)

All under `/api/local`, validated by the contracts' Zod schemas; never exposed through the tunnel except to a signed-in owner when remote access is on.

| Route | Purpose |
| --- | --- |
| `GET /shared`, `GET /shared/:id` | list / detail (participants, checkpoints, the group log in log order, role, epoch, remaining wake budget) |
| `POST /sessions/:sessionId/participants` `{nodeId, agentId?}` | share the session (first use creates the shared branch) and invite the node; 201 `SharedSession` |
| `DELETE /shared/:id/participants/:nodeId` | driver removes a participant |
| `POST /shared/:id/messages` `{text, kind?, to?}` | anyone at this node's UI talks in the group chat (`kind` `chat` default, `instruction`, `answer`, `note`); `to` overrides the @mentions found in `text`; works on **any** member node, whether or not the lead's node is online; resets the loop budget; 201 `SharedMessage` |
| `POST /shared/:id/read` | mark the group chat read |
| `POST /shared/:id/checkpoint` `{note?}` | manual checkpoint (driver only) |
| `POST /shared/:id/takeover` `{force?}` | participant continues the work here |
| `POST /sessions/:sessionId/handover` `{toNodeId, agentId?, stopRunning?}` | hand the session over to a node (shares it first if needed, invites, then hands over); 202 `SharedSession` |
| `POST /shared/:id/transfer` `{toNodeId, agentId?, stopRunning?}` | driver hands the role over (§4.7); 202 `SharedSession`, progress in `SharedSession.transfer` |
| `DELETE /shared/:id/transfer` | cancel a running hand-over (not once B was asked) or dismiss a finished one |
| `POST /shared/:id/leave` | participant leaves |
| `GET /shared/invites`, `POST /shared/invites/:id/decide` | invitations received (accept with optional `projectId`/`agentId`, or decline) |

WebSocket topics `shared` (list) and `shared:<id>` (detail) carry `shared`, `checkpoint`, `message` and `invite` events (`SharedTopicEvent`); a mirror session is read like any session through `session:<id>`.

## 4. Flows

### 4.1 Share, invite, accept

```mermaid
sequenceDiagram
  participant UA as User on A
  participant A as Node A (driver)
  participant B as Node B
  participant UB as User on B
  UA->>A: POST /sessions/:id/participants {nodeId: B, agentId?}
  A->>A: checks: session runs here, B paired + sessions.share both ways, project has a GitHub repo, B in the workspace
  A->>A: first share: create+checkout clam/shared/<slug>-<id> from HEAD, push -u (refusal = 409 shared_branch_failed)
  A-->>B: outbox shared.invite  POST /shared/invites (signed, idempotent by inviteId)
  alt peer autoAcceptTasks and exactly one local project matches the repository
    B->>B: accept now (201 "accepted")
  else
    B-->>A: 202 "pending"; the invitation waits in B's UI
    UB->>B: POST /shared/invites/:id/decide {accept, projectId?, agentId?}
  end
  B->>B: accept: shared row (role participant), MIRROR session, participant agent session (agent: the invited one, else the oldest OMP agent), brief the agent
  B-->>A: outbox shared.decision  POST /shared/:id/decision
  A->>A: participant active; the group log so far queued for B (B also pulls what it lacks); mirror sync; first checkpoint (or the latest one re-announced)
```

* **Checks on A** (`409` unless noted): `session_read_only` (a mirror or moved session cannot be shared), `not_driver` (the session already belongs to a shared session that this node does not drive), `no_repository` (the project is not linked to a GitHub repository), `not_in_workspace` (the peer is not a member of the project's workspace), `already_participant`, `capability_missing`, `not_a_git_repo`, `git_operation_in_progress`, `shared_branch_failed`; `404` for an unknown peer or agent.
* **Auto-accept rule** (B, `SharingService.receiveInvite`): the invitation is accepted at once only when the sender peer's `autoAcceptTasks` flag is on **and exactly one** local project is linked to the repository (case-insensitive `owner/name`). Otherwise it stays `pending` (answer `202`) and B's user chooses. A failing auto-accept leaves the invitation pending. Accepting by hand needs one matching project or an explicit `projectId` (`409 project_required` / `project_mismatch`).
* **Receiver checks**: the sender must be paired and a member of the invitation's workspace on B (`403 forbidden`), the repository URL must be a GitHub URL (`400`), a requested `targetAgentId` must exist (`400 unknown_agent`).
* An invitation that can never be delivered (the outbox gives up) turns the participant into `declined` on A and posts a system message to the group.
* The invitation carries the driving session's model (`provider/id`, optional); the participant agent session starts with it when the accepting node has that model (display and cost parity, never required).
* The participant agent is briefed once with the title, goal, driver (the lead), other participants, repository/branch and the loop-guard limit; it is told how the group chat works (its final text is posted automatically; `@mention` to wake somebody) and to use `mesh_team` and `mesh_say`. The turn that answers the briefing is **not** posted to the group.

### 4.2 Mirror (live read-only copy)

* The driver rebuilds the transcript of its session from its runtime events (`TranscriptReducer`) and sends batches at most every 500 ms to each reachable participant: `POST /shared/:id/mirror` `{type:"events", streamId, seq, events[]}`. Forwarded events: `state`, `agent_start`, `agent_end`, `message_start|delta|end|removed`, `tool_start|update|end`, `prompt_result`, `settled`, `notice`. Approvals and questions that need the driver's human are **not** mirrored. Consecutive deltas of one block are coalesced.
* **Idempotent by `(streamId, seq)`**: the participant applies a batch only when `seq` is `lastSeq + 1` of the same stream; a duplicate answers `{applied:false,lastSeq}`; a gap or an unknown stream answers `409 mirror_resync`. The driver then replays the whole transcript as `{type:"sync", index, final, messages[], state?}` chunks (≤ 512 KiB each; chunk `index` 0 resets the mirror, the `final` chunk sets `lastSeq`), and goes back to batches.
* The participant stores the transcript per mirror session (`shared_mirror_messages`, `shared_mirror_state`), so the mirror survives a driver that is offline and a restart of the participant. It republishes the events on the mirror's `session:<id>` topic; `SessionViews` (`shared/views` + `mirror.ts`) answer `messages`, `state` and `status` for mirror and moved sessions instead of a runtime. A new participant, a participant that comes online (or whose URL changed) and a failed batch trigger a sync.
* A mirror (or moved copy) refuses prompts, runtime start and conversation-file access: `409 session_read_only` / `409 session_moved`.

### 4.3 The group chat

A shared session **is a group chat**. Members: the owner (a human, typing at **any** member node's UI) and **one agent per member node**. The group timeline is the primary conversation; each agent's own OMP session is its **private workspace** (tool calls, files), viewable through its live view (local session on its node, mirror elsewhere). There is **no host of the chat**: the group works as long as **one** member node is online. Epoch fencing (§2) applies only to the **lead** (driver) role — who edits the shared branch — never to chat.

**The log.** Every member node keeps the whole group log (`shared_messages`, append-only). A message is *accepted* by exactly one node, its **origin** (a human at its UI, its agent through `mesh_say`, the automatic reply of its agent, a system note), which gives it:

* an **id** `shm_<ULID>` (global natural key: storing is idempotent by id);
* a **hybrid logical clock** stamp `hlc` = `<15 digits of ms>-<5 digits of counter>` (a string that compares like the clock). One clock per node over all its sessions: a new stamp is `max(wall clock, newest stamp seen) ` with the counter bumped on a tie; a received stamp is merged in (`mergeHlc`). Because the newest stamp is rebuilt from the log (`max(hlc)`), it is **monotonic across restarts and wall clocks that stepped back**;
* the next **per-origin sequence number** `origin_seq` (1, 2, 3 … assigned in the same transaction as the insert, so an origin's sequence has no gaps; unique per `(session, origin)`). It is the unit of catch-up.

**Order** on every node, in every list, detail and page: `(hlc, origin node id, message id)`. Two nodes that hold the same messages show them in the same order, whatever the arrival order.

**Fan-out.** The accepting node queues the message through the outbox (`shared.message`, ordering key `<shared>:<peer>`) for every **other active member**, **not through the driver**; the receiver stores it idempotently by id (`POST /shared/:id/messages`, `202`; only its origin may push it, `403` otherwise) and merges its stamp into the clock. `delivery` shows per message (`local` = received or a note of this node only, `pending`, `delivered`, `failed` as soon as one copy is undeliverable). An offline peer's copies wait in the outbox without consuming attempts.

**Catch-up (pull).** A node that was away — or whose copy died in the outbox — pulls what it lacks from **any reachable peer**: `POST /shared/:id/messages/sync {cursor, limit}`. The **cursor** is derived from the log itself (no extra state that could disagree with it): per origin node, the highest sequence `N` such that the node holds `1..N` (`SharedStore.cursor`); a gap stops the count, so a missing message is asked for again. The answer is one page of replicated messages beyond the cursor in log order (`limit` ≤ 200, default 100) with the cursor advanced past the page and `hasMore`; the puller loops while `hasMore` (at most 50 pages). Messages may be **relayed**: they carry their origin (id, name, sequence) and stamp, so the answer of any member is as good as the origin's (a relayed message from an origin that is not a member of the session is ignored). The pull runs at boot, on every peer `online`/`url_changed` transition and every 30 s (`reconcileMs`); it needs no driver. Local-only notes (`origin_seq` NULL) are never served.

**Addressing.** A message carries `to`: `all`, `lead` (the agent that drives **at the time the receiving node looks**) or explicit agents (`{nodeId, agentId}`, one agent per node, matched by node). The origin resolves it from the text — or takes the `to` the UI sent, which wins —:

* `@AgentName`, `@NodeName` (that node's agent) and `@all`, case-insensitive; names with spaces are written `@omp agent`, `@omp-agent`, `@omp_agent` or `@ompagent`; the longest name wins; an ambiguous agent name addresses **all** agents with that name; an `@` glued to a word (an e-mail address) and an unknown name stay plain text (`parseMentions`, `packages/task-engine/src/group.ts`);
* a **human** message without a mention (and without an explicit `to`) is `lead` (`mode: "lead"`). **While the lead cannot take it** — its node is `offline` as seen from the posting node (`degraded` still counts as reachable until the monitor flips it), or the lead is the posting node itself and its agent session is gone or crashed — the posting node rewrites `to` before storing it: `{mode: "agents", agents: [the agent of the node the message was written on]}`, else the first reachable member agent by node name (`pickFallbackAgent`; the lead's own node is never chosen). The effective `to` is what is stored and replicated, so every replica shows the same routing, and a replicated `system` line says `node-a (lead) is offline — sent to <agent>@<node>` (or `… cannot run its agent right now …`; with nobody to wake: `… and no other agent is reachable — the message waits in the group`). An explicit `to: {mode: "lead"}` is a deliberate choice and is kept (it waits for the lead). **The fallback agent is not made lead:** the participant brief says it may answer, plan and review but must not edit, commit or push the shared branch, the message it is woken with repeats that while the lead is offline, and nothing on the participant node can write the shared branch (checkpoints, the automatic checkpoint and the snapshot are lead-only, `409 not_driver`), so its edits stay in its own clone; code work continues only after a takeover or hand-over;
* an **agent** message without a mention is `{mode: "agents", agents: []}`: everyone sees it, **nobody is woken**, it lands in the others' buffers; an agent never mentions itself.

**What each node does for its own agent** (the driving session on the lead node, the participant agent session elsewhere; never a mirror):

| The message … | for this node's agent |
| --- | --- |
| is addressed to it (`all`; `lead` and this node leads; it is named) | **wakes it**: injected as a prompt `[CL Agent Mesh] shared session <id> · "<title>" · from <author> · kind <kind>` (`injectIntoSession`: plain prompt when idle, queued follow-up when busy, steer for an instruction; per-session FIFO, idempotent by `shared_msg_<id>`, retried) |
| is not addressed to it | **buffered**: nothing is sent now |
| was written by this node's own agent | never injected into its own session |
| is a `system` message | never injected and never buffered |
| was said **before this node joined** (`createdAt` < the node's `joinedAt`), or reached this node before the local agent session existed (a new lead session after a takeover) | **history**: marked `history`, not delivered |

**The buffer.** When an addressed message wakes the agent, **everything older that the agent was not handed yet** goes in front of it in the same prompt, under `Since your last turn in the group:` (one line per message `- <author> (<kind>): <text>`), then `Addressed to you now:` and the message. The block is capped at **8000 characters** (each message at 2000): the newest messages are kept, the oldest are dropped with a line `(N earlier messages omitted)`. Messages that arrive together (a catch-up) wake the agent **once**, with the last addressed one as the prompt and the rest as the block; messages newer than the one that wakes it wait for the next. "Handed over" is persisted per message (`injected_session_id`), so a restart neither loses nor repeats a message. **On a takeover** the new lead session starts with an empty buffer: what was buffered for the former session is history (the log keeps it; the continuation note already carries the context). A former driver's new participant session likewise starts empty.

**Replies.** The **final assistant text of every turn** of a member agent session — the lead's driving session and each participant agent session, whoever started the turn (a group message, or a person typing in that session) — is posted to the group **automatically** as that agent's message (`kind: "reply"`, author = the agent, origin = the node it runs on), found from the runtime events (`prompt_result` + the last assistant `message_end`, posted on `settled`). Not posted: an empty final text, an aborted turn, a turn that answered only the **briefing**, a **continuation** note or the **driver-change** note (recognised by their prompt client ids `shared_brief_…`, `shared_continue_…`, `shared_driver_…`). A reply longer than the wire's 20 000 characters is cut and says so. `mesh_say` stays for a message in the **middle** of a turn or a question; it is parsed for mentions the same way. A reply wakes another agent **only if it mentions it**.

**Loop guard.** An agent message that can wake another agent (`all`, or at least one named agent) counts against the **wake budget** of its node: at most **12** (`agent_message_limit`, stored per shared session) since the latest **human** message of the log (in log order, from any node). Quiet agent messages cost nothing. Over the budget `mesh_say` fails with `429 agent_message_limit`; an automatic reply cannot be refused, so it is posted **without** waking anybody and a system line says so. A human message (from any node) resets every node's budget.

**System messages** (`kind: "system"`, authored by the system, replicated like any message, never injected or buffered into an agent): the shared session was created; a node **joined**, **declined**, **left** (posted by the leaver itself, once) or was **removed**; a **hand-over** started, was cancelled or failed; a node **took over** as driver; a **checkpoint** was taken (one line per checkpoint that was manual or moved the shared branch; automatic ones that found nothing new are silent); the rescue branch; an undeliverable invitation. A few lines describe what only this node observed (it was removed from the session) and stay in this node's copy only (`delivery: local`, no sequence number).

**How the UI composes the whole conversation.** The conversation of the lead's session **before the session became a group** is *not* copied into the log: it stays in the session transcript (the driving session on the lead node, its mirror on the others, `GET /sessions/:id/messages`). The group log starts with the system line "Shared session created …" — the **first log entry** (smallest `hlc`; its `createdAt` is the moment the session was shared). A client shows **the session transcript up to that moment** (UI messages whose `timestamp` is before it), then the **group log in log order**. The agents' working turns after that point are in the private sessions (open through the participant's `agentSessionId` or the mirror); the group shows only what they said.

**Host tools**, registered in every runtime: `mesh_team` (epoch, branch, lead, participants with node status and how to mention them, last checkpoint, last six group messages, remaining wake budget) and `mesh_say` (`text`, `kind` = question/answer/note/instruction; only the lead may instruct; after a `question` that woke somebody the agent ends its turn and the answer arrives as a prompt). Their results never contain a literal mention, so an agent that quotes them does not wake anybody by accident. Outside an active shared session — or in a mirror/moved session — both answer an error result, never an exception.

**Trust.** Members are workspace members of one owner's mesh. A pushed message must come from its origin; a relayed message (pull) is accepted if its origin is a member, so a member could forge another member's words towards a third — the same trust the mirror and snapshots already assume.

### 4.4 Checkpoint

A checkpoint (`seq` = last + 1, per shared session) is taken **by the driver**, automatically after a settled turn (only if at least one participant is active; at most one per 30 s, `checkpointDebounceMs`) and on demand (`POST /shared/:id/checkpoint`, also done first by a transfer and when a participant joins and none exists). Steps, in one lock:

1. **Git** — `status`; refuse to commit while a rebase/merge is in progress (recorded in the note); switch to the shared branch if needed; unstage renames; **commit** all changed files with message `<title> — checkpoint <seq>[: note]` and **trailers** `Session: <shared id>`, `Epoch: <epoch>` and `Agent: <agent of the driving session>`; **push** with upstream, **never forced**. A refused push keeps the commit locally and records `pushed: false`; every problem is appended to the checkpoint note — a checkpoint never fails because git did.
2. **Snapshot** — `omp session pack` needs the session released. `SessionService.withConversationFile` → `runtime.withReleased`: wait until the runtime is idle (up to `idleTimeoutMs`, 120 s), **stop** the runtime, run `omp session pack <session file> <tmp>`, then **restart the runtime in the background**. A prompt that arrives meanwhile **waits** for the cycle to end and then runs on the restarted runtime. The archive is hashed (sha256, size); more than **100 MiB** (`maxSnapshotBytes`) fails the snapshot (the checkpoint then records git only). The file is placed at `<dataDir>/shared/<shared id>/snapshots/<seq>.tar` (0600; directories 0700). **Snapshots never enter Git** and are not secret-scanned (private node-to-node data: whole conversations).
3. The row is recorded in `shared_checkpoints` (commit, pushed, sha256, size, message count, model, note), `lastCheckpointSeq` advances, the driver keeps the newest **3** snapshot files (older files are deleted, rows stay), and every active participant gets a `shared.checkpoint` notice through the outbox.

### 4.5 Delivery by pull

The participant receives the notice (`POST /shared/:id/checkpoints`, `202`: stale epoch → `409 stale_epoch`; higher epoch → `409 epoch_unknown` + reconcile; only the current driver may announce) and **downloads** the snapshot with a signed `GET /shared/:id/snapshots/:seq` (only active participants; `Content-Length`, `Content-Digest: sha-256=:…:`, bytes streamed from the 0600 file). While writing, the receiver checks **size and sha256 against the notice** and enforces the **100 MiB cap**; a mismatch, an oversize file or a holder that does not have it marks the snapshot unavailable on that checkpoint (no retry). Transient failures are retried with exponential backoff (5 s × 2ⁿ, ≤ 12×) and again whenever the holder comes online. A verified file is renamed into place (0600), old files beyond the newest 3 are pruned, and the participant acknowledges with `shared.snapshot_ack` (`POST /shared/:id/checkpoints/:seq/ack`); the driver records the node in `delivered_to` and raises the participant's `snapshot_seq`. A takeover needs a snapshot held on disk; a transfer waits for the ack.

### 4.6 Takeover (manual, on a participant)

`POST /shared/:id/takeover {force}` runs under the session lock:

1. **Refusals**: left the session (`not_a_participant`), already driver (`already_driver`), no linked local clone (`no_local_clone`); the driver is online (`online`/`degraded` peer status) and `force` is not set → **`409 driver_online`** (the UI asks to confirm; the driver then becomes a participant); no held snapshot → **`409 no_snapshot`**.
2. **Git alignment** (`alignWorkingTree`; **local changes are never discarded**): if the checkpoint has no commit the tree is left alone (the note says so); otherwise refuse while a rebase/merge is in progress (`git_operation_in_progress`); `fetch` (`git_fetch_failed`); checkout the shared branch unless already on it (`git_checkout_failed` — git's refusal for overlapping local changes, the changes stay); fast-forward `pull` (a missing upstream is tolerated, other git refusals are returned as `409`). If HEAD is not exactly the checkpoint commit the continuation note says so (the branch moved on, or the commit was never pushed so files after the last push may be missing).
3. **Unpack**: `omp session unpack <snapshot> --cwd <project path>` (OMP validates the archive and appends an `arrived` marker; an invalid archive → `409 snapshot_invalid`). A **new** local session is bound to the unpacked OMP session file with `SessionService.adopt` — a new runtime session on this node, as the product rules require.
4. **Switch**: in one transaction this node becomes driver (`epoch + 1`, `local_session_id` = the new session), the old driver becomes a participant. The **old mirror and the participant agent session are archived**. `shared.driver` is announced to every other active participant through the outbox and the mirror publisher starts.
5. **Continuation note** (`buildContinuationNote`) is sent as the first prompt of the new session: who continued from which checkpoint (seq, time, commit, pushed or not), the branch/HEAD, and that work done after that checkpoint on the former driver may be missing. A failure to send it does not undo the takeover.

   **What the former driver did after the checkpoint.** The mirror on this node usually holds messages newer than the snapshot (the driver kept working after its last checkpoint and then died). The note therefore carries a delimited section `--- What <node>'s agent did after checkpoint <seq> (commit <sha12>) ---` … `--- end ---` (`buildPostCheckpointDigest`, read by `postCheckpointTail` in `shared/tail.ts` from the stored `shared_mirror_messages` of the old mirror, so it works with the driver offline and after a restart). **Boundary:** the mirror transcript is ordered and the snapshot holds the first `snapshotMessages` of the driver's transcript (`takeSnapshot` stores the driving session's UI-message total, and the mirror stores the same UI messages by position), so the tail is the mirror messages at positions `>= snapshotMessages`. The section is omitted when the mirror holds no more than that many messages, there is no mirror, the checkpoint recorded no count, or the tail has nothing to show (also for a planned transfer, whose checkpoint is fresh). Content, oldest first: user and assistant text verbatim (each capped at 1500 chars, `…`), thinking blocks left out, tool calls as `name(intent): first line of the result` (intent = the call's intent or its path/command/query argument, 120 chars; result 200 chars; errors marked `ERROR`). The whole digest is capped at about 10 000 chars: over it the **most recent** messages are kept and `(N earlier messages omitted)` says so. **Not recovered:** the files the agent changed after that checkpoint (they are not in the working tree unless they were pushed; the section says so, and says when the checkpoint commit itself was never pushed), thinking, tool output beyond the first line, and messages the mirror never received. A failure to read the tail is logged and the section left out; the takeover continues.

### 4.7 Hand-over (planned, driver online)

The user's one-action flow: on A's domain the user lets A's agent code, then presses **Hand over to node-B**. CLAM does everything else; nothing is handed over unless the final state is saved and delivered.

`POST /api/local/sessions/:id/handover` (shares the session first when it is not shared yet) or `POST /api/local/shared/:id/transfer`, body `{toNodeId, agentId?, stopRunning?}` → **`202 SharedSession`** as soon as the hand-over started. Progress is the field **`SharedSession.transfer`** `{id, toNodeId, toNodeName, phase, message, stopRunning, error, newSessionId, newSessionUrl, startedAt, updatedAt}`, pushed on the WebSocket topics `shared` / `shared:<id>` (`{type:"shared"}`) at every change; the UI shows `message`.

| Phase | What happens |
| --- | --- |
| `inviting` | B is not an active participant: it is invited exactly like `POST /sessions/:id/participants` (`agentId` optional; same checks) |
| `waiting_accept` | wait until B accepted — through the auto-accept policy, or a human on B or on B's own domain. Fails `invite_declined` (declined / left / removed) or `accept_timeout` (the invitation **stays open**: hand over again once B accepted) |
| `stopping` | the driving session is busy: with `stopRunning` the turn is **aborted**, otherwise CLAM **waits** for it to finish; `stop_timeout` when it does not (30 s after an abort; the idle timeout otherwise) |
| `checkpointing` | the **final checkpoint of everything**: commit all working-tree changes (untracked files included), push the shared branch, `omp session pack` snapshot. A push or snapshot failure **fails the hand-over** (`push_failed`, `snapshot_failed`): nothing was handed over. A turn that settled while the checkpoint ran and changed the tree triggers a repeat (at most twice more) |
| `delivering` | B downloads the snapshot (pull, sha256/size verified) and acknowledges (`snapshot_not_delivered` on timeout) |
| `handing_over` | A sends `POST /shared/:id/transfer {epoch, checkpointSeq, sha256, interrupted?}` to B (`transfer_refused` on failure); B takes over (§4.6, reason `transfer`) and announces `epoch + 1`; A waits for the announcement (`transfer_pending` after `transferTimeoutMs`: it is still in progress on B, A follows when the announcement arrives) |
| `continuing` | B drives: **new session cloned from the snapshot**, epoch + 1, and a **continuation note** as its first prompt that says *"Nothing is missing"* — the checkpoint contains all of A's work, committed and pushed and the conversation is complete — plus, when A aborted a turn (`interrupted`), that the last step may have been cut off and the working tree should be checked. `newSessionId` / `newSessionUrl` (B's UI URL + `/sessions/<id>`, when known) are set |
| `failed` / `cancelled` | terminal; `failed` carries `error {code, message}` |

Afterwards A becomes a **former driver and participant** (§4.8): its old session is read-only with `movedTo {nodeId, nodeName, sessionId, url}` and A has a live **mirror** of B's session. A hand-over that was **interrupted** by a restart of A is marked `failed` (`interrupted`) at boot; if B's announcement arrives later, the record turns into `continuing`.

* **Freeze.** While the phase is `stopping`, `checkpointing`, `delivering` or `handing_over` the driving session refuses prompts with **`409 transfer_in_progress`**, so nothing can change after the final checkpoint. The freeze ends with a failure, a cancel or the completion.
* **Cancel / dismiss.** `DELETE /api/local/shared/:id/transfer` cancels a running hand-over up to `delivering` (the job is aborted, a note is written to the thread); at `handing_over` it answers `409 not_cancellable` (B was already asked). On a terminal record (`continuing`, `failed`, `cancelled`) it **dismisses** the record. Terminal records persist (in `shared_sessions.meta.transfer`) until dismissed or replaced by a new hand-over.
* **Synchronous refusals** (`409`, before anything is created): `session_busy` (the agent runs a turn and `stopRunning` is not set), `not_driver`, `transfer_in_progress` (another hand-over is running), `target_offline`, `capability_missing`, `invalid_target` (this node itself), `session_read_only` (mirror or moved session); `404` for an unknown peer.
* **Asynchronous failures** appear as `transfer.error.code`: `accept_timeout`, `invite_declined`, `stop_timeout`, `push_failed`, `snapshot_failed`, `snapshot_not_delivered`, `transfer_refused`, `transfer_pending`, `driver_changed` (another node took over meanwhile; the job is aborted), `interrupted`. A failure also writes a system note into the thread.
* **Wire side of B** (`POST /shared/:id/transfer`, unchanged except the optional `interrupted` flag): only the current driver may call; `epoch` must equal B's; B must hold that snapshot (`409 no_snapshot`); it answers `202` and performs the takeover in the background.

**Timers** (`SharedOptions`, `apps/server/src/shared/hub.ts`):

| Option | Default | Meaning |
| --- | --- | --- |
| `transferAcceptTimeoutMs` | 15 min | how long a hand-over waits for the target to accept the invitation (`accept_timeout`) |
| `transferStopTimeoutMs` | 30 s | how long an aborted turn may take to stop (`stop_timeout`) |
| `transferPollMs` | 250 ms | polling cadence of the waits above |
| `transferTimeoutMs` | 120 s | wait for the target's snapshot acknowledgement, and for its announcement after it was asked to take over |

### 4.8 Former driver returns

A node that was the driver learns it was replaced by **(a)** the new driver's `POST /shared/:id/driver` notice (higher epoch accepted), or **(b)** a reconcile: `GET /shared/:id` on each peer at boot, whenever a peer comes **online** (or its URL changes) and **every 30 s**; a higher epoch from a peer is applied. Equal epoch with a different driver is a split brain (logged, refused). Applying it:

1. In one transaction: `driverNodeId`/`epoch` updated, `local_role = former_driver`, `mirror_session_id` cleared, and the journal `shared_sessions.meta.pendingFormerDriver {epoch, driverNodeId, driverNodeName, reason, sessionId, uiUrl}` is written.
2. `completeFormerDriver` (idempotent; the journal is cleared only at the end):
   * **freeze** the driving session's transcript (the publisher's final state) and **mark the session moved** (`agent_sessions.moved_to = {nodeId, nodeName, url, sessionId, at}`; `url` = the new driver's UI URL + `/sessions/<id>` when that node has remote access enabled). The session becomes read-only: `409 session_moved`; its views are served from the frozen transcript;
   * `omp session moved <file> --to <new driver name>` (**best effort**, §8);
   * **rescue**: if the clone has uncommitted files or unpushed commits, create/checkout **`clam/rescue/<shared id>-<node name slug>`**, commit the uncommitted files (`Rescue: <title> — work of <node> that is not on <shared branch> (<new driver> drives now)`, trailers `Session`, `Epoch`, `Agent`) and push it (a failed push is noted, the commit stays local; a rebase/merge in progress or any error leaves the clone untouched and writes a note). The name is stored in `shared_sessions.rescue_branch`. Nothing is discarded or force-pushed;
   * become a **participant**: new **mirror** of the new driver, participant agent session (the node's agent), briefed; the participant agent gets a note that the driver changed.
3. Participants that are not the former driver only update their records and mirror the new driver; their agent gets the same note.
4. Fencing makes the old driver harmless until then: its mirror frames, checkpoint notices, driver notices and removals carry the old epoch and are answered `409 stale_epoch`, which triggers the reconcile.

### 4.9 Leave and remove

* A participant leaves with `POST /shared/:id/leave`; the driver cannot (`409 driver_cannot_leave`: hand over first or remove the participants). The node tells every active participant (`shared.membership` `leave`), archives its mirror and participant agent session (history is kept) and becomes `left`.
* The driver removes a participant with `DELETE /shared/:id/participants/:nodeId` (never itself): the node is marked `removed`, notified together with the others (`shared.membership` `remove`; the removed node tears down like a leave). A `remove` carries the epoch and is refused `409 stale_epoch` if it is older.
* A session that belongs to an active shared session cannot be deleted locally: `409 shared_session_active` until the node leaves or hands over.

## 5. Capability and wire summary

Every `/api/v1/shared*` endpoint is signed like all `/api/v1` requests and needs **`sessions.share` granted by the RECEIVING node to the caller**; it is not part of the default pairing grant. The sender also needs the capability in its `received_capabilities` (and has granted it back) before it queues anything: `409 capability_missing` with `details.missing` otherwise. A shared session is visible only to its participants; everything else answers `404`.

| Endpoint | Direction | Idempotency | Epoch rule | Success |
| --- | --- | --- | --- | --- |
| `POST /shared/invites` | driver → invitee | `Idempotency-Key` + natural `inviteId` | `epoch` informational | 201 accepted / 202 pending / 200 repeat |
| `POST /shared/:id/decision` | invitee → driver | key | — | 200 |
| `POST /shared/:id/messages` | any node → every other active node (its own messages only) | key + `messageId` | none (chat is never fenced) | 202 |
| `POST /shared/:id/messages/sync` | any member ← any member | none: a read (cursor in the body), naturally idempotent | none | 200 `{messages, cursor, hasMore}` |
| `POST /shared/:id/mirror` | driver → participant | **none; `(streamId, seq)`** | `stale_epoch` / `epoch_unknown` | 200 `{applied,lastSeq}` |
| `POST /shared/:id/checkpoints` | driver → participant | key | `stale_epoch` / `epoch_unknown` | 202 |
| `POST /shared/:id/checkpoints/:seq/ack` | participant → driver | key | — | 200 |
| `GET /shared/:id/snapshots/:seq` | participant ← holder | n/a | — | 200 stream |
| `POST /shared/:id/driver` | new driver → all | key | must be higher | 200 |
| `POST /shared/:id/membership` | leaver / driver → all | key | `remove` checked | 200 |
| `POST /shared/:id/transfer` | driver → target | key | must equal | 202 |
| `GET /shared/:id` | any participant | n/a | answers with its epoch (reconcile) | 200 `SharedStateResponse` |

Full schemas, status codes and the rest in [agent-network-protocol.md §5.9a](./agent-network-protocol.md#59a-shared-sessions--sessionsshare).

## 6. Data model (migration `0005_shared`)

Details of columns in [database-schema.md §3.2a](./database-schema.md#32a-shared-sessions--m5-migration-0005_shared-implemented). Everything is **node-private**: each node keeps its own rows; only ids (`shs_…`, `shi_…`) and the protocol payloads cross the wire.

| Table | What lives there |
| --- | --- |
| `shared_sessions` | the node's view: epoch, driver node, `local_role`, `state` (`active`/…), `local_session_id` (driving/moved session), `mirror_session_id`, `local_project_id`, branch/base, `agent_message_limit`, `rescue_branch`, `last_checkpoint_seq`, `meta` (`pendingFormerDriver` journal, `transfer` = the hand-over record, `lastCheckpointCommit`, `turnsSinceCheckpoint`) |
| `shared_participants` | everybody incl. this node: node/agent, `role`, `state` (`invited`/`active`/`declined`/`left`/`removed`), `agent_session_id`, `ui_url`, `snapshot_seq` (driver: newest snapshot acked), `briefed` |
| `shared_invites` | invitations received (pending/accepted/declined), incl. the driver's agent (`from_agent_id`, `from_agent_name`, needed to address it) and `model` |
| `shared_messages` | the group log: author/origin node (`author_node_id`), `kind`, `to` (JSON), `hlc`, `origin_seq` (per origin; NULL = a note of this node only), `delivery`, `injected_session_id` (idempotent hand-over to the local agent, `history`, `self`, `system`), `read_at`, `received_at`; unique `(shared_session_id, author_node_id, origin_seq)` |
| `shared_checkpoints` | seq, epoch, commit, `pushed`, snapshot sha256/size/message count/relative path (NULL = not held), `delivered_to` (JSON node ids), note |
| `shared_mirror_messages` / `shared_mirror_state` | a mirror's persisted transcript and its stream position (`stream_id`, `last_seq`, `syncing`, last live state) |
| `agent_sessions` (+3 columns) | `kind` (`local`/`mirror`), `shared_session_id`, `moved_to` (JSON) |
| `outbox` (M4) | peer calls ride it: kinds `shared.invite`, `shared.decision`, `shared.message`, `shared.checkpoint`, `shared.snapshot_ack`, `shared.driver`, `shared.membership`; ordering key `<sharedId>:<peerId>`; idempotency keys per call |

Snapshot files are outside the database in `<dataDir>/shared/<shared id>/snapshots/<seq>.tar`.

## 7. Error codes

Stable machine codes in the usual error envelope. Wire = on `/api/v1`; local = on `/api/local`; many appear on both because the local call fails before sending.

| Code | Status | Meaning |
| --- | --- | --- |
| `capability_missing` | 409 | `sessions.share` not held/granted in one direction (`details.missing`) |
| `not_driver` | 409 | a driver-only action on a node that does not drive (add participant, checkpoint, hand-over, remove) |
| `driver_online` | 409 | takeover refused while the driver is online unless `force` |
| `no_snapshot` | 409 | takeover / wire transfer without a held snapshot (or a different one) |
| `transfer_in_progress` | 409 | a hand-over is running: the driving session takes no prompts and no second hand-over starts |
| `session_busy` | 409 | hand-over without `stopRunning` while the agent runs a turn |
| `not_cancellable` | 409 | cancelling a hand-over after the target was asked to take over |
| `accept_timeout`, `invite_declined`, `stop_timeout`, `push_failed`, `driver_changed`, `interrupted` | — | asynchronous hand-over failures, in `SharedSession.transfer.error.code` (§4.7) |
| `snapshot_invalid` | 409 | `omp session unpack` rejected the archive |
| `stale_epoch` | 409 | the call carries an older epoch (`details.currentEpoch`) |
| `epoch_unknown` | 409 | the call carries a higher epoch than the receiver knows; it reconciles |
| `split_brain` | 409 | two nodes claim the same epoch |
| `mirror_resync` | 409 | the mirror frame is not the next one for its stream; replay with `sync` chunks |
| `session_read_only` | 409 | prompt/runtime on a mirror, or sharing a mirror/moved session |
| `session_moved` | 409 | prompt on a session whose work moved (`details` = the `movedTo`) |
| `shared_session_active` | 409 | deleting a session of an active shared session |
| `agent_message_limit` | 429 | loop guard: an agent message that wakes another agent beyond the budget (12 per node without a human message); a reply over the budget is posted but wakes nobody |
| `no_repository`, `not_in_workspace`, `already_participant`, `project_required`, `project_mismatch`, `unknown_agent` | 409/400 | share/accept preconditions (§4.1) |
| `not_a_git_repo`, `git_operation_in_progress`, `shared_branch_failed`, `git_fetch_failed`, `git_checkout_failed` | 409 | git refusals, nothing is discarded; other git-service refusals during the fast-forward pull pass through as 409 |
| `already_driver`, `not_a_participant`, `no_local_clone`, `driver_cannot_leave`, `invalid_target`, `target_offline`, `snapshot_failed`, `snapshot_not_delivered`, `transfer_refused`, `transfer_pending` | 409 | takeover, transfer, leave (§4.6–4.9) |
| `forbidden` | 403 | not an active participant (also for group messages and `messages/sync`) / not the driver / not in the workspace / a pushed message whose origin is not the sender |
| `not_found` | 404 | unknown shared session, participant, checkpoint or snapshot (also: you are not a participant) |
| `idempotency_conflict` | 409 | same key or id with another body or sender; a group message id or a per-origin sequence number already used by another message |

## 8. Restart recovery and honest limits

**Recovery.**

* The **outbox** (M4) is durable: invitations, decisions, group chat messages, checkpoint notices, acks, driver and membership notices are rows retried with backoff while the peer is reachable and delivered in order per `<sharedId>:<peerId>`. A message that is never delivered that way (the peer refused it with a final error) is marked `failed` here and still reaches the peer by its pull.
* **Pending downloads** are checkpoint rows with a sha256 but no file; they are retried at boot and whenever the holder comes online.
* **Former driver**: `meta.pendingFormerDriver` is re-run at boot until it is done (§4.8).
* **Injection**: at boot every active shared session is looked at again: messages not yet handed to the local agent session (`injected_session_id` empty) are classified (history / buffer / addressed) and a pending wake-up is delivered, with its buffer, once (per-session FIFO, idempotent by `shared_msg_<id>`).
* **Mirror**: active drivers restart their publisher at boot and resync every participant; participants keep their stored transcript.
* **Hand-over**: a running hand-over (`meta.transfer`) is marked `failed` (`interrupted`) at boot — a restart loses the in-memory job; nothing was handed over unless B had already been asked, and a late announcement from B turns the record into `continuing`. Terminal records stay until dismissed.
* **Reconcile**: at boot (the cached peer status may be stale), on every peer `online` transition and **every 30 s**, `GET /shared/:id` to each peer; a higher epoch is applied. Transfer and takeover are idempotent through the epoch.
* **Group chat catch-up**: at boot, on every peer `online`/`url_changed` transition and every 30 s (`reconcileMs`) the node pulls from each reachable peer what its own log lacks (`POST /shared/:id/messages/sync`, §4.3). It runs on its own: a message whose outbox delivery died (the peer refused it, or gave up after the attempts) is still found there; nothing about it needs the driver.

**Limits (stated honestly).**

* **Work on the driver after its last checkpoint is lost to the others if it dies.** The takeover continues from the last checkpoint that was pushed and snapshotted; the continuation note says so. A checkpoint that could not push has its commit only on the driver (the note says so).
* `omp session moved` is **best effort**: OMP refuses it while another `omp` process on the same machine holds the same session id (its lease). In two-nodes-on-one-machine setups the moved marker on the OMP copy may be missing; CLAM's own `moved_to` still makes the session read-only.
* **Two nodes on one machine share OMP's lease per session id**: tests and demos on one machine work, but the two nodes cannot both run the same OMP session id concurrently.
* A **session that was never prompted cannot be snapshotted or resumed** (it has no conversation file yet); the first checkpoint records git only, and a takeover then refuses with `no_snapshot`.
* The **unpack cwd spelling must equal the runtime cwd**: `omp session unpack --cwd <project path>` and the later runtime open use the same project path string; a different spelling (symlink, trailing slash, case) makes OMP treat the session as another project.
* Snapshots hold whole conversations: they are never put in Git or scanned, and travel only to participants over the signed tunnel (Cloudflare terminates TLS, [security.md](./security.md)). Do not share a session whose conversation must not reach another node.
* Takeover is manual; there is no automatic failover, no hand back button other than a hand-over from the new driver, and no handoff protocol with dependency setup (that is [M7](./roadmap.md#m7--handoff-protocol--context-sync--recovery-p0)).
* A participant's agent works in the participant's own clone and may diverge from the shared branch; it is not part of the driver's checkpoint.
* **Group chat.** A message accepted by a node that dies before any copy left it exists only there until it returns. If no member agent is reachable at all (the lead's node is offline and the posting node has no agent session and no other agent node is online), a human message without a mention waits in the log and a system line says so. "History" for a joining node is decided by clocks (`createdAt` of the message against the node's `joinedAt`), so a node whose clock is far behind may treat a message sent right after its join as history. A fake or buggy clock far in the future moves every node's hybrid clock forward (the order stays consistent; there is no drift bound). If an origin lost its own database and reuses sequence numbers, the others answer `409 idempotency_conflict`. An agent that **quotes** a mention in its final text (for example by repeating what a person wrote) wakes whoever is named, and that is counted against the budget; the texts CLAM itself writes for agents (reminders, tool results) never contain a mention for that reason.

## 9. Code map (`apps/server/src/shared/`)

| Unit | Role |
| --- | --- |
| `service.ts` | `SharedService`, composition root: owns the store, publishes changes (WebSocket `shared`), the outbox helper (`enqueue`), `assertShareable`, `uiUrl` (the node's public URL when remote access is on); starts/stops with the task engine; registers the host tools |
| `hub.ts` | the seams: `SharedHub` and one interface per unit (units talk only through them), options/timers and defaults |
| `store.ts` | every SQL statement of the feature (synchronous better-sqlite3); ids `shs_`/`shi_`; the log (`appendMessage`, `insertReceived`, `cursor`, `messagesAfter`), the wake budget |
| `sharing.ts` | share, invitations (auto-accept), accept (mirror + participant agent + brief), decisions, leave/remove, delete guard |
| `discussion.ts` | the group chat: the replicated log (HLC stamps, per-origin sequence, fan-out, receive, catch-up pull), addressing, the unaddressed buffer, injection and retries, automatic replies, system messages, the wake budget |
| `mirror.ts` | live mirror: driver publisher (batches, sync chunks, resync) and participant receiver (apply, persist, republish); `SessionViews` for mirror/moved sessions |
| `transcript.ts` | rebuilds a transcript from the session event stream |
| `checkpoints.ts` | checkpoint (git commit/push + snapshot), notices, downloads with retry, acks, pruning |
| `snapshots.ts` | snapshot files (0600/0700), digest header, streamed verified download with size cap |
| `transfers.ts` | the hand-over job: invite, wait for acceptance, stop/wait, final checkpoint, delivery, ask the target, record in `meta.transfer`, cancel, prompt freeze, boot recovery |
| `epochs.ts` | takeover, receiving a wire transfer, receiving driver changes, former driver completion + rescue, reconcile, `GET /shared/:id` state |
| `outbox.ts` | outbox kinds and handlers (message delivery, undeliverable invitation) |
| `views.ts` | rows → contract types, candidate projects |
| `host-tools.ts` | `mesh_team`, `mesh_say` |

Elsewhere: `apps/server/src/api/shared.ts` (local routes), `apps/server/src/network/shared-routes.ts` (wire routes), `apps/server/src/services/session-service.ts` (kind, moved, views, `adopt`, `markMoved`, `withConversationFile`), `packages/agent-network/src/wire.ts` (schemas), `packages/contracts/src/shared.ts` and `routes.ts`, `packages/task-engine/src/shared.ts` (pure briefs/notes/messages), `packages/database` (`0005_shared`).

## 10. Try it with two nodes

Prerequisites: two paired nodes (README: pair two machines; for development `CLAM_ALLOW_LOOPBACK_PEERS=1` and two data dirs), the **same GitHub repository** as a linked project on both, push rights on both, OMP logged in on both, and **`sessions.share` granted by each node to the other** (peer settings → capabilities, or `PATCH /api/local/network/peers/:id`). Optionally switch on **Auto-accept** for the peer on B.

```bash
# A (UI port 4317): create a session in the project and give it one prompt so it has a conversation
# then share it with B's agent
curl -s -X POST http://127.0.0.1:4317/api/local/sessions/<A session id>/participants -H 'content-type: application/json' -d '{"nodeId":"<B node id>"}'
# B (UI port 4327): accept the invitation if auto-accept is off
curl -s http://127.0.0.1:4327/api/local/shared/invites
curl -s -X POST http://127.0.0.1:4327/api/local/shared/invites/<invite id>/decide -H 'content-type: application/json' -d '{"decision":"accept"}'
# B shows A's session as a live read-only mirror; talk in the group chat from either side (no mention = to the lead; @node-b, @all ... address agents)
curl -s -X POST http://127.0.0.1:4327/api/local/shared/<shared id>/messages -H 'content-type: application/json' -d '{"text":"@node-b please add a CHANGELOG entry"}'
# take a checkpoint now (A), wait until B holds the snapshot (GET /api/local/shared/<id> shows deliveredTo)
curl -s -X POST http://127.0.0.1:4317/api/local/shared/<shared id>/checkpoint -H 'content-type: application/json' -d '{}'
# stop A; then on B continue the work (add "force":true when A is still online)
curl -s -X POST http://127.0.0.1:4327/api/local/shared/<shared id>/takeover -H 'content-type: application/json' -d '{}'
# restart A: its session turns into a read-only "moved" copy, unpushed work goes to clam/rescue/<shared id>-<node>
```

Planned hand-over with A online (one action; invites B first when it is not a participant): `POST /api/local/sessions/<A session id>/handover {"toNodeId":"<B node id>","stopRunning":true}` or, for a session that is already shared, `POST /api/local/shared/<shared id>/transfer` with the same body; follow `transfer.phase` in `GET /api/local/shared/<id>` (`continuing` = B drives, `newSessionUrl` points at B's session). Watching B through its domain: [README: open a node's UI remotely](../README.md#open-a-nodes-ui-remotely).
