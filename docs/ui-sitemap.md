# CL Agent Mesh — UI Sitemap and Wireframes

Stack: React 19 + TypeScript + Vite, Tailwind v4, Radix-based shadcn-style primitives, Zustand, TanStack Query, TanStack Router. The UI talks **only** to `/api/local` (REST) and `/ws` (one multiplexed socket); types come from `@clam/contracts`.

Direction: a developer productivity tool (Linear / Vercel / T3 Code caliber), **not** a generic chatbot — dense, hairline borders, layered graphite surfaces, one vivid accent, monospace for ids/paths/tokens, clear node/agent status. Dark by default with a light theme (no flash on load). UX priorities (explicit): desktop **and** mobile excellence, fast load, 60 fps animation (transform/opacity only, 150–250 ms springs, `prefers-reduced-motion` respected), instant response (optimistic UI).

Status legend: **M1** shipped in milestone 1 · **M2…M10** later (shown in navigation as **disabled** entries with a milestone badge; no fake data and no placeholder screens pretending to work).

---

## 1. Sitemap (spec §3.1)

| Navigation entry | Route | M1 status |
| --- | --- | --- |
| **Overview** | `/` | **M1** — node health, agents, runtime status, usage summary. "Tasks" and "network" cards are not rendered with data in M1; they show a disabled card with milestone badge |
| **Workspaces** | `/workspaces` | **M1** (list/create; one default workspace) |
| ↳ `<workspace>` | `/workspaces/:id` | **M1** — Projects tab only |
| ↳ ↳ Projects | `/workspaces/:id/projects` and `/projects/:projectId` | **M1** |
| ↳ ↳ Agents | `/workspaces/:id/agents` | **M1** (this node's agents; remote agents M3) |
| ↳ ↳ Tasks | `/workspaces/:id/tasks` (+ global `/tasks`, `/tasks/:id`) | **M4** — Task Board (incoming / outgoing, status filters), task detail with timeline, discussion thread, delivery state, loop-guard budget, accept/reject/cancel/retry, result with branch / compare URL / patch artifact. **Delegate dialog** entry points: Agent Directory row, peer detail, project ⋯ menu, command palette, Tasks board |
| ↳ ↳ Shared Context | `/workspaces/:id/context` | disabled · **M6** |
| ↳ ↳ Activity | `/workspaces/:id/activity` | **M4** — merged task / message / peer feed (`GET /activity`) |
| **My Node** | `/node` | **M1** |
| ↳ Agent Sessions | `/node/sessions` and `/sessions/:sessionId` | **M1** |
| ↳ Projects | `/node/projects` (alias of project list) | **M1** |
| ↳ Git | `/node/git` | **M2** — every project: branch, ahead/behind, dirty count, last fetch → opens the project Git tab |
| ↳ Runtime | `/node/runtime` | **M1** — runtime processes, restart/stop, logs summary |
| **Terminal** | `/terminal` (`?t=<terminal id>`, `?project=<project id>` opens or reuses a terminal in that folder) | A real shell on this machine (xterm.js, lazy): tabs, folder picker, reattach with scrollback, touch key bar. Off by default through the domain (Settings → Security), step-up password to open one remotely |
| **Agent Network** | `/network` | disabled · **M3** |
| ↳ Connected Nodes | `/network/nodes` | disabled · **M3** |
| ↳ Agent Directory | `/network/agents` | disabled · **M3** |
| ↳ Handoffs (Handoff Center) | `/network/handoffs` | disabled · **M7** |
| **Settings** | `/settings` | **M1** |
| ↳ General | `/settings/general` | **M1** (`NodeSettings`: name, idle timeout, concurrency, approval mode, autostart) |
| ↳ GitHub Accounts | `/settings/github` | **M1** |
| ↳ OMP Providers & Login | `/settings/omp` | **M1** |
| ↳ LLM Usage | `/settings/usage` | **M1** |
| ↳ Agent Runtime | `/settings/runtime` | **M1** (limits, approval mode, OMP path/version) |
| ↳ Cloudflare Tunnel | `/settings/tunnel` | disabled · **M3** (M1 only reports `cloudflared` installed/version via `GET /tunnel`) |
| ↳ Security | `/settings/security` | **M1** (read-only `SecurityInfo`) |
| ↳ About | `/settings/about` | **M1** |
| Command palette | ⌘K / Ctrl+K | **M1** |
| Required screens not in M1 nav: Task Board (M4), Agent Network discovery/pairing (M3), Handoff Center (M7), Shared Context (M6) | | disabled |

Sidebar structure (desktop): Overview · Workspaces (expandable: workspace → Projects, Agents, Tasks🔒, Shared Context🔒, Activity🔒) · My Node (Agent Sessions, Projects, Git, Runtime) · Agent Network🔒 (Connected Nodes, Agent Directory, Handoffs) · Settings (…). 🔒 = disabled with badge.

---

## 2. Layout and panels

### 2.1 Workspace shell (≥ 1280 px)

```
┌────────────┬──────────────────────────────────────────┬───────────────┐
│  Sidebar   │  Center                                  │  Right panel  │
│  (nav,     │  conversation / plan / tool execution    │  context,     │
│  workspace │  or page content                         │  files, diff, │
│  tree,     │                                          │  task details │
│  threads)  │                                          │               │
├────────────┴──────────────────────────────────────────┴───────────────┤
│  Bottom drawer (collapsible): runtime logs · git status · terminal(*) │
└───────────────────────────────────────────────────────────────────────┘
(*) terminal is NOT in M1 and never exposes OMP RPC; the drawer holds Runtime Logs in M1.
```

* Panels are **resizable** (drag handle, keyboard arrow adjust), **collapsible**, and their sizes/open state are **persisted** (local storage, per breakpoint). Defaults: sidebar 264 px, right panel 360 px.
* Center column uses a virtualized message list; composer pinned at the bottom.
* Top bar: breadcrumb (workspace › project › session), node status chip (online/busy/offline/crashed), command palette trigger, theme toggle.

### 2.2 Responsive behaviour

| Breakpoint | Layout |
| --- | --- |
| **≥ 1280 px** (desktop) | Full multi-panel: sidebar + center + right panel (+ bottom drawer). All resizable/collapsible, state persisted |
| **768–1279 px** (tablet) | Sidebar collapses to an **icon rail** (expand on hover/tap as overlay); the right panel becomes an **overlay** sheet from the right (toggle in top bar) |
| **< 768 px** (mobile) | **Single column.** Sidebar becomes a **drawer** (swipe/hamburger). **Bottom tab bar** (Overview · Sessions · Projects · Usage · Settings) with ≥ 44 px targets. The right panel becomes a **bottom sheet** (drag to expand, snap points). The **composer is pinned above the on-screen keyboard** (`visualViewport` resize handling). Safe-area insets (`env(safe-area-inset-*)`) respected. Tables degrade to cards. Command palette opens full-screen |

Cross-cutting: ≥ 44 px touch targets on touch devices; focus rings and ARIA roles everywhere; keyboard shortcuts (⌘K palette, `[` / `]` toggle panels, `⌘↵` send, `Esc` abort/close); skeleton loaders instead of spinners; route-level code splitting with `preload: "intent"`; virtualized long lists (messages, file tree, tables); optimistic mutations with rollback (prompts via `clientId`); stream deltas batched per animation frame; animation limited to transform/opacity.

Initial shell budget ≈ ≤ 180 KB gzip JS (markdown rendering and syntax highlighting lazy-loaded).

Status indicators (consistent everywhere): ● online (green) · ◐ busy (accent, animated pulse via opacity) · ○ offline (grey) · ✕ crashed/error (red). Runtime states map: `ready`→online, `busy`→busy, `stopped`→offline, `crashed`/`restarting`→crashed/amber.

---

## 3. Wireframes

### 3.1 Overview (`/`) — M1

Desktop:

```
┌ Sidebar ┬──────────────────────────────────────────────────────────────┐
│ ◉ Overview │  Overview                                  ● my-macbook  ⌘K │
│ Workspaces │ ┌─ Node health ───────┐ ┌─ OMP ─────────────┐ ┌─ Usage 24h ─┐│
│  …         │ │ ● ok   up 3d 4h     │ │ omp/18.14.0        │ │ 1.2M tokens ││
│ My Node    │ │ runtimes 2/4        │ │ ~/.bun/bin/omp     │ │ $3.41       ││
│ Agent Netw.│ │ mem 412 MB          │ │ providers 3 authed │ │ source: OMP ││
│ Settings   │ └─────────────────────┘ └────────────────────┘ └─────────────┘│
│            │ ┌─ Agents ───────────────────────────────────────────────────┐│
│            │ │ ● OMP Agent  role: Backend   runtime omp   sessions 2      ││
│            │ └────────────────────────────────────────────────────────────┘│
│            │ ┌─ Recent sessions ──────────────────────────────────────────┐│
│            │ │ ◐ Fix auth bug      api-server   claude-sonnet   12:04  ▸ ││
│            │ │ ○ Refactor router   web          gpt-5           11:20  ▸ ││
│            │ └────────────────────────────────────────────────────────────┘│
│            │ ┌─ Tasks ·M4 🔒 ─┐ ┌─ Network ·M3 🔒 ─┐ ┌─ Handoffs ·M7 🔒 ─┐ │
└────────────┴──────────────────────────────────────────────────────────────┘
```

Mobile (single column, bottom tab bar):

```
┌─────────────────────────┐
│ ☰  Overview        ● ⌘ │
├─────────────────────────┤
│ ● ok · runtimes 2/4     │
│ OMP 18.14.0 · 3 authed  │
│ ┌ Usage 24h ──────────┐ │
│ │ 1.2M tok   $3.41    │ │
│ └─────────────────────┘ │
│ Recent sessions         │
│ ◐ Fix auth bug      ▸   │
│ ○ Refactor router   ▸   │
│ [ + New session ]       │
├─────────────────────────┤
│ ⌂   ☰   📁   ▥   ⚙     │
└─────────────────────────┘
```

### 3.2 Project (`/projects/:id`) — M1

```
┌ Sidebar ┬──────────────────────────────────────────────┬──────────────┐
│         │ api-server                    [ + New session ]│ Files        │
│         │ /Users/me/dev/api-server                       │ ▾ src        │
│         │ Repo: ⎇ acme/api-server  (account: acme-dev)   │   ▸ routes   │
│         │        [Change] [Check permissions]            │   index.ts   │
│         │ ────────────────────────────────────────────── │ ▸ docs       │
│         │ Threads (sessions)        search…   ☐ archived │ package.json │
│         │ ◐ Fix auth bug        sonnet · $0.42   12:04   │              │
│         │ ○ Add rate limiter    opus   · $1.10   Mon     │ (preview     │
│         │ ○ Docs pass           —                Sun     │  of selected │
│         │                                                │  file)       │
│         │ Tasks ·M4 🔒                                    │              │
└─────────┴──────────────────────────────────────────────┴──────────────┘
```

Repository card states: *unlinked* (button **Link GitHub repository** → picker dialog: account select, search, list with permissions chips), *linked*, *account missing* (reconnect prompt). File tree is virtualized, read-only in M1 (`projectFiles`, `projectFile`).

Mobile: header + tabs **Sessions | Files | Repo**; the file preview opens as a bottom sheet.

### 3.2a Git panel (project **Git** tab, session **Changes** / **Git** tabs, `/node/git`) — M2

One component (`apps/web/src/features/git`, lazy-loaded so the initial bundle is unaffected) in three places: the project page's **Git** tab (`/projects/:id?tab=git`), the session workspace's right panel (**Changes** tab, with commit attribution to the session) and bottom panel (**Git** tab next to *Runtime log*).

```
┌ ⎇ feature/x ▾  ↑2 ↓1                          [Fetch] [Pull 1] [Push 2] ┐
│ ┌ Pull refused / Push rejected — reason, blocking files, git's words, next step ┐ │
├──────────────────────────────┬────────────────────────────────────────────┤
│ Changes 4 │ History │ PRs │ Repo │ Unstaged 3 │ Staged 1 │ All vs HEAD   ⌃ ⌄ ▤ ⇕ ◫ ▭ │
│ ⛨ Check for conflicts        │ ▾ M README.md                      +3 −0   │
│ CONFLICTED / STAGED / CHANGES│   @@ -1,2 +1,5 @@                          │
│ / UNTRACKED (virtualized)    │   1  1  context                            │
│  + M README.md        ↶      │      3 + added line                        │
│ ┌ message  (⌘/Ctrl+Enter) ┐  │ ▾ U src/hello.ts                   +3      │
│ [Commit (n)▾] [Commit&Push]  │   …                                        │
│ ☺ Name <email> · source  ✎   │                                            │
└──────────────────────────────┴────────────────────────────────────────────┘
```

* **Layout:** desktop ≥ 1280 px = resizable list | diff split; tablet = the diff opens as an overlay panel; mobile = one column, the diff is a pushed detail view (unified only) and the commit box is pinned to the bottom. Side-by-side diff is offered only on viewports ≥ 1024 px.
* **Branch switcher:** local + remote branches, create from the current branch, checkout is never forced — a dirty-overlap refusal shows git's message verbatim plus "nothing was changed".
* **Sync:** Fetch / Pull (fast-forward only) / Push (never forced; *Publish* when the branch has no upstream). A refused pull lists the blocking paths; a rejected push shows the reason, the remote's verbatim message and a suggested next step. Progress comes from `git:<projectId>` operation events.
* **Changes:** grouped Conflicted / Staged / Changes / Untracked, per-file and bulk stage/unstage (optimistic, rolled back on failure), discard only behind a confirm dialog that names the files. Rows slide between groups on live status events (`git:<projectId>`), no list jumps.
* **Diff viewer:** unified/split, collapsible per-file sections with +/− counts, sticky file headers, prev/next file (`n`/`p`) and a file picker, binary / too-large / truncated states, one virtualized list for the whole diff, syntax highlighting loaded lazily per visible file. Scopes: unstaged, staged, all vs HEAD, and a commit picked in **History**.
* **History:** virtualized, infinite; ref decorations and trailers as badges (`Agent: name@node` highlighted).
* **Pull requests:** open/closed/all with draft/checks/mergeable badges and GitHub links; **Create pull request** (base defaults to the repository's default branch, head = current branch, title prefilled from the last commit, draft switch; **Push & create PR** when the branch has no upstream or unpushed commits).
* **Repo:** linked repository card, local checkout facts, remotes, **Initialize `.clmesh`** (written through the secret scanner, never committed).
* **Command palette (project or session in context):** Fetch · Pull · Push · Commit… · Create pull request… · Switch branch…
* **Clone:** *Add project → Clone from GitHub* — account picker, server-side repo search, optional branch, target directory (default `~/clam/<owner>/<repo>` with directory suggestions), progress by phase/percent from `git-op:<id>`, "Run in background", errors inline.

### 3.3 Agent Session (`/sessions/:id`) — M1

Desktop:

```
┌ Sidebar ┬────────────────────────────────────────────┬────────────────┐
│ threads │ Fix auth bug · api-server   ◐ running      │ Context  Files │
│  ◐ Fix… │ model: anthropic/claude-sonnet ▾ thinking ▾│ Plan / Todos   │
│  ○ Add… │ ctx ▓▓▓▓░░░░░░ 38%   $0.42   1.2k tok/s    │  ☑ read routes │
│         │────────────────────────────────────────────│  ◐ patch auth  │
│         │  You                                  12:01│  ☐ add tests   │
│         │  Fix the login redirect loop               │ ────────────── │
│         │                                            │ Tool calls     │
│         │  Agent                                     │  ✓ read auth.ts│
│         │  I'll start by reading the auth routes…    │  ◐ edit auth.ts│
│         │  ┌ tool: read  src/auth.ts      ✓ 120ms ▸┐ │ Usage          │
│         │  ┌ tool: edit  src/auth.ts      ◐ …     ▸┐ │  in 12k out 3k │
│         │                                            │  cache 8k      │
│         │  ┌ Approval needed ───────────────────┐    │                │
│         │  │ edit src/auth.ts   [Approve][Deny] │    │                │
│         │  └────────────────────────────────────┘    │                │
│         │ ┌────────────────────────────────────────┐ │                │
│         │ │ Message…  (steer ▾)      [■ Abort][Send]│ │                │
│         │ └────────────────────────────────────────┘ │                │
├─────────┴────────────────────────────────────────────┴────────────────┤
│ Runtime logs ▸  state: ready · pid 4121 · restarts 0                   │
└────────────────────────────────────────────────────────────────────────┘
```

Behaviours: virtualized transcript, only the streaming message re-renders; thinking blocks collapsed; tool calls collapsed with intent + duration, expandable args/result; approval card appears from `ui_request` events (M1 shows it when the node's approval mode requires it); composer offers *steer / follow-up* when the agent is busy; **Abort** sends `abort`; crashed runtime shows a banner with **Restart**.

Agent surfaces (OMP): the agent's **questions** (`ask`) and approvals appear as a card above the composer, never a modal — one step per question (header chip, option cards with description and optional markdown/code preview, radio vs multi-select, *Recommended* badge, always an "Other" free-text choice, Back/Next, a review step, keys `1`–`9` / `o` / Enter, a countdown when the agent set a timeout), anchored in the conversation by a question card that shows waiting → answered (by whom, in a shared session) / timed out (defaults shown) / cancelled; cancelling stops the agent's turn (OMP aborts the run). While a question waits, the conversation footer says "Waiting for your answer" (in a group chat: "Waiting for an answer") instead of "<agent> is working…". Pending questions add a *Needs you* badge in session/chat lists, a pulsing dot in the sidebar, a toast and (tab hidden, permission granted) a browser notification. A `task` call renders as a **Team** card (one row per subagent: role, model, status, elapsed, live tool line, tokens/cost, Stop and Message) that opens the subagent's transcript (right drawer; full-screen swipe-dismissable sheet on phones) with a steer box; the right panel gets a **Subagents** tab. The plan (`todo`) shows as a sticky **Plan 3/8 · current task** chip above the composer (popover on desktop, bottom sheet on phones), as phases with progress in the Context tab, and each `todo` call as a diff of what it added/started/completed. Shared sessions: the question card shows in the group view of **every** member machine and any person can answer it (first answer wins, the others see "Answered by Person@<machine>"; see [shared-sessions.md §4.2a](./shared-sessions.md#42a-questions-and-approvals-answered-from-any-member-machine) and [omp-rpc-compatibility.md §10](./omp-rpc-compatibility.md#10-ask-subagents-and-the-todo-plan-verified-live-omp-18140)).

Composer (single-agent chat and group chat): **Enter** sends, **Shift+Enter** inserts a newline, an IME composition is never cut by Enter (`isComposing` / keyCode 229); on a touch screen Enter is a newline and the arrow button sends. While the agent works, Enter delivers the way the Steer/Queue switch says, **Ctrl/⌘+Enter** the other way, **Esc** stops the turn (in a group chat Esc closes the @ list). Pictures and files are **pasted** (a clipboard with a picture and no text; a spreadsheet's text + picture pastes as text), **dropped** (an overlay marks the drop target) or picked (several at once) and become chips above the text: thumbnails with a progress bar, remove ×, and retry after a failed upload; sending waits for uploads and for failed ones to be retried or removed. In a single-agent chat every file is saved in the project folder (a taken name becomes `name (n)`), pictures also go to the model as vision input (`PromptBody.images`; scaled to ≤ 2048 px and re-encoded as WebP/JPEG when bigger than the 768 KiB budget; GIF/PNG that fit stay as they are), and the message names each file once in an "Attached files, saved in the project folder:" block that the bubble turns back into file chips; a model whose `input` lacks `image` gets only the file path and the chips say so. In a group chat files are group attachments and the server hands the pictures to each agent as vision input. A paste of more than 8,000 characters or 200 lines offers **Attach as file** (a `.txt`/`.md` upload) or **Keep inline**. Drafts (text plus files already uploaded, with small thumbnails) are kept per chat in `localStorage` (`clam.draft2:session:<id>`, `clam.draft2:group:<id>`, 30 days) across navigation and reloads and cleared on send. Sent messages of people (single-agent bubbles and group messages of humans; never agent replies) taller than about 12 lines (18 rem, 14 rem on a phone; measured, not counted) are clipped with a fade and a **Show more / Show less** button (`aria-expanded`); the expanded state is remembered per message for the life of the page, images and file chips stay visible under the text, and the viewport is anchored (expanding keeps the top of the bubble still, collapsing a bubble whose top is off-screen keeps the button still).

Chat details: assistant text renders markdown with the project folder as its asset root (`![chart](out/chart.png)` loads the file through `projectRaw`). Under the last assistant message of a turn that created or changed files, a **Files from this turn** strip shows them (images as thumbnails, video/audio players, PDF and other types as cards; **Open** reveals the file in the Files panel). The strip comes from `GET /sessions/:id/outputs` plus the live `turn_outputs` event and is matched to rows by `anchorMessageId`, else by `anchorTimestamp`, else the last assistant row at or before `endedAt`. Rows more than 15 minutes apart (or on a new day) get a time divider; consecutive assistant rows sit closer together; only rows that arrive live play the 160 ms enter animation (never on virtualizer remount). While the agent is busy and no text is streaming a three-dot indicator with the agent's name shows at the tail. The scroll position sticks to the bottom only when the user is already there (growth from streamed text, loading media or the mobile keyboard is followed through a `ResizeObserver`), and stays anchored when older pages are prepended. Hovering, focusing or touching a session row preloads its first page of messages so opening it paints immediately. The composer grows to ~8 rows (`field-sizing: content` where supported), accepts attached/pasted/dropped files (uploaded into the project folder and referenced in the draft), and the empty state offers example prompts: research / chart / slideshow-video / PDF for plain chats and folders without a repository, code-review prompts for repositories. **Chats** groups the list by day (Today / Yesterday / previous 7 and 30 days / earlier), adds a search box once there are more than 8 chats and virtualizes past 60 rows.

Mobile:

```
┌─────────────────────────┐
│ ‹ Fix auth bug   ◐  ⋯  │   ⋯ = model, thinking, context sheet
│ ctx ▓▓▓░░░ 38% · $0.42  │
├─────────────────────────┤
│ You                     │
│ Fix the login redirect… │
│ Agent                   │
│ I'll start by reading…  │
│ ▸ read src/auth.ts  ✓   │
│ ▸ edit src/auth.ts  ◐   │
│ ┌ Approve edit? ──────┐ │
│ │ [Deny]     [Approve]│ │
│ └─────────────────────┘ │
├─────────────────────────┤  ← composer pinned above keyboard
│ Message…       [■] [➤] │     (visualViewport), safe-area padded
├─────────────────────────┤
│ ⌂   ☰   📁   ▥   ⚙     │  (hidden while keyboard is open)
└─────────────────────────┘
```

The right-panel content (Plan/Todos, Tool calls, Usage, Files) opens as a bottom sheet from the `⋯` / panel button.

### 3.4 Settings → OMP Providers & Login (`/settings/omp`) — M1

```
┌ Settings ▸ OMP Providers & Login ────────────────────────────────────┐
│ OMP   ● detected   omp/18.14.0   /Users/me/.bun/bin/omp  [Re-detect] │
│ Config: ~/.omp/agent                                                 │
├──────────────────────────────────────────────────────────────────────┤
│ Providers                                         search…            │
│ anthropic        ● authenticated   2 accounts   [Manage ▾] [Logout]  │
│ openai-codex     ● authenticated                [Logout]             │
│ openrouter       ○ not logged in                [Login]              │
│ zai              ○ not logged in   needs terminal login ⓘ            │
│   ⓘ This provider asks for a secret key. Run:  omp login zai  [copy] │
├──────────────────────────────────────────────────────────────────────┤
│ Login flow (anthropic)                                               │
│  1 Open the link → [ https://… ] [Open] [Copy]                       │
│  2 Paste code (if asked):  [______________] [Submit]   [Cancel]      │
├──────────────────────────────────────────────────────────────────────┤
│ Default model   anthropic/claude-opus-5-5  ▾                         │
│ Model roles                                                          │
│  default  [anthropic/claude-opus-5-5   ▾]                            │
│  smol     [— inherits default —        ▾]                            │
│  slow     [— unset —                   ▾]                            │
│  plan     [— unset —                   ▾]                            │
│  commit   [— unset —                   ▾]                            │
│  more roles ▾  task · tiny · advisor · web · vision · memory · …     │
│  [ Test selected model ]   ✓ OK · 840 ms                             │
└──────────────────────────────────────────────────────────────────────┘
```

Provider list from RPC `get_login_providers`; multiple accounts from `get_logout_accounts`; role editor is open-ended (any role OMP returns plus the highlighted five); API-key entry is deliberately absent (explained inline, terminal/env workaround). Mobile: provider rows become cards; login steps as a bottom sheet.

### 3.5 Settings → LLM Usage (`/settings/usage`) — M1

```
┌ Settings ▸ LLM Usage ────────────────────────────────  ⟳ Refresh ───┐
│ Tabs: [Recorded by OMP] [Provider quota] [By project / agent]        │
├──────────────────────────────────────────────────────────────────────┤
│ Recorded by OMP · window: last 24 h · updated 12:03 (stale ⟳)        │
│ ┌ Tokens ┐ ┌ Input ┐ ┌ Output ┐ ┌ Cached ┐ ┌ Est. cost ┐ ┌ Requests ┐ │
│ │ 1.2M   │ │ 900k  │ │ 120k   │ │ 700k   │ │ $3.41     │ │ 214      │ │
│ └────────┘ └───────┘ └────────┘ └────────┘ └───────────┘ └──────────┘ │
│  tokens / hour  ▁▂▃▅▇▆▃▂▁▁▂▄▆█▇▅▃                                    │
│  By provider ▾  By model                                             │
│  anthropic  claude-opus-5-5   in 800k out 90k cache 600k   $2.90     │
│  openai-codex gpt-5           in 100k out 30k cache 100k   $0.51     │
├──────────────────────────────────────────────────────────────────────┤
│ Provider quota (reported by provider via OMP)                        │
│  anthropic   5h window   ▓▓▓▓▓░░░░░ 52% used   resets 15:30          │
│  openai-codex weekly     ▓▓░░░░░░░░ 18% used   resets Mon 00:00      │
│  openrouter  Unavailable — provider exposes no usage via OMP         │
├──────────────────────────────────────────────────────────────────────┤
│ By project / agent (this node, from session stats)                   │
│  api-server  3 sessions  620k tok  $1.90      Agent “OMP Agent” …    │
└──────────────────────────────────────────────────────────────────────┘
```

Every figure carries a provenance chip (`OMP recorded` / `Provider reported` / `CL estimated`); missing data reads **Unavailable**, never a guess. The window of `omp stats` data (24 h per current verification) is stated next to the heading. Mobile: summary tiles scroll horizontally, tables → cards, tabs → segmented control.

### 3.6 Settings → GitHub Accounts (`/settings/github`) — M1

```
┌ Settings ▸ GitHub Accounts ──────────────────────────────────────────┐
│ OAuth client id  [Ov23li…________]  [Save]  ⓘ create OAuth App       │
│ gh CLI           ● available   [Import from gh]                      │
│ [ + Connect with GitHub ]                                            │
│ ┌ Device flow ─────────────────────────────────────────────────────┐ │
│ │ Enter code  WDJB-MJHT  at  github.com/login/device  [Open][Copy]│ │
│ │ ◌ waiting for authorization… expires in 14:32      [Cancel]     │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│ Accounts                                                             │
│ (🙂) acme-dev   ★ default   ● connected   scopes repo, read:user     │
│      dev@acme.io · verified 2 min ago · via oauth-device             │
│      [Verify] [Make default] [Browse repos] [Disconnect]             │
│ (🙂) personal   ● connected  via gh-cli                              │
│ (🙂) old-acct   ✕ invalid — token rejected   [Reconnect] [Disconnect]│
├──────────────────────────────────────────────────────────────────────┤
│ Repositories for acme-dev        search… ▾                           │
│  acme/api-server   private  main   push ✓   [Check] [Use in project] │
│  acme/web          private  main   push ✓   [Check] [Use in project] │
│  Check result: clone ✓  fetch ✓  push ✓  create PR ✓                 │
└──────────────────────────────────────────────────────────────────────┘
```

Mobile: accounts as cards; device code displayed large with one-tap copy and "Open GitHub" button.

### 3.7 Handoff Center (`/network/handoffs`) — **M7, disabled in M1**

Wireframe of the target design (not implemented in M1):

```
┌ Agent Network ▸ Handoffs ─────────────────────────  [ New handoff ] ─┐
│ Tabs: [Active] [History]                                             │
│ ┌ handoff hf_01H… · task “Fix auth bug” ───────────────────────────┐ │
│ │ A my-macbook ──► B win-desktop    epoch 3 → 4        ◐ awaiting  │ │
│ │ ● offered ─ ● accepted ─ ◐ restoring ─ ○ ack ─ ○ released        │ │
│ │ Target steps: ✓ persist ✓ git ✓ context ◐ deps ○ validate ○ session│ │
│ │ Package: commit 3f2a… · patch 14 files · 2 artifacts · summary ✓ │ │
│ │ ⚠ ack not received (deadline 12:34)   [Extend] [Reclaim…] [Cancel]│ │
│ └──────────────────────────────────────────────────────────────────┘ │
│ History: hf_01G… A→C ✓ completed · hf_01F… A→B ✕ failed(deps_failed) │
└──────────────────────────────────────────────────────────────────────┘
```

State and action semantics: [handoff-protocol.md](./handoff-protocol.md).

---

## 4. Global components

* **Command palette** (⌘K): navigate, switch session/project, new session, search sessions (SQLite FTS5 over titles in M1), toggle theme, run runtime actions (stop/restart).
* **Toasts/notices** from `notice` events; **banners** for OMP not installed, runtime crashed, WS disconnected (auto-reconnect indicator).
* **Empty states** are actionable and honest (e.g. "OMP not detected — install it, then Re-detect"), with disabled-feature badges showing the milestone.
* **Theme**: CSS variables tokens, dark default, light supported, preference persisted and applied before first paint.
* **Fonts**: self-hosted variable Inter + JetBrains Mono (ids, paths, tokens).

## Rich chat content (markdown fences)

Assistant markdown (`LazyMarkdown`) renders, all lazily loaded and only when the text needs them: GFM tables/task lists/footnotes, shiki code blocks, KaTeX math (`$…$`, `$$…$$`), ` ```mermaid ` diagrams (strict security level) and ` ```chart ` charts. Relative `![](path)` / `[](path)` resolve through the chat's asset resolver (project files or group attachments); remote http(s) images are shown as click-to-open cards because the CSP only allows `'self' data: blob:` images. A fence renders richly only once closed; while it streams it is a normal code block.

` ```chart ` takes JSON, either rows — `{"type":"bar","title":"…","x":"quarter","y":["a","b"],"xLabel":"…","yLabel":"…","stacked":false,"data":[{"quarter":"Q1","a":1,"b":2}]}` — or Chart.js-like — `{"type":"line","labels":["Mon","Tue"],"datasets":[{"label":"Web","data":[1,2]}]}`. Types: `bar | line | area | pie | donut | scatter` (scatter points: `{"x":1,"y":2}`). `vega-lite` is not supported (shown as code). Full syntax: header comment of `apps/web/src/components/rich/chart.tsx`.
