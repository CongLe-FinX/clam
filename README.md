English | [Tiếng Việt](README.vi.md)

# CLAM — CL Agent Mesh

> **Distributed AI Agents. One Shared Workspace.**

CLAM (CL Agent Mesh) turns the computers of one person (or a small team) into an AI team. Each computer — a **machine**, called a *node* in the protocol docs — runs AI agents behind a local web UI. The first supported agent runtime is [OMP](https://github.com/can1357/oh-my-pi) (`omp`). Machines pair with each other through your own Cloudflare Tunnel, chat in one group, delegate work to each other's agents, share sessions and memory, and hand unfinished work from one machine to another. A machine going offline never interrupts work that is running on another machine.

![Group chat with an agent, folder sync and a file attachment](docs/screenshots/group-chat-dark.webp)

**Features**

* **Chats without a repository** — talk to an agent about anything (research, writing, images, video); it gets its own folder and you browse, preview and download its files.
* **Group chat across machines** — you and one agent per machine in one shared thread; `@mention` an agent, a machine or everyone.
* **Delegation** — send a task to an agent on another machine, follow it, get the result and the files back.
* **Shared sessions and takeover** — a session on machine A is mirrored live on B; if A goes offline, B continues from the last checkpoint. Or hand a session over while A is online.
* **Handoff with dependency setup** — move a running task to another machine; the target restores the work, installs dependencies (after your approval) and continues. Nothing is released until the target acknowledged.
* **Shared context / memory** — notes, decisions and plans that sync between machines and are told to new agent sessions.
* **Per-machine Terminal and Browser** — a real shell and a real headless browser *on that machine*, usable from any device.
* **Remote access through your own domain** — open any machine's UI from your phone behind an owner password; no ports opened.
* **English and Vietnamese**, light and dark themes, responsive down to a phone.

<table>
  <tr>
    <td><img src="docs/screenshots/chat-dark.webp" alt="Chat with rich agent output (dark)" width="520"></td>
    <td><img src="docs/screenshots/machines-light.webp" alt="Machines page (light)" width="520"></td>
    <td><img src="docs/screenshots/iphone-group-chat-dark.webp" alt="Group chat on an iPhone (dark)" width="150"></td>
  </tr>
</table>

**Contents** — [Requirements](#requirements) · [Install and first run](#install-and-first-run) · [First-time setup in the app](#first-time-setup-in-the-app) · [Connect a second machine](#connect-a-second-machine) · [Use it from your phone](#use-it-from-your-phone) · [Everyday workflows](#everyday-workflows) · [Updating, backup, uninstall](#updating-backup-and-uninstall) · [Troubleshooting](#troubleshooting) · [Development](#development) · [Reference](#reference) · [API walkthrough](docs/api-walkthrough.md)

**Status of platform support.** macOS (Apple Silicon) is the platform the project is developed and tested on. Linux runs in the Docker test bench (Debian, Node 24) — a native Linux install uses the same commands but was not run by the maintainer. **Windows is not tested**: the code has Windows paths (scheduled-task autostart, `netstat` port scan, `cloudflared` via winget) but nothing below marked *Windows* has been verified on a real Windows machine.

---

## Requirements

| Needed | Version | Why |
| --- | --- | --- |
| Node.js | **≥ 22.12** (tested with 24 and 25) | runs the server and the build |
| pnpm | **11** (pinned in `package.json`) | installs the monorepo |
| Git | **≥ 2.38** | the server uses the system `git`; conflict checks need `merge-tree --write-tree` |
| OMP (`omp`) | any recent version; verified with 18.14.0 | the agent runtime. Must be on `PATH` or at `~/.bun/bin/omp` (or set `CLAM_OMP_BIN`) |
| A model provider login | — | OMP needs at least one provider (OpenAI, Anthropic, …) to answer |
| `cloudflared` | optional | needed only to pair machines and for remote access |
| GitHub CLI `gh` | optional | shortcut to import a GitHub login |
| Docker | optional | only for the two-machine test bench in `deploy/docker/` |
| C/C++ toolchain, Python 3, make | only if a prebuilt binary is missing | native addons `better-sqlite3` and `node-pty` |

### macOS

```bash
# Homebrew is assumed (https://brew.sh)
brew install node@24 git                    # or use fnm/nvm below
brew link --overwrite node@24               # only if `node -v` does not show 24 afterwards
npm install -g pnpm@11                      # or `corepack enable` on Node 22/24 (see note)
brew install cloudflared                    # optional, for pairing and remote access
brew install gh                             # optional
xcode-select --install                      # only if a native module fails to build
```

*Verified on macOS (Apple Silicon): Node 25.8, pnpm 11.20, git 2.50 (Apple Git), cloudflared and gh from Homebrew.*

### Linux (Debian / Ubuntu shown)

```bash
sudo apt update && sudo apt install -y git curl ca-certificates build-essential python3
# Node 22 or newer: use fnm (or nvm) so you are not tied to the distro's old Node
curl -fsSL https://fnm.vercel.app/install | bash && exec $SHELL
fnm install 24 && fnm default 24
corepack enable && corepack prepare pnpm@11 --activate     # or: npm install -g pnpm@11
```

* `node-pty` (the Terminal) ships no Linux prebuilds, so it is **compiled during `pnpm install`** — keep `build-essential` and `python3` installed.
* `cloudflared` (optional): follow [Cloudflare's package instructions](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (`sudo apt install cloudflared` after adding their apt repository).
* Secrets use the Secret Service (`secret-tool`, from the `libsecret-tools` package) when a desktop keyring is running; otherwise an encrypted file in the data directory is used automatically.
* The Docker bench proves the whole stack on Debian bookworm + Node 24; see [Docker two-node bench](#docker-two-node-bench).

### Windows — not verified

The steps below are the expected equivalents; **none of them have been run by the maintainer**.

```powershell
winget install OpenJS.NodeJS.LTS Git.Git Cloudflare.cloudflared
npm install -g pnpm@11
irm https://omp.sh/install.ps1 | iex          # OMP, from its own README
```

Secrets fall back to the encrypted-file store (no Windows Credential Manager backend). Autostart is implemented as a scheduled task named "CLAM" but has not been smoke-tested. WSL2 with the Linux instructions is the safer route today.

### Node.js and pnpm notes

* **fnm / nvm**: `fnm install 24 && fnm default 24`, or `nvm install 24 && nvm alias default 24`.
* **pnpm via corepack**: Node 22 and 24 ship `corepack`; run `corepack enable` once and the repo's pinned version (`pnpm@11.20.0`) is used automatically. **Node 25 no longer bundles corepack** (`corepack: command not found`) — install pnpm with `npm install -g pnpm@11` instead.
* The repo lockfile is committed; `pnpm install` is reproducible (`--frozen-lockfile` was verified to pass on a fresh clone).

### OMP (the agent runtime)

Install OMP using the method from its [README](https://github.com/can1357/oh-my-pi#install):

```bash
curl -fsSL https://omp.sh/install | sh          # macOS / Linux
brew install can1357/tap/omp                    # Homebrew alternative
bun install -g @oh-my-pi/pi-coding-agent        # Bun alternative (puts omp in ~/.bun/bin)
```

Then log in to at least one model provider — either in a terminal (`omp login`, choose a provider) or later inside the app (**Settings → OMP Providers**). CLAM never sees your provider credentials; they stay in OMP's own store.

Check: `omp --version`.

---

## Install and first run

```bash
git clone git@github.com:CongLe-FinX/clam.git     # or: git clone https://github.com/CongLe-FinX/clam.git
cd clam               # the repo is private: you need access (SSH key, or `gh auth login` for https)
pnpm install          # ~15 s with a warm cache; compiles native addons if no prebuilt binary exists
pnpm build            # builds the web app and bundles the server to apps/server/dist/main.js (~40 s)
pnpm start            # production mode: the server also serves the built UI
```

Open **http://127.0.0.1:4317**. That is the whole install. *(Exact sequence run on a fresh clone with a custom port and data directory: install, build, start, `GET /` → 200, `GET /api/local/node` → the node's identity JSON.)*

### Ports and exposure

| Port | Listener | Exposure |
| --- | --- | --- |
| **4317** (`CLAM_PORT`) | the web UI + `/api/local` + `/ws` | loopback only — never reachable from another computer |
| **4318** (`CLAM_NETWORK_PORT`, default = `CLAM_PORT` + 1) | `/api/v1` machine-to-machine API (plus the owner-login UI once remote access is on) | loopback only; **this is the origin your Cloudflare tunnel points at** |
| 5317 (`WEB_PORT`) | Vite dev server (`pnpm dev` only) | loopback |

The server refuses to bind anything but `127.0.0.1` / `::1` / `localhost`. Remote access exists only through the Cloudflare Tunnel.

To use other ports: `CLAM_PORT=4400 pnpm start` (the network port becomes 4401 unless you set `CLAM_NETWORK_PORT`). If you change the network port, change the tunnel origin to match.

### Development mode vs production mode

| | `pnpm start` (production) | `pnpm dev` |
| --- | --- | --- |
| Needs `pnpm build` first | yes | no |
| UI | http://127.0.0.1:**4317** | http://127.0.0.1:**5317** (Vite, hot reload; proxies `/api` and `/ws` to 4317) |
| Data directory | `~/.clam` | `<repo>/.data/core` (separate, so dev never touches your real data) |
| Use it for | daily use, autostart | working on the code |

Both default to port 4317 for the server — do not run them at the same time (or give one another `CLAM_PORT`).

### Where your data lives

Default data directory: **`~/.clam`** on macOS and Linux, `%USERPROFILE%\.clam` on Windows (unverified). Change it with `CLAM_DATA_DIR`:

```bash
CLAM_DATA_DIR=/Volumes/Data/clam pnpm start
```

It holds the SQLite database (`clam.db`), the machine's identity keypair (`identity/`), per-session OMP folders, chat/project folders created by the app (`projects/`), attachments, browser profile and downloads, and (only if no OS keychain is used) the encrypted secret file. Full list: [What lives where](#what-lives-where).

### Start at login

1. Run `pnpm build` once (autostart points at `apps/server/dist/main.js`; without a build it fails with `autostart_not_built`).
2. In the UI: **Settings → General → Start automatically** → on.

This writes only the OS login entry and takes effect **at your next login** (it never starts a second server now):

| OS | What is written |
| --- | --- |
| macOS | LaunchAgent `~/Library/LaunchAgents/io.clam.agent-mesh.plist`; logs in `<dataDir>/logs/server.{out,err}.log` — *smoke-verified* |
| Linux | systemd *user* unit `~/.config/systemd/user/cl-agent-mesh.service` (`enable`, never `start`). Without systemd user services the request fails with `autostart_unsupported` — *not smoke-tested* |
| Windows | scheduled task "CLAM" with a logon trigger — *not smoke-tested* |

The login entry records the `CLAM_PORT`, `CLAM_DATA_DIR` and `PATH` of the server you switched it on from. After moving the repository folder, switch it off and on again.

---

## First-time setup in the app

1. **Connect a model provider** — **Settings → OMP Providers**. The page shows whether OMP is installed (if not: install it, then press **Refresh**). In the provider list choose **Connect** next to a provider (search with *Search providers*), authorize in your browser and, if asked, paste the code and press **Submit**. The provider shows **Signed in**.
2. **Pick default model roles** — same page, **Model roles**: set the *Default* role (and any other role OMP lists) with **Set** / **Change**; **Test** sends a real request to check it. The **Model catalog** shows the models your logins give you and their prices.
3. **Connect GitHub (optional)** — **Settings → GitHub Accounts**. Either **Import from gh CLI** (after `gh auth login` in a terminal), or use the device flow: the device flow needs a *GitHub OAuth App client id* — create an OAuth App on GitHub with *Device Flow* enabled, paste its client id under **GitHub OAuth App client id**, **Save**, then **Connect account** and follow the code. Tokens go to the OS secret store only. GitHub is needed only for repository projects, pull requests and branch-based sharing; chats and plain folders work without it.
4. **Name this machine** — **Settings → General → Machine name** (shown to your other machines).
5. **Create a workspace** — in the sidebar press **+** next to **Workspaces** (or *Create your first workspace*). A workspace is the unit you share with another machine.
6. **Start a chat** — **New chat** (top of the sidebar). Describe what the agent should do and press **Start chat**. No repository needed: the agent gets its own folder under `<dataDir>/projects/` and you browse its files in the Files panel. To work on code instead, add a project (a folder, or clone a GitHub repository) in a workspace and open a session in it.
7. **Language and theme** — **Settings → General → Appearance**: **Language** (English / Tiếng Việt) and **Theme** (light / dark / system). They are stored in *this browser*, so phone and desktop can differ.

Safety note: **Settings → General → Tool approval mode** decides whether agents may run shell commands and edit files without asking — leave it on asking until you trust your setup.

---

## Connect a second machine

Do the [install](#install-and-first-run) and [first-time setup](#first-time-setup-in-the-app) on machine **B** too (each machine has its own data directory, OMP login and GitHub account). Two machines can also be two data directories on one computer (distinct `CLAM_PORT`, `CLAM_NETWORK_PORT`, `CLAM_DATA_DIR`).

### 1. Give each machine a public address

Install `cloudflared` first (see [Requirements](#requirements)). Then, on each machine open **Settings → Cloudflare Tunnel**. The page shows the `cloudflared` version (or an install hint per OS) and **Tunnel mode**: *Off*, *Quick tunnel*, *Named tunnel*.

**Quick tunnel** (trying it out, no account): press **Start a quick tunnel**. You get a random `https://<words>.trycloudflare.com` address. It **changes every time the tunnel starts** — paired machines are told automatically, but invitations must use the current address; Cloudflare gives no uptime guarantee and a fresh hostname can need a few seconds to resolve.

**Named tunnel with your own domain** (stable; recommended for phone access). Requires a domain whose DNS is on Cloudflare and a free Cloudflare account. *These dashboard steps follow Cloudflare's current Zero Trust UI and the app's own fields; they were not re-run end-to-end with a real domain for this README, and Cloudflare's menus move around — if a label differs, look for "Tunnels" under Networks.*

1. Cloudflare dashboard → **Zero Trust** → **Networks** → **Tunnels** → **Create a tunnel** → type **Cloudflared** → name it (e.g. `node-a`) → **Save tunnel**.
2. On the "install connector" screen, copy the **token** (the long string after `--token` / `cloudflared service install`). Do **not** run the install command — CLAM runs `cloudflared` itself. Continue.
3. **Public hostname**: add e.g. `node-a.example.com`; service type **HTTP**, URL **`127.0.0.1:4318`** (that is `http://127.0.0.1:4318` — this machine's *network* port, **not** the UI port 4317, and not `https`). Save. (The app's **Origin to configure** field shows the exact value to copy.)
4. In CLAM: **Settings → Cloudflare Tunnel** → **Tunnel mode: Named tunnel** → **Public hostname** `node-a.example.com` → **Tunnel token** paste the token → switch **Start automatically** on if you want it with the server → **Save configuration** → **Start tunnel**. The token goes to the OS secret store (write-only; never shown again).
5. Repeat on machine B with its own tunnel and hostname (e.g. `node-b.example.com`). Each machine needs **its own tunnel and hostname**.

Saved settings are not live until the tunnel is running. **Save configuration** with **Start automatically** on starts a stopped tunnel straight away (and at every server start); with it off, press **Start tunnel**. If another `cloudflared` — yours, outside CLAM — already routes the hostname to `127.0.0.1:4318`, CLAM does not need its own connector: the hostname you save is accepted as the `Host` header, and when `https://<hostname>/api/v1/node/info` answers with this machine's id and fingerprint the page shows **Served by another cloudflared on this machine or network** and that hostname becomes the address used in invitations.

The tunnel exposes only the signed machine-to-machine API (and, if you turn it on, the owner-login UI). `https://<your domain>/api/local/*` always answers 404.

### 2. Pair: Invite on A → Join on B → verify → approve

Open **Machines** in the sidebar (also reachable from **Agent Network**). It offers two paths.

1. **On A — Invite another machine → Create an invitation.** Choose the **workspace to share** and the **code lifetime**, then **Create invitation**. A shows a one-time code `XXXX-XXXX`, A's address and A's **fingerprint** (**Copy everything as a message** puts all three on the clipboard). The code works once, expires (≤ 10 minutes) and locks after 5 wrong attempts. If A has no public address yet the dialog offers to start a quick tunnel.
2. **On B — Join another machine → Enter a code.** Paste A's `https://…` address and press **Look up machine**. B shows the fingerprint of the machine behind that address. **Compare it with the one on A** (read it out or send it over a channel you trust), tick *I compared this fingerprint…*, enter the code and join. B's own tunnel must be running, so A can finish the handshake.
3. **On A — approve.** A shows *A machine wants to connect* (a banner anywhere in the app, and under **Machines → Pairing requests**): compare B's fingerprint with B's screen, choose the access (below) and press **Approve and pair**.

Both machines now pin each other's keys, list each other as **online** in **Machines**, B receives a copy of the shared workspace (same name and id; projects and files are never shared automatically), and each machine's agents appear in **Agent Directory**. **Revoke** on a machine's page cuts it off at once; a revoked machine is re-paired with a new invitation. A stopped machine shows *offline* after about two minutes and reconnects by itself.

### What each access preset grants

Access is **per direction**: what you grant is what the *other* machine may do on *yours*. Presets (**Access presets**, finer checkboxes under *Fine-tune individual permissions*; change any time on the machine's page):

| Preset | Capabilities | Lets the other machine… |
| --- | --- | --- |
| **Chat & collaborate** | `agents.read`, `events.read`, `sessions.share` | see your agents and live status; invite you into shared sessions and group chats |
| **Delegate tasks** | `tasks.send`, `tasks.receive`, `tasks.cancel`, `artifacts.read`, `artifacts.write` | send work to your agents, get results back, exchange the files agents produce (your machine still decides whether to run it) |
| **Share memory** | `context.sync` | keep shared notes/decisions in sync |
| **Hand off work** | `handoff.send`, `handoff.receive` | move whole agent sessions/tasks between you |
| **Full trust** | all of the above and future capabilities | only for machines you own |

For two machines you own, grant all four presets in both directions (each side approves/edits its own grant). Group chat needs *Chat & collaborate* both ways, delegation needs *Delegate tasks*, shared memory *Share memory*, handoff *Hand off work* both ways.

---

## Use it from your phone

Every machine can serve its **own** web UI through its tunnel domain, behind an owner password. It is **off by default** and can only be switched on **at the machine itself** (the loopback UI, `http://127.0.0.1:4317`).

1. Make sure the machine has a tunnel running (**Settings → Cloudflare Tunnel**); a named tunnel with your domain is best because the address stays the same.
2. On the machine: **Settings → Security → Owner password → Set password** (at least 12 characters; the first one can only be set from the machine itself).
3. **Settings → Security → Remote access to this web UI** → switch **on** (confirm *Allow remote access to this UI?*). *Public UI address* shows the URL.
4. On the phone open `https://node-a.example.com/`, enter the owner password. Add it to the home screen for an app-like icon. You now see that machine's UI — its chats, Machines, Settings (remote sessions cannot change the owner password's first value, tunnel or remote-access switch; those stay machine-local).
5. To use another machine's UI (B) open **B's** domain the same way; the *Open B's Terminal / Browser* buttons on a machine's page do exactly that.

**Terminal and Browser through the domain** (off by default): in **Settings → Security → Terminal, Browser and Preview** switch on **Terminal through the domain** and/or **Browser through the domain**; turning one on asks for the owner password (from the machine itself, or from a signed-in remote session). Opening a terminal through the domain asks for the password again (valid 10 minutes). Switching a tool off, logging out or **Sign out everywhere** closes its live connections at once. The sidebar entries are **Terminal** and **Browser**; the Browser can emulate an iPhone viewport so you can test web apps an agent is serving on that machine's `localhost`.

**Security notes**

* Anyone with the owner password can control agents on that machine; with the Terminal on, they run commands as the user running CLAM and reach that machine's whole network. Use a long, unique password; keep Terminal/Browser off unless needed.
* Sign-in is throttled (5 wrong attempts → 30 s lockout doubling up to 15 min, plus a machine-wide lockout against distributed guessing). The session cookie is `HttpOnly`, `Secure`, `SameSite=Strict`; session length is configurable (**Sign-in lasts**) and renews while you use the UI.
* The UI port 4317 is never exposed; the OMP RPC channel is never exposed. Optionally add a Cloudflare Access policy in front of the hostname for a second factor — the machine-to-machine API behind the same hostname uses signed requests, so an Access policy on the whole hostname would also block paired machines (**[INFERENCE]** — not tested; use a path-scoped policy or skip it).
* More: [docs/security.md](docs/security.md).

---

## Preview a local web app

Open a web app that runs on a machine (a Vite / Next / webpack dev server on `localhost:<port>`) in **your own browser** — crisp, smooth, with the real DevTools — from anywhere. The Browser tool (a headless Chromium streamed to the UI) stays for cases that need the machine's own browser.

Each machine gets **one extra address of its own**, by default the first label of its tunnel hostname plus `-preview`: for `clamp-work.example.com` it is `clamp-work-preview.example.com`. You add that single hostname to the machine's tunnel once.

1. **Needs a named tunnel** (**Settings → Cloudflare Tunnel → Named**). A quick tunnel's address changes on every start, so previews are not offered for it (the section explains why). On the machine's own UI (`http://127.0.0.1:4317`) you need none of this: the preview buttons simply open `http://localhost:<port>`.
2. **Settings → Cloudflare Tunnel → Preview in your own browser** shows the *Preview address* (editable) and the exact Cloudflare step. In the Cloudflare dashboard open **Zero Trust → Networks → Tunnels → your tunnel → Public hostname → Add**:
   * *Hostname*: `clamp-work-preview.example.com` (copy it from the page)
   * *Service*: `HTTP` · `127.0.0.1:4318` (the network listener port the page shows)

   No wildcard is needed, and a first-level name next to the tunnel hostname is covered by Cloudflare's free Universal SSL certificate. Two machines on one domain simply get two names (`clamp-work-preview…`, `clamp-home-preview…`), each on its own tunnel — never share one tunnel between machines.
3. Press **Check**: CLAM asks `https://<preview address>/__clam_preview/health` and expects *this* machine (its node id) to answer.
4. **Settings → Security → Terminal, Browser and Preview → Preview through the domain** → switch on (from the machine, or from a signed-in remote session with the owner password; it needs *Remote access to this web UI*). It is **off by default**.
5. Use it: the **Open preview ↗** button next to a *Running on this machine* chip (Browser page), next to a `http://localhost:<port>` link in a chat, or **Open in my browser** in the Browser toolbar. CLAM mints a one-time ticket (valid 60 s) and opens `https://<preview address>/__clam_preview/auth?ticket=…` in a new tab; that sets the preview's own cookie and lands on your app at its natural root (`/`), so client-side routes (`/about`), absolute asset paths (`/assets/…`, `/@vite/client`), API calls and the HMR WebSocket all just work.

**One app at a time per browser.** `https://<preview address>/port/5173/…` selects port 5173 (stored in a cookie) and redirects to `/…`; every other path then goes to that port. Opening another app from CLAM (or visiting `/port/3000/`) switches it. With nothing selected the address shows a small picker of the web apps listening on the machine.

**What is and is not reachable.** Only web apps on the machine's loopback; never CLAM's own UI/network ports, and never databases, SSH, debuggers and similar ports (22, 3306, 5432, 6379, 27017, 9229, 9222, …) or ports below 1024 (except 80). The app sees `Host: localhost:<port>` (so Vite `allowedHosts` and friends accept it), redirects to `http://localhost:<port>/…` are rewritten to the preview address, and cookies stay host-only. Your CLAM cookies are never forwarded to the app.

**Good to know.** All ports of a machine share the preview address's origin (as they share `localhost` cookies): treat apps you preview as one trust domain. Logging out, **Sign out everywhere**, changing the password, switching Preview off or turning remote access off ends every preview session at once. Opens are audited (`preview.open`, `preview.signin`).

---

## Everyday workflows

All of these assume the machines are paired with the matching presets. Each workflow has an API equivalent in the [API walkthrough](docs/api-walkthrough.md).

**Chat with A's and B's agents in one group.** On A: open a chat (or a session) → **Add agent** in the header → pick machine B and optionally an agent from its directory → **Add to session**. The invitation appears on B (**Shared Sessions**, or a banner); accept it. You now have a group chat: one message log both machines keep a copy of. A message without a mention goes to the lead agent; type `@` to address an agent, a machine or everyone; attach files with the paperclip (they land in the receiving agent's folder). Shortcut: finishing pairing offers **Start a group chat with its agents**.

**Delegate a task.** **Agent Directory** → choose an agent → **Delegate** (or **Tasks → Delegate a task**): title, description, optionally the project files to send. Follow progress on the task page, discuss with the agent there, and get a result. If it returned files: **Preview & apply files** shows each file as new / unchanged / update / conflict with diffs; **Apply to project** writes them — nothing is written or deleted before you apply.

**Hand over a session (A online) / take over (A offline).** In a shared session, the driver presses **Hand over…** in the header → **Hand over to** a machine → **Hand over**; everything (including uncommitted files) is saved and the other machine continues in a new session, A becomes a read-only participant. If A is offline, B opens the shared session and presses **Continue on this machine** (confirm **Take over anyway** if A still seems online). Work A did after its last checkpoint is not on B (it is kept as a rescue copy on A).

**Hand off a running task with dependency setup.** On the task page press **Hand off…** → pick the target machine, optionally list setup commands (e.g. `npm ci`) and a check command → **Hand off**. On the target open **Handoffs** (Handoff Center) and accept (or set **Settings → General → Handoffs → Accept handoffs automatically**). **Dependency setup** in the same settings section controls the commands: **Ask me** (each command waits for your approval — recommended), **Run automatically** (only for fully trusted peers), **Never run**. Both machines see the same timeline; the source stays owner until the target's durable acknowledgement arrives (30 min deadline, **Extend** or **Reclaim**).

**Shared memory.** Open a session → the **Memory** panel (or sidebar **Shared Context**) → **Add memory** (types: memory, decision, plan, summary, note). Contexts are **private** until marked *shareable*; shareable ones sync to every machine in the workspace (needs *Share memory* both ways) and new agent sessions start with a short "Project memory" preface. Edits made on two machines at once become a conflict you resolve by hand.

**Files.** In a chat the **Files** panel lists the agent's folder: preview images, video, audio, PDF and text, download, upload. For delegated tasks use **Preview & apply files** as above.

---

## Updating, backup and uninstall

**Update**

```bash
cd clam
git pull
pnpm install
pnpm build
# restart: stop the running server (Ctrl-C), then
pnpm start
```

Database migrations run automatically at startup and a snapshot `clam.db.pre-migrate-<timestamp>.bak` is written first. If autostart is on, log out and in again (or restart the service) after building. Update **all** paired machines to the same version when protocol docs change.

**Backup.** Stop the server and copy the data directory (`~/.clam` by default): database, node identity key, sessions, projects and chat folders. Also keep a note of secrets that live in the OS keychain (GitHub tokens, tunnel token): on a new computer re-enter them (Settings → GitHub Accounts, Cloudflare Tunnel). Restoring the identity on another computer makes it the *same* machine for peers; do not run two copies at once.

**Uninstall**

1. **Settings → General → Start automatically** → off (removes the LaunchAgent / systemd unit / scheduled task). Also stop the tunnel (**Settings → Cloudflare Tunnel → Stop tunnel**) and, in Cloudflare, delete the tunnel and DNS record if you created one.
2. Stop the server.
3. Note the node id (`curl -s http://127.0.0.1:4317/api/local/node` → `id`) **before** deleting data, then remove the data directory: `rm -rf ~/.clam`.
4. Remove keychain entries named `cl-agent-mesh.<nodeId>`: macOS — open *Keychain Access*, search `cl-agent-mesh`, delete the items (or `security delete-generic-password -s cl-agent-mesh.<nodeId> -a <account>` for each); Linux — `secret-tool clear service cl-agent-mesh.<nodeId> account <account>` per entry, or use Seahorse/KWallet. Installs using the encrypted-file store have nothing extra: it is inside the data directory.
5. Delete the repository folder.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| **Port in use** (`EADDRINUSE` on 4317/4318) | Find the owner: `lsof -iTCP:4317 -sTCP:LISTEN` (Windows: `netstat -ano \| findstr 4317`). Stop that process, or start on another port: `CLAM_PORT=4400 pnpm start`. `pnpm dev` and `pnpm start` both default to 4317 — run only one. |
| **`omp` not found** (Settings → OMP Providers says *Not installed*) | Install OMP ([above](#omp-the-agent-runtime)). The server looks on `PATH` and `~/.bun/bin/omp`; a GUI-launched or autostarted server may have a shorter `PATH` — set `CLAM_OMP_BIN=/full/path/to/omp`. Then press **Refresh**. |
| **Provider not signed in**; agents answer with auth errors | **Settings → OMP Providers** → *Not signed in* → **Connect**; or `omp login` in a terminal. Check **Model roles** has a default model from a signed-in provider (**Test**). |
| **`better-sqlite3` / `node-pty` fails to build** | You need a prebuilt binary for your Node version or a toolchain: macOS `xcode-select --install`; Debian/Ubuntu `sudo apt install build-essential python3`. Prefer an LTS/even Node (22 or 24) if a prebuilt binary is missing for brand-new Node releases. Then `pnpm install` again. |
| **`corepack: command not found`** | Node 25+ no longer ships corepack: `npm install -g pnpm@11`. |
| **Tunnel stays "reconnecting" / quick tunnel unreachable** | Check **Settings → Cloudflare Tunnel** shows `cloudflared` installed and the **Network listener** port is the one your hostname routes to (named tunnel: service must be `http://127.0.0.1:4318`, token from that tunnel, hostname exactly as in Cloudflare). A fresh quick-tunnel hostname can take a few seconds to resolve. Corporate proxies/firewalls that block outbound `cloudflared` traffic (it uses outbound 7844/QUIC and HTTPS to Cloudflare) also cause this. Press **Stop tunnel** then **Start tunnel**. |
| **`403 forbidden_host` — "This machine only answers for …" from your hostname** | The network listener answers only for `localhost`, `127.0.0.1`, `[::1]` and the **named hostname saved in Settings → Cloudflare Tunnel**. Open that page and make sure the mode is **Named tunnel** and **Public hostname** is exactly the hostname routed in Cloudflare (CLAM lower-cases it). Saved settings are not live until the tunnel runs: press **Start tunnel**, or switch **Start automatically** on and save (saving then starts it at once). If you run **your own** `cloudflared` for that hostname instead, the saved hostname alone is enough for the Host check, and the page shows **Served by another cloudflared on this machine or network** once `https://<hostname>/api/v1/node/info` is seen answering with this machine's identity (**Check hostname** re-tests on demand; CLAM re-checks every 60 s). Starting CLAM's own connector is then optional. Quick mode knows its random hostname only while its own tunnel runs. |
| **Pairing: code expired / locked / used** | Codes are one-time, ≤ 10 min, locked after 5 wrong tries. On A: **Revoke** the old invitation and create a new one. If A's quick-tunnel address changed since you copied it, copy the new address. |
| **Pairing: "no public address" or B cannot be reached** | Both machines need a running tunnel (B so A can finish the handshake). Without Cloudflare, only for development: `CLAM_ALLOW_LOOPBACK_PEERS=1` on both and `http://127.0.0.1:<network port>` as the address (insecure). |
| **Remote login says locked / too many attempts** | Wait for the lockout (30 s doubling to 15 min); the counters are in memory, so **restarting the server clears them**. Even the right password is refused while locked. |
| **Forgot the owner password** | The UI can change it only with the current one. **[Based on the code, not exercised in a live run]**: stop the server, delete the `access.password` row (`sqlite3 ~/.clam/clam.db "delete from settings where key='access.password';"`), start the server, and set a new password at the machine in **Settings → Security**. Run **Sign out everywhere** afterwards. |
| **macOS keeps asking for Keychain access** | The server stores secrets in your login keychain under service `cl-agent-mesh.<nodeId>`. Choose **Always Allow** for `security`/node when prompted; after upgrading Node or moving the repo the prompt can come back once. To avoid the keychain entirely start with `CLAM_SECRET_BACKEND=encrypted-file` — only on a fresh data dir: the first-chosen backend is pinned in `<dataDir>/secrets/backend`, and secrets do not migrate between backends. |
| **Autostart: `autostart_not_built` / `autostart_unsupported`** | Run `pnpm build` first; on Linux you need `systemd --user`. |
| **UI blank or old after update** | `pnpm build` again, restart, hard-reload the browser. |

---

## Development

```bash
pnpm install
pnpm dev                       # server (4317, tsx watch) + Vite UI (5317), data in <repo>/.data/core
pnpm typecheck                 # tsc in every package
pnpm test                      # vitest in every package that has tests
pnpm build                     # = i18n check + vite build + bundle budget check (web) + tsup (server)
```

| Script | Purpose |
| --- | --- |
| `pnpm --filter @clam/server dev \| build \| start \| test \| typecheck` | server only (`build` bundles `dist/main.js`; migrations are copied to `dist/migrations`) |
| `pnpm --filter @clam/web dev \| build \| preview \| analyze \| typecheck` | web only (`analyze` writes `apps/web/dist/stats.html`) |
| `pnpm --filter @clam/web i18n:check` | verifies every UI string has a Vietnamese translation; also runs inside `pnpm build` and fails it on a miss |
| budget | `pnpm build` of the web app fails when initial JS exceeds **`SHELL_BUDGET_KB`** (default 180 KB gzip; `apps/web/scripts/check-budget.mjs`) |

UI strings are written in English in the source (`t("…")`) with Vietnamese catalogs under `apps/web/src/i18n` and each feature's `i18n/`; conventions: [apps/web/src/i18n/CONVENTIONS.md](apps/web/src/i18n/CONVENTIONS.md).

### Docker two-node bench

`deploy/docker/` runs two isolated Linux machines (A and B) with their own OMP, git, gh, `cloudflared`, data volume and a real quick tunnel as their domain; you drive both from your host browser through their `https://*.trycloudflare.com` URLs. Needs Docker with Compose v2.

```bash
deploy/docker/clam-nodes.sh build      # image
deploy/docker/clam-nodes.sh up         # two containers
deploy/docker/clam-nodes.sh creds      # streams your OMP + gh logins into both
printf '%s' "$PW" | deploy/docker/clam-nodes.sh init a "Node A"   # name, owner password, remote UI, quick tunnel
deploy/docker/clam-nodes.sh down       # deletes containers AND volumes (all credentials)
```

Other subcommands: `init b`, `url`, `status`, `logs`, `stop a`, `start a`, `exec`. Full scenario and credential notes: [deploy/docker/README.md](deploy/docker/README.md).

**Keep the two READMEs in sync:** `README.md` (English) and `README.vi.md` (Vietnamese) cover the same sections and must be updated together.

---

## Reference

### Monorepo layout

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
  handoff-engine/    Pure handoff rules (M7): manifest, source/target state tables, recovery decisions, fencing tokens, environment detection, setup runner, resume prompt
  workspace-files/   Folder bundles for files-mode sharing: scan, tar, diff, preview/apply
  context-engine/    Pure context rules (M6): versions, conflict detection, `.clmesh/` mapping, FTS5 query builder, project-memory preface, sync wire schemas
docs/                Architecture and design documents
```

Planned packages (not yet): `shared-ui` — see the [module dependency diagram](docs/architecture.md#3-module-dependency-diagram).

Package scope is `@clam/*`. Versioned project metadata that may live in a repository is stored under `.clmesh/`.

### Environment variables

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
| `CLAM_BROWSER_PATH` | auto-detected | Explicit Chrome/Chromium/Edge/Brave executable for the machine's Browser |
| `CLAM_BROWSER_IDLE_MS` | `900000` | Close the Browser process after this long with no viewer and no activity |
| `CLAM_BROWSER_NO_SANDBOX` | unset | `1` starts Chromium with `--no-sandbox` (containers without user namespaces; the Docker image sets it). Root on Linux gets it automatically |
| `CLAM_FAULT` | unset | Fault injection for crash tests: `handoff:<role>:<state>[,…]` (`*` wildcards) makes the process exit (code 86) right after that handoff state was saved. Inert when unset |
| `CLAM_LOG_LEVEL` | `info` | pino log level |
| `CLAM_LOG_PRETTY` | on under `pnpm dev`, off otherwise | `1` forces human-readable logs (`pino-pretty`); any other value disables them |
| `CLAM_SECRET_BACKEND` | auto | `auto`, `macos-keychain`, `libsecret` or `encrypted-file`; a forced OS backend that is unusable fails instead of falling back |
| `CLAM_API_URL` | `http://127.0.0.1:4317` | Vite dev proxy target (web dev server only) |
| `WEB_PORT` | `5317` | Vite dev server port (web dev server only) |
| `SHELL_BUDGET_KB` | `180` | Gzip budget for initial JS, enforced by `pnpm --filter @clam/web build` (`scripts/check-budget.mjs`) |
| `ANALYZE` | unset | `1` makes `pnpm --filter @clam/web analyze` write a bundle treemap to `apps/web/dist/stats.html` (`json` → `stats.json`) |

### What lives where

* **Node data:** `<dataDir>/clam.db` (+ `.pre-migrate-<ts>.bak` snapshots), `<dataDir>/run/` (`0700`: git askpass helper and socket; the `tunnel-token` file, `0600`, only while a named tunnel runs), `<dataDir>/sessions/<sessionId>/` (one OMP session directory per CL session), `<dataDir>/identity/` (node keypair), `<dataDir>/secrets/` (only when the encrypted-file store is in use), `<dataDir>/cache/` (usage snapshots). Logs go to stdout.
* **Secrets:** GitHub tokens, the named-tunnel token and (until the joiner's hello is verified) an invitation's derived code key go to the OS secret store (macOS Keychain, Linux Secret Service, otherwise an AES-256-GCM encrypted file — also used on Windows in M1). The node's Ed25519 private key is a `0600` PEM file under `<dataDir>/identity/`. LLM provider credentials stay in OMP's own store; CLAM never reads or writes them.
* **OMP:** driven only through its RPC (`omp --mode rpc`) and documented CLI JSON commands.

### Documentation

| Document | Contents |
| --- | --- |
| [docs/api-walkthrough.md](docs/api-walkthrough.md) | Developer walkthrough per feature with the equivalent `curl`/HTTP calls (git, pairing, tasks, shared sessions, handoff, remote UI, Terminal, Browser) |
| [docs/architecture.md](docs/architecture.md) | Control vs execution plane, module diagram, OMP process model, prompt data flow, deployment, failure model |
| [docs/database-schema.md](docs/database-schema.md) | All tables, M1 subset, `git_sync_states` (M2), network tables (M3), task tables (M4), shared-session tables (M5), no-git columns (0006), context tables + FTS5 (M6, 0007), handoff tables (M7, 0009), migration plan |
| [docs/agent-network-protocol.md](docs/agent-network-protocol.md) | `/api/v1` node-to-node protocol: signing, Host binding, idempotency, ordering, fencing, pairing, tasks and discussion, shared sessions, context sync, handoffs (M3–M7 implemented) |
| [docs/omp-rpc-compatibility.md](docs/omp-rpc-compatibility.md) | Verified OMP 18.14 capabilities, mapped to requirements, with explicit gaps |
| [docs/github-integration.md](docs/github-integration.md) | Device flow, multi-account, credential storage, repo permissions, M2 Git operations, askpass auth, `.clmesh/` layout, context export/import (M6) |
| [docs/shared-sessions.md](docs/shared-sessions.md) | Shared sessions as built (M5): model, flows, checkpoints, takeover, transfer, former driver, data model, errors, limits, try-it |
| [docs/handoff-protocol.md](docs/handoff-protocol.md) | Handoff manifest, state machines, recovery, duplicate-execution prevention, M7 implementation notes |
| [docs/security.md](docs/security.md) | Threat model and controls |
| [docs/ui-sitemap.md](docs/ui-sitemap.md) | Sitemap, responsive layout, wireframes |
| [docs/roadmap.md](docs/roadmap.md) | Reconciled milestones M1–M10, acceptance criteria, M1–M6 checklists |
