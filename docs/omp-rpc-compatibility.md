# CL Agent Mesh — OMP RPC Compatibility Analysis

Verified against **OMP 18.14.0** (`omp --version` → `omp/18.14.0`, binary `~/.bun/bin/omp`) on 2026-10-31. "Verified" means observed live with read-only commands or an isolated profile (`omp --profile clam-dev`), or read from the installed docs/sources. Anything else is tagged `[INFERENCE]`. This document never assumes an OMP capability that was not found.

Rules adopted from the spec: **never build a competing login system** (use OMP's RPC/CLI), **never read/write OMP's internal databases or credential store** (`agent.db`, `models.db`, `approval-cache.db`, `secret-placeholder.key`), runtime interface stays pluggable.

## Sources

| Ref | Source |
| --- | --- |
| [rpc.md] | `omp://rpc.md` (RPC Protocol Reference) |
| [approval] | `omp://approval-mode.md` |
| [providers] | `omp://providers.md` |
| [secrets] | `omp://secrets.md` (prompt-level secret obfuscation; **not** a credential store reference — see §11) |
| [models] | `omp://models.md` |
| [session] | `omp://session.md`, `omp://session-operations-export-share-fork-resume.md`, `omp://handoff-generation-pipeline.md` |
| [types] | `~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/modes/rpc/{rpc-types.ts,rpc-mode.ts,rpc-frame.ts,rpc-client.ts}` |
| [events] | `…/@oh-my-pi/pi-agent-core/src/types.ts` (`AgentEvent`), `…/@oh-my-pi/pi-ai/src/types.ts` (`AssistantMessageEvent`, `Usage`) |
| [cli] | live output of `omp config --help`, `omp session --help`, `omp auth --help`, `omp login --help`, `omp usage --json`, `omp stats --json`, `omp models --json` |

Legend: ✅ **Supported** (RPC) · 🟦 **Supported via CLI** · 🟨 **Partial / constraints** · ⛔ **Not supported** (gap, workaround stated).

---

## 1. Transport facts

| Fact | Detail | Status |
| --- | --- | --- |
| Protocol | Newline-delimited JSON over stdio (`omp --mode rpc`), **not JSON-RPC** | ✅ |
| Startup | First stdout frame `{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864}`; `extension_ui_request`/`available_commands_update` frames may follow | ✅ verified live |
| Framing v2 | `negotiate_protocol {protocolVersion: 2}` → oversized outbound frames arrive as `rpc_chunk {chunkId,index,count,byteLength,data(base64)}`; host reassembles and validates. Inbound frames are never chunked and should stay ≤ 1 MiB | ✅ verified live |
| Responses | `{id?, type:"response", command, success, data?|error, code?}`; match by `id`; concurrent commands (e.g. `bash`) may complete out of order; ordinary commands run on a serialized queue | ✅ |
| Prompt completion | `prompt` is acknowledged on **admission**; completion is a later `prompt_result {id, agentInvoked, status: completed\|aborted\|error, error?, sessionSettled}` | ✅ |
| Done vs yielded | `prompt_result`/`agent_end` = agent yielded; **session settled** only when no run, queue, or background job can wake it (`session_settled`, `get_state.isSettled`) | ✅ |
| Shutdown | Closing stdin → graceful exit 0; host must keep reading stdout until exit | ✅ |
| Errors | `success:false` + `error` (+ machine `code`, e.g. `session_busy`, `stale_cursor`, `entry_not_found`); malformed JSONL → `parse` error response, process continues | ✅ |
| Process flags useful to a host | `--mode rpc`, `--no-ui`, `--cwd`, `--session-dir`, `--model provider/id`, `--thinking`, `--no-session`, `--profile`, `--approval-mode`, `--auto-approve`, `--max-cost` | ✅ [rpc.md], [cli] |

The adapter implements: ready handshake → `negotiate_protocol` (v2) → `open_session`; id-correlated commands with per-command timeouts; chunk reassembly; unsolicited frame routing. Never depend on frames arriving in command order.

---

## 2. FR-04 mapping

| FR-04 requirement | OMP surface | Status | How CL Agent Mesh uses it / gap |
| --- | --- | --- | --- |
| OMP CLI RPC adapter | `omp --mode rpc --no-ui --cwd <project>` | ✅ | `@clam/agent-runtime` omp adapter (child per active session) |
| Pluggable runtime | — | n/a | CL-side adapter interface; OMP is implementation #1 |
| **Session browsing** | Disk: `~/.omp/agent/sessions/<encoded-cwd>/<ts>_<id>.jsonl` ([session.md]); RPC: `get_messages_page`, `get_messages`, `get_entries`, `get_tree`, `get_branch_messages`; `switch_session{sessionPath}` | ✅ / 🟨 | CLAM keeps its own session index (`agent_sessions`) and one OMP directory per CLAM session (`<dataDir>/sessions/<id>`), so browsing = listing CLAM rows. Message paging uses `get_messages_page` (≤256, cursor bound to session id+leaf+count; fails `session_busy` while streaming/compacting, `stale_cursor` if the snapshot changes). While streaming the server serves history from the session JSONL (documented format) and merges live events. **Gap:** browsing OMP sessions created *outside* CLAM (the user's terminal sessions under `~/.omp/agent/sessions`) is possible read-only by file listing but is not offered in M1 — importing them would need `omp session` semantics decided per milestone. |
| **Create session** | `new_session`; `open_session{sessionDir,provider?,modelId?}` | ✅ | `open_session` with a fresh CLAM directory starts a new OMP session; returns `{cancelled, resumed:false, sessionId, sessionFile}` |
| **Resume session** | `open_session` (= `--session-dir X --continue`), `switch_session{sessionPath}` | ✅ | Respawn → `open_session` on the same directory → `resumed:true`. Restores the saved model; if it cannot (renamed model, no credentials) it **fails with `Could not restore model <provider/id>`** and the previous session stays active — adapter surfaces this and offers model re-selection via `provider`/`modelId` params |
| **Send prompt** | `prompt{message,images?,streamingBehavior?}` | ✅ | `POST /sessions/:id/prompt` → `prompt`; ack on admission |
| While busy | `steer`, `follow_up`, `streamingBehavior: "steer" \| "followUp"` (**required** while streaming), queue ops (`remove_queued_message`, `promote_queued_message`, `abort_and_restore_queue`, `queue_update` event) | ✅ | `PromptBody.streamingBehavior`; `SessionLiveState.queued` from `get_state`/`queue_update` |
| **Abort** | `abort`, `abort_and_restore_queue`, `abort_and_prompt`, `abort_bash`, `abort_retry` | ✅ | `POST /sessions/:id/abort` → `abort`; resulting `prompt_result.status = "aborted"` |
| **Stream events** | `AgentSessionEvent` frames: `agent_start`, `turn_start`, `message_start`, `message_update{assistantMessageEvent: text_delta\|thinking_delta\|toolcall_delta\|…_end\|done\|error}`, `message_end`, `turn_end`, `agent_end`, `queue_update`, `prompt_result`, `session_settled`, `goal_updated`, compaction events, `notice`, `available_commands_update` | ✅ | Normalized to contracts `SessionEvent` (`message_delta` with `kind: text\|thinking\|toolCall`, etc.). Caveat: `agent_end.messages` may be compacted — keep messages accumulated from the stream. `set_event_filter` can drop noisy events |
| **Model selection** | `get_available_models`, `set_model{provider,modelId}`, `cycle_model`, `set_thinking_level`, `get_available_thinking_levels`, `cycle_thinking_level`; CLI `omp models --json` | ✅ / 🟦 | `POST /sessions/:id/model` / `/thinking`; catalog from `GET /omp/models` (CLI JSON incl. cost + `contextWindow`) |
| **Model roles** | Config key `modelRoles` (record); CLI `omp config get modelRoles --json` / `omp config set modelRoles '<json>'` | 🟦 | See §4 |
| **Tool execution tracking** | `tool_execution_start{toolCallId,toolName,args,intent?}`, `tool_execution_update{partialResult}`, `tool_stream_update`, `tool_execution_end{result,isError}`; `get_state.todoPhases`; `get_subagents`, `set_subagent_subscription`, `cancel_subagent`, `steer_subagent` | ✅ | → `tool_start`/`tool_update`/`tool_end`. Subagent events default **off** (`set_subagent_subscription`); enabling them is out of M1 scope |
| **Approvals** | `--approval-mode`, tool tiers, `extension_ui_request` dialogs | 🟨 | See §5 |
| **Context usage** | `get_state.contextUsage {tokens, contextWindow, percent}`; `get_session_stats.contextUsage` | ✅ verified live | → `SessionLiveState.contextUsage`. `compact`, `set_auto_compaction` available for user-driven compaction (not wired in M1) |
| **Cost tracking** | `get_session_stats {tokens{input,output,reasoning,cacheRead,cacheWrite,total}, cost, premiumRequests, …}`; per-message `usage` on assistant messages; `get_state.usageLimit?` | ✅ verified live | Session-level cost is OMP's own estimate from catalog prices; labelled `omp-recorded`. Models with `pricingStatus` unpriced contribute no cost (OMP reports `unpricedRequests` in `omp stats`) — shown as "Unpriced", never guessed |
| **Session checkpoint** | `handoff{customInstructions?}`, `fork{entryId?}`, `branch{entryId}`, `navigate_tree`, `export_html`; CLI `omp session pack/unpack/moved` | ✅ / 🟦 | See §8. **Gap:** OMP has no "checkpoint file you can restore the exact working tree + process from"; sessions are conversation logs |

---

## 3. Providers, login, logout, API keys (Settings → OMP Providers & Login)

### 3.1 What is supported

| Requirement | Surface | Status | Notes |
| --- | --- | --- | --- |
| Detect OMP installed; version; binary path | `OmpLocator` (PATH + `~/.bun/bin`), `omp --version`, `omp config path` | 🟦 | → `OmpInstall {installed, version, binaryPath, configPath}` |
| Providers list + auth status | RPC `get_login_providers` → `{providers:[{id,name,available,authenticated}]}` | ✅ verified live (ids seen: `openai-codex`, `anthropic`, `zai`, `zai-coding-plan`, `kimi-code`, `openrouter`, `github-copilot`, …) | Control process; → `ProvidersOverview.providers` |
| **Login** (OAuth / key flows) | RPC `login {providerId}`; `extension_ui_request` frames `open_url {url, launchUrl?, instructions?}`, `notify`, and `input` prompts; answered with `extension_ui_response` | 🟨 | Flow below |
| **Logout** | RPC `get_logout_accounts {providerId}` → `{accounts:[{credentialId,provider,label,detail,type,active}]}`; `logout {providerId, credentialId}` → `{remainingSource?}` | ✅ | Per stored credential (one provider can hold several accounts). `remainingSource` tells which other source (stored credential / env var / config key) still authenticates the provider |
| **API key config** | (a) interactive `/login <provider>` API-key logins; (b) provider environment variables; (c) `models.yml` `apiKey` for custom providers; (d) `omp auth import <file>` | 🟨 | **No RPC command accepts an API key.** See §3.3 |
| Default provider/model | `modelRoles.default` | 🟦 | `ProvidersOverview.defaultModel` |
| Test provider/model | none dedicated | 🟨 | CLAM-side: a one-shot print-mode child — `omp -p --mode json --no-session --no-tools --no-lsp --no-extensions --no-skills --no-rules --no-context-files --no-title --system-prompt <one line> [--thinking off] --model <selector> <tiny prompt>` — timed and parsed into `ModelTestResult {ok, latencyMs, output?, error?}`. Nothing is persisted. Spends real tokens; user-triggered only |
| Auth & quota errors | `prompt_result.error`, `assistantMessageEvent.error`, `omp usage` limit status, `get_state.usageLimit?` | ✅ | Surfaced as `notice` + Settings badges |
| Custom provider config | `models.yml` (`providers:`, `baseUrl`, `api`, `apiKey`, `models`, `discovery`) in the agent dir | 🟨 | Supported by OMP (file based). **Gap:** no RPC/CLI to write it. CL Agent Mesh shows what OMP reports (`omp models --json`) and documents the file; it does **not** edit `models.yml` in M1 (would mean writing OMP configuration without a supported write contract). Validation command: `omp models` |

### 3.2 Login over RPC — exact behaviour ([rpc.md] "Login", "Extension UI Sub-Protocol")

* The host sends `{"type":"login","providerId":"anthropic"}` (control process, `--no-ui`: a host-issued `login` is **independent of the UI settings**).
* OMP emits `extension_ui_request` frames: `open_url` (fire-and-forget; `url`, optional `launchUrl` — a short loopback redirect recommended as copy target — and `instructions`), `notify` progress, and `input` prompts **only after the provider emitted an authorization URL**.
* The host answers `input` with `{"type":"extension_ui_response","id":"…","value":"<text>"}` (or `{"cancelled":true}`).
* Prompts marked **`secret: true` are always rejected**: the `login` response fails and directs the user to the terminal UI. Prompts before the authorization URL are also unsupported.
* Mapping to contracts: `LoginFlow.state` = `starting` → `awaiting_browser` (`url`, `instructions`) → `awaiting_input` (`prompt {requestId, message, placeholder}`) → `success | error | cancelled`; events on topic `login:<flowId>`; `POST /omp/login/:flowId/input {requestId, value}` → `extension_ui_response`.
* **The CL server never opens the browser itself** on a remote machine; the web client opens `url` (the browser may be on another device — OMP's loopback `launchUrl` works only when the browser is on the same host as OMP; for remote browsers the pasted-callback path via an `input` prompt is the only option `[INFERENCE: depends on provider]`).

**Gaps (explicit):** providers whose login requires a secret `input` (some API-key providers, e.g. `/login baseten`, `/login coreweave`, `/login sakana`) cannot complete over RPC. Workarounds: run `omp login <provider>` in a terminal; or set the provider env var before starting CL Agent Mesh. The UI states this and shows the exact command. A host-side pseudo-terminal login is **not** built (it would be a competing login system and would expose a terminal — rejected by [security.md](./security.md)).

### 3.3 API keys — decision

OMP resolves credentials in this order ([providers]): runtime `--api-key` → `models.yml` key → stored OAuth → login-saved key → extension config → **provider environment variable** (incl. `.env` files) → other stored key. Storage is OMP's private `agent.db` (never touched by CL).

| Option | Verdict |
| --- | --- |
| Write into `agent.db` / `models.db` | **Forbidden** (no supported contract) |
| `omp auth import <credentials.json>` | Documented CLI, but the file format is the output of `omp auth export` (contains secrets, no stability promise found). **Not used in M1.** Revisit only if a documented schema is published |
| Pass an API key to each spawned child as the provider **environment variable** from CL's own secret store | Supported by OMP's documented resolution order (env var, priority 6). **Possible later** (M2+): stored via `@clam/secret-store`, injected per child, never logged. Not in M1 to avoid creating a second credential system; the Settings page instead reports env-var-based auth as detected by `get_login_providers`/`get_logout_accounts` |
| Terminal `omp login` | Always available; UI shows the command |

Net M1 capability: **login/logout via RPC for flows without secret prompts; API keys = unsupported-in-UI with a documented terminal/env workaround.**

### 3.4 `[secrets]` — what it is not

`omp://secrets.md` documents **prompt secret obfuscation** (`secrets.enabled`, `secrets.yml`, placeholder substitution before text goes to a model provider). It is **not** the credential store description (that is `agent.db`/auth broker, see [providers] and `auth-broker-gateway.md`). Relevance: (1) CL may suggest enabling it for handoff-bound sessions, but must not rely on it as the only guard against secrets entering manifests ([security.md](./security.md)); (2) it confirms OMP keeps a per-install HMAC key (`secret-placeholder.key`) CL must never read.

---

## 4. Model roles

* Stored under `modelRoles` in OMP `config.yml`. Live value on this machine: `{advisor: "anthropic/claude-opus-5-5:xhigh", task: "anthropic/claude-sonnet-5-5", tiny: "anthropic/claude-sonnet-5", default: "anthropic/claude-opus-5-5", web: "anthropic/claude-haiku-4-5"}` — **roles are an open set**.
* Built-in roles ([models]): chat — `default`, `smol`, `slow`, `vision`, `plan`, `commit`, `tiny`, `memory`, `task`, `advisor`; model-kind — `image`, `web`, `speech`, `dictation`, `judge`. Custom role names may be added; they use chat models.
* The spec's five (`default`, `smol`, `slow`, `plan`, `commit`) are **highlighted** (`HIGHLIGHTED_MODEL_ROLES`) but the API is open-ended: `ModelRoles = Record<string,string>`; the UI lists every role OMP returns plus the highlighted five even when unset, and offers the extra built-ins (`task`, `tiny`, `advisor`, `web`, …).
* Values are `provider/id[:thinking]` selectors; may be comma-separated fallbacks (first available), and `@alias` references (`plan: "@slow"`). Chat roles accept `:minimal|low|medium|high` suffixes; model-kind roles do not. CL treats values as opaque strings and validates only against `omp models --json`.
* **Read:** `omp config get modelRoles --json` → `{key, value:{…}, type:"record"}` (verified).
* **Write (verified with `--profile clam-dev`):** per-key paths are **rejected** (`omp config set modelRoles.default X` → `Unknown setting: modelRoles.default`). The whole record must be written: `omp config set modelRoles '{"default":"…","plan":"…"}'` → `✔ Set modelRoles = {…}`; `omp config reset modelRoles` resets to `{}`. `PUT /omp/model-roles {role, selector|null}` is therefore **read-modify-write** (read current record, set/delete one key, write the whole JSON) serialized by an in-process queue, passing the JSON as a single argv element (never a shell string); an empty record is written with `omp config reset modelRoles`. Role names and selectors are validated (`provider/id[:thinking]`), and the write is refused if an existing role has an unexpected value (edit it with `omp config` instead). **Gap:** there is no compare-and-set against OMP itself — a concurrent external edit between the read and the write can be lost.
* Scope: writes go to the config layer `omp config set` targets (global `config.yml` of the active agent dir). Project-level overrides in `<cwd>/.omp` are not touched by CL. Role changes apply to sessions started afterwards; a running session keeps its model until `set_model`.
* Fallback behaviour (unset `smol`/`slow` inherit `default`; `tiny` → `@smol`; `memory` → `@tiny`) is OMP's; the UI shows "inherits default" hints only from the documented rules and never invents resolved values.

---

## 5. Tool approvals

[approval] defines tiers (`read`/`write`/`exec`) and modes `always-ask`, `always-ask-cached`, `write`, `yolo` (**OMP default**). `--approval-mode <mode>` sets it per process; `--auto-approve`/`--yolo` force yolo. Tool/user `deny` is absolute; restricted folders always prompt.

| Question | Finding | Status |
| --- | --- | --- |
| Setting the mode for a host-run process | `--approval-mode` flag; `NodeSettings.approvalMode` → flag on spawn | ✅ |
| Do prompts reach an RPC host? | Docs: *"RPC, ACP, and other hosts without an approval dialog get a select with the same choices and the full details"* (Approve / Approve `<tool>` for this session / Deny; plus `Approve File`, `Always Approve File`, … in `always-ask-cached`) | ✅ verified live (`always-ask`): `extension_ui_request` `select`, title `"Allow tool: bash\nCommand: ls"`, options `["Approve","Approve bash for this session","Deny"]` |
| Behaviour under `--no-ui` | *"Under `--no-ui`, tools requiring approval fail closed with a no-interactive-UI error rather than sending an approval dialog"* ([rpc.md]) | ✅ documented |
| Net design | `yolo` ⇒ spawn `--no-ui`. Non-yolo ⇒ spawn **without** `--no-ui` so approval dialogs arrive as `extension_ui_request` (`select`), normalized to `SessionEvent.ui_request`, answered via `POST /sessions/:id/ui-response` → `extension_ui_response {id, value}` / `{cancelled:true}` | ✅ implemented by ServerCore; request shape verified live. Runtime also exposes pending approvals at `GET /sessions/:id/ui-requests`. Idle reaping never touches a runtime with a pending approval |
| Timeouts | Dialogs may carry `timeout`; on timeout OMP resolves to the default (deny/undefined) and emits `cancel {targetId}`; the UI closes the dialog and ignores late answers | ✅ documented |
| Headless subagents | Run with yolo; any call resolving to `prompt` is rejected | ✅ documented |
| Safety | In `yolo` a bare critical-command override (e.g. `rm -rf /`) is ignored; only explicit tool/user `prompt`/`deny` policies still apply. **Approval is not a sandbox.** CL surfaces the active approval mode prominently and recommends a non-`yolo` mode | ✅ documented |
| Unattended delegated tasks (M4) | A remote task runs under the **receiver's** mode; with a prompting mode and nobody present the task blocks on `ui_request` → surfaced as `blocked (needs approval)` | design |

Gap: `--approval-mode` is per process; changing `NodeSettings.approvalMode` affects only runtimes started afterwards. No RPC command to change the mode of a live session was found.

---

## 6. Usage (`omp stats` vs `omp usage`)

CL Agent Mesh distinguishes **three provenances** (`DataSource`): `omp-recorded`, `provider-reported`, `clam-estimated`.

| Need | Source | Provenance | Notes |
| --- | --- | --- | --- |
| Tokens, requests, errors, cost by provider/model/folder/time | CLI `omp stats --json` → `{overall, byModel[], byFolder[], byAgentType[], timeSeries[], costSeries[], modelSeries[], modelPerformanceSeries[]}` | `omp-recorded` | ~15 s cold → server-side cache + background refresh (`RecordedUsage.stale`), with hourly totals accumulated in `usage_buckets`. **Window:** per ServerIntegrations' verification, the output covers only the **last 24 hours** (hourly `timeSeries`); it is not all-time, and has no per-bucket input/output split, so `UsagePoint.tokens` carries `total` only. Dashboards label the window explicitly |
| Quota / limits / reset time | CLI `omp usage --json --redact [--provider X] [--history --days N]` → `{generatedAt, reports:[{provider, fetchedAt, limits:[{id,label,scope,window{durationMs,resetsAt},amount{used,limit,remaining,usedFraction,unit},status}]}], accountsWithoutUsage, capacity, disabledCredentials}` | `provider-reported` | ~2 s. `--redact` always. Providers not listed ⇒ **"Unavailable"** (never guess). `accountsWithoutUsage` shows accounts that expose none |
| Per-session live tokens/cost/context | RPC `get_session_stats` | `omp-recorded` (OMP's own estimate from catalog prices) | rolled up by project/agent for `GET /usage/mesh` |
| Cost by project | `omp stats` `byFolder` (path) joined to `projects.path`; plus session rollup | `omp-recorded` | Only for work OMP recorded under that folder; sessions run elsewhere are not attributed |
| Cost by agent | CL session rollup (`agent_sessions.stats`) | `omp-recorded` (aggregated by CL) | OMP's `byAgentType` is subagent type, **not** a CL agent |
| History beyond OMP's window | not available from OMP | — | **Gap** → partly mitigated in M1: `usage_buckets` (hourly totals) and `provider_usage` (per-session rows) accumulate locally going forward; per-bucket input/output split stays unavailable |
| Per-provider remaining quota for providers without `omp usage` reports | none | — | UI: "Unavailable — provider does not expose usage via OMP" |

Mixing rule: a number from `omp stats` is never presented as quota, and a quota percentage is never converted to tokens or dollars. `clam-estimated` is reserved for CL's own arithmetic (e.g., projecting a session's remaining context) and is always tagged.

---

## 7. Messages and history format

* Message types and `Usage` shape from `pi-ai/src/types.ts`; the server maps OMP messages to `UiMessage` (`user`, `assistant`, `toolResult`, `custom`) with blocks `text`, `thinking` (may be `redacted`), `toolCall`, `image`.
* Session JSONL files ([session.md]) are documented and may be **read** (never written) for browsing while the runtime is busy. A message larger than 1 MiB over v1 framing fails with an overflow error → v2 is negotiated at startup.
* `get_messages_page` cursors are opaque and fragile across mutations; the server never stores them.

---

## 8. Checkpoint and handoff primitives

| Primitive | What it does | Use in CL Agent Mesh |
| --- | --- | --- |
| RPC `handoff {customInstructions?}` | Generates a **handoff summary** of the current session (see `omp://handoff-generation-pipeline.md`); fails while streaming; returns `{savedPath?}` or `null` | Source of the "relevant conversation summary" and "plan + remaining TODOs" inside the handoff manifest (summary text only; reviewed for secrets) |
| RPC `fork {entryId?}` / `branch {entryId}` | New session file from a point in history; `parentSession` recorded; `session_busy` while busy | Task branching/retry (M8); not a cross-machine mechanism |
| RPC `navigate_tree`, `get_tree`, `get_entries` | Tree navigation within one session file | Plan/progress inspection |
| CLI `omp session pack <jsonl\|id> <tar>` | Packs a session **with artifacts and image blobs** into a tar | Optional **attachment** to a handoff for audit/reference |
| CLI `omp session unpack <tar> --cwd <dir>` | Restores session files on another machine; prints session file path | Optional import so the target can *read* the old transcript |
| CLI `omp session moved <jsonl> --to <name>` | Marks the local copy stale (resuming it later forks it) | Source-side marker after a durable ack |
| RPC `export_html` | HTML transcript | Optional human-readable export |

Constraints:

* **A packed session is not a running session.** The spec mandates that a handoff creates a **new** runtime session on the target (`open_session` on a new directory); `unpack` only provides history. Details in [handoff-protocol.md](./handoff-protocol.md#9-relation-to-omp-handoff-and-session-pack).
* Working-tree state, installed dependencies and environment are **not** captured by any OMP primitive → CL's git-engine/handoff-engine produces them (M2/M7).
* `omp session pack` bundles full conversation content; it may contain secrets from tool output. It never goes into Git and is transferred only as an encrypted-in-transit artifact after a secret scan, if at all.

---

## 9. Other RPC capabilities noted

**Used since M4: `set_host_tools` and the host tool sub-protocol.** `@clam/agent-runtime` sends `set_host_tools` after `open_session` (and after every restart) with the definitions of the node's `HostToolProvider` (`AgentRuntime.setHostToolProvider`; the server's provider is the `HostToolRegistry` of `apps/server/src/services/host-tool-registry.ts`, the `mesh_*` tools being one set), dispatches every `host_tool_call` frame concurrently to the provider with a per-call `AbortController` (aborted by `host_tool_cancel` and process exit) and answers with `host_tool_update` / `host_tool_result` (`isError` when the provider throws or reports an error; text clipped to 100 000 characters). Verified live with omp 18.14: tools are called directly **only with `loadMode: "essential"`** — an omitted `loadMode` makes OMP treat them as *discoverable* and mount them under `xd://`, where the model needs two extra turns (`read xd://<tool>`, then `write`) before it can call one. CL registers every `mesh_*` tool as `essential`. Executed host tools show up in the session UI through the normal `tool_start`/`tool_end` events. Also used: `--max-cost <usd>` (a delegated task's `maxCostUsd`; `prompt_result.status = "error"` when the limit is reached) and a per-session `--approval-mode` override at spawn.

Not used: `set_host_uri_schemes`, `goal`, `btw`, `compact`, `set_auto_compaction`, `set_todos`, `bash`/`abort_bash`, live voice, dictation, word prediction, `set_ask_dialog` (opt-in `ask` dialogs — if enabled the host must answer with `answers`), `set_subagent_subscription`.

---

## 10. Summary matrix

| Area | M1 status |
| --- | --- |
| Install detection, version, path | ✅ |
| Providers list, auth status | ✅ |
| Login (non-secret flows) | ✅ ; secret-prompt flows ⛔ → terminal workaround |
| Logout per credential | ✅ |
| API key entry in UI | ⛔ → terminal `omp login`, env var, `models.yml`; documented |
| Custom provider editing | ⛔ (file-based in OMP; read-only visibility in CL) |
| Models list, selection, thinking level | ✅ |
| Model roles (read/write, all roles) | ✅ via CLI (whole-record write) |
| Test provider/model | 🟨 CL-implemented tiny prompt |
| Sessions create/resume/page/abort/stream | ✅ |
| Tool tracking | ✅ |
| Approvals | ✅ yolo (`--no-ui`) and non-yolo (select dialogs, verified live in `always-ask`) |
| Context usage, per-session cost | ✅ |
| OMP-recorded usage dashboard | ✅ (24 h window — labelled) |
| Provider quota | ✅ when `omp usage` reports it; otherwise "Unavailable" |
| History > OMP window | ⛔ → M9 |
| Checkpoint/handoff | summary ✅; working tree/env ⛔ (CL builds it) |
