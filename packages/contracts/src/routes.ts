/**
 * Local UI API (served by apps/server, consumed by apps/web). Prefix `/api/local`.
 * The node-to-node network API (`/api/v1`, spec §8) is separate and arrives in a later milestone.
 *
 * Every route answers JSON. Errors use `ApiErrorBody`.
 */
export const LOCAL_API_PREFIX = "/api/local";

export const routes = {
	// node
	node: "/node", // GET NodeInfo
	health: "/health", // GET NodeHealth
	settings: "/settings", // GET NodeSettings · PATCH NodeSettingsPatch → NodeSettings
	security: "/security", // GET SecurityInfo
	tunnel: "/tunnel", // GET TunnelState
	tunnelConfig: "/tunnel/config", // PUT UpdateTunnelConfigBody → TunnelState
	tunnelStart: "/tunnel/start", // POST → TunnelState
	tunnelStop: "/tunnel/stop", // POST → TunnelState
	tunnelProbe: "/tunnel/probe", // POST → TunnelState (named mode: check now whether another cloudflared already serves the hostname)

	// Owner access to this node's UI through its domain. Login/status answer without a session; everything else needs one remotely.
	access: "/access", // GET AccessStatus · PATCH UpdateAccessBody → AccessStatus (enabling: loopback only; remote sessions may only switch off)
	accessPassword: "/access/password", // PUT SetPasswordBody → AccessStatus
	accessLogin: "/access/login", // POST LoginBody → AccessStatus (sets the session cookie)
	accessLogout: "/access/logout", // POST → 204
	accessLogoutAll: "/access/logout-all", // POST → 204 (invalidates every remote session)
	accessStepUp: "/access/step-up", // POST StepUpBody → AccessStatus (remote session: elevatedUntil = now + ELEVATION_MINUTES)

	// Machine Terminal: real shells on THIS machine (PTYs). Loopback UI always; through the domain only when switched on + step-up. Never relayed through /api/v1.
	// The terminal bytes travel on the dedicated socket `GET /ws/terminal/:id` (see TERMINAL_WS_PATH in terminal.ts), not on /ws.
	terminalInfo: "/terminal", // GET TerminalInfo
	terminalSessions: "/terminal/sessions", // GET TerminalSession[] · POST CreateTerminalBody → TerminalSession (remote: needs step-up)
	terminalSession: (id: string) => `/terminal/sessions/${id}`, // GET TerminalSession · PATCH UpdateTerminalBody → TerminalSession · DELETE → 204 (kills the shell and removes the terminal)

	// Machine Browser: a headless Chromium ON this machine, streamed to the UI (see browser.ts). Loopback UI always; through the domain only when switched on. Never relayed through /api/v1.
	// The pixels and input travel on the dedicated socket `GET /ws/browser/:tabId` (see browserSocketPath in browser.ts), not on /ws.
	browser: "/browser", // GET BrowserStatus
	browserInstall: "/browser/install", // POST → BrowserStatus (installs Chromium into <dataDir>/browsers; progress in BrowserStatus.install, poll `browser`)
	browserTabs: "/browser/tabs", // GET BrowserTab[] · POST OpenTabBody → BrowserTab (starts the browser on first use)
	browserTab: (tabId: string) => `/browser/tabs/${tabId}`, // DELETE → 204
	browserNavigate: (tabId: string) => `/browser/tabs/${tabId}/navigate`, // POST NavigateBody → BrowserTab (bare `localhost:1234` → http://localhost:1234; chrome://, devtools:// and file:// outside project folders → 400 `url_blocked`)
	browserPorts: "/browser/ports", // GET ListeningPort[] (TCP listeners on this machine, excluding this node's own ports)
	browserDownloads: "/browser/downloads", // GET BrowserDownload[]
	browserDownload: (name: string) => `/browser/downloads/${encodeURIComponent(name)}`, // GET the file (attachment)
	browserUpload: (uploadId: string) => `/browser/uploads/${uploadId}`, // PUT raw bytes, ?name=<file name> (repeat for several files) → 204; then send `file-chooser-done` on the tab's socket

	// Preview: this machine's localhost:<port> in the owner's own browser via ONE preview hostname (see preview.ts). Needs a named tunnel + one explicit public hostname in Cloudflare.
	preview: "/preview", // GET PreviewStatus
	previewConfig: "/preview/config", // PUT UpdatePreviewConfigBody → PreviewStatus (loopback UI only: it changes how this node is exposed)
	previewCheck: "/preview/check", // POST → PreviewCheckResult (probes https://<preview host>/__clam_preview/health: must answer from THIS node)
	previewTicket: "/preview/ticket", // POST PreviewTicketBody → PreviewTicket (remote session + Preview switched on; one-time, ≤60 s; 403 `preview_disabled` | `port_not_allowed`)

	// Shared sessions (driver/participants, mirror, checkpoints, takeover)
	sharedSessions: "/shared", // GET SharedSession[]
	sharedSession: (id: string) => `/shared/${id}`, // GET ?messageLimit=N → SharedSessionDetail (without messageLimit: the whole log)
	sessionParticipants: (sessionId: string) => `/sessions/${sessionId}/participants`, // POST AddParticipantBody → SharedSession (shares the session on first use)
	sharedParticipant: (id: string, nodeId: string) => `/shared/${id}/participants/${nodeId}`, // DELETE → SharedSession
	sharedMessages: (id: string) => `/shared/${id}/messages`, // POST PostSharedMessageBody → SharedMessage · GET ?before=<cursor>&limit=1..200 → SharedMessagesPage (newest page when no cursor)
	sharedRead: (id: string) => `/shared/${id}/read`, // POST → 204
	sharedAttachmentUpload: (id: string) => `/shared/${id}/attachments`, // POST raw bytes ?name= (Content-Type = file type) → SharedAttachment (then reference it in PostSharedMessageBody.attachmentIds)
	sharedAttachment: (id: string, attachmentId: string) => `/shared/${id}/attachments/${attachmentId}`, // GET ?download=1 → bytes (Range supported; fetched from a member node when not stored here)
	sharedAttachmentSave: (id: string, attachmentId: string) => `/shared/${id}/attachments/${attachmentId}/save`, // POST SaveAttachmentBody → FileEntry (copy into a local project folder)
	sharedCheckpoint: (id: string) => `/shared/${id}/checkpoint`, // POST CheckpointBody → Checkpoint (driver only)
	sharedTakeover: (id: string) => `/shared/${id}/takeover`, // POST TakeoverBody → SharedSession (participant: continue here)
	sharedTransfer: (id: string) => `/shared/${id}/transfer`, // POST TransferBody → 202 SharedSession (driver: hand over to a participant; progress in SharedSession.transfer) · DELETE → SharedSession (cancel a pending hand-over, or dismiss a finished one)
	sessionHandover: (sessionId: string) => `/sessions/${sessionId}/handover`, // POST TransferBody → 202 SharedSession (shares the session first when it is not shared yet, invites the node, then hands over)
	sharedLeave: (id: string) => `/shared/${id}/leave`, // POST → SharedSession (participant leaves)
	sharedRescuePreview: (id: string) => `/shared/${id}/rescue/preview`, // GET ?projectId → FilesPreview (files mode: the rescue bundle vs a local project)
	sharedRescueApply: (id: string) => `/shared/${id}/rescue/apply`, // POST ApplyFilesBody → FilesApplyResult
	sharedInvites: "/shared/invites", // GET SharedInvite[]
	sharedInviteDecide: (id: string) => `/shared/invites/${id}/decide`, // POST DecideSharedInviteBody → SharedInvite

	// Agent network (M3) — local UI side; the wire protocol lives under /api/v1 on the network listener
	peers: "/network/peers", // GET Peer[]
	peer: (id: string) => `/network/peers/${id}`, // GET Peer · PATCH UpdatePeerBody → Peer
	peerRevoke: (id: string) => `/network/peers/${id}/revoke`, // POST → Peer (immediate, notifies the peer best-effort)
	invitations: "/network/invitations", // GET Invitation[] · POST CreateInvitationBody → Invitation (incl. one-time `code`)
	invitation: (id: string) => `/network/invitations/${id}`, // DELETE → 204 (revokes a pending invitation)
	pairingRequests: "/network/pairing-requests", // GET PairingRequest[]
	pairingApprove: (id: string) => `/network/pairing-requests/${id}/approve`, // POST ApprovePairingBody → PairingRequest
	pairingReject: (id: string) => `/network/pairing-requests/${id}/reject`, // POST → PairingRequest
	joinPreview: "/network/join/preview", // POST JoinPreviewBody → NodePreview
	join: "/network/join", // POST JoinBody → OutgoingPairing · GET → OutgoingPairing[]
	directory: "/network/agents", // GET DirectoryAgent[] (own + every non-revoked peer's cached agents)

	// Tasks & discussion (M4)
	tasks: "/tasks", // GET TaskListQuery → Task[] · POST CreateTaskBody → Task (delivered to the executor through the outbox)
	task: (id: string) => `/tasks/${id}`, // GET TaskDetail
	taskMessages: (id: string) => `/tasks/${id}/messages`, // POST PostTaskMessageBody → TaskMessage
	taskDecide: (id: string) => `/tasks/${id}/decide`, // POST DecideTaskBody → Task (executor side, offered tasks)
	taskCancel: (id: string) => `/tasks/${id}/cancel`, // POST CancelTaskBody → Task (either side; executor aborts the run)
	taskRetry: (id: string) => `/tasks/${id}/retry`, // POST → Task (sender side; a NEW task with retryOf = id)
	taskRead: (id: string) => `/tasks/${id}/read`, // POST → 204 (marks messages read)
	taskArtifact: (id: string, artifactId: string) => `/tasks/${id}/artifacts/${artifactId}`, // GET → artifact bytes (fetched from the executor when needed)
	taskFilesPreview: (id: string) => `/tasks/${id}/files/preview`, // GET ?projectId → FilesPreview (result bundle vs a local project)
	taskFilesApply: (id: string) => `/tasks/${id}/files/apply`, // POST ApplyFilesBody → FilesApplyResult (never overwrites a locally changed file unless listed in `overwrite`)
	activity: "/activity", // GET ?workspaceId&limit&before → ActivityItem[]

	// Handoff (M7): move an in-flight task (or record a shared-session hand-over) with dependency setup + durable ack
	handoffs: "/handoffs", // GET HandoffListQuery → Handoff[] · POST CreateTaskHandoffBody → 202 Handoff (source: the task's executor)
	handoff: (id: string) => `/handoffs/${id}`, // GET HandoffDetail · DELETE → Handoff (source: cancel while offered/accepted/awaiting_ack)
	handoffDecide: (id: string) => `/handoffs/${id}/decide`, // POST DecideHandoffBody → Handoff (target: accept / reject)
	handoffSetup: (id: string) => `/handoffs/${id}/setup`, // POST SetupDecisionBody → Handoff (target: approve / deny setup commands)
	handoffRetry: (id: string) => `/handoffs/${id}/retry`, // POST → Handoff (source: prepare_failed → draft → preparing; target: re-run the failed step)
	handoffExtend: (id: string) => `/handoffs/${id}/extend`, // POST ExtendHandoffBody → Handoff (source: awaiting_ack / ack_timeout)
	handoffReclaim: (id: string) => `/handoffs/${id}/reclaim`, // POST ReclaimHandoffBody → Handoff (source: ack_timeout → reclaimed, tombstone epoch)

	// Context (M6): memory, plans, decisions, summaries — private by default, shareable ones sync to workspace members
	contexts: "/contexts", // GET ContextListQuery → Context[] · POST CreateContextBody → Context
	context: (id: string) => `/contexts/${id}`, // GET Context · PATCH UpdateContextBody → Context · DELETE → 204 (local copy; a shareable one is tombstoned for members)
	contextVersions: (id: string) => `/contexts/${id}/versions`, // GET ContextVersion[]
	contextResolve: (id: string) => `/contexts/${id}/resolve`, // POST ResolveContextConflictBody → Context
	contextSearch: "/contexts/search", // GET ContextSearchQuery → ContextSearchHit[]
	contextExport: (projectId: string) => `/projects/${projectId}/context/export`, // POST → ContextExportResult (git projects; writes .clmesh/, no commit)
	contextImport: (projectId: string) => `/projects/${projectId}/context/import`, // POST → ContextImportResult (git projects; reads .clmesh/)
	workspaceMembers: (workspaceId: string) => `/workspaces/${workspaceId}/members`, // GET WorkspaceMember[] · POST AddWorkspaceMemberBody → WorkspaceMember[]
	workspaceMember: (workspaceId: string, nodeId: string) => `/workspaces/${workspaceId}/members/${nodeId}`, // DELETE → WorkspaceMember[]

	// workspaces & projects
	workspaces: "/workspaces", // GET Workspace[] · POST CreateWorkspaceBody → Workspace
	workspace: (id: string) => `/workspaces/${id}`, // GET · PATCH UpdateWorkspaceBody · DELETE
	projects: "/projects", // GET ?workspaceId → Project[] · POST CreateProjectBody → Project
	project: (id: string) => `/projects/${id}`, // GET · PATCH UpdateProjectBody · DELETE
	projectFiles: (id: string) => `/projects/${id}/files`, // GET ?path= → FileEntry[] (one directory level)
	projectFile: (id: string) => `/projects/${id}/file`, // GET ?path= → FileContent
	projectRaw: (id: string) => `/projects/${id}/raw`, // GET ?path=&download=1 → file bytes with its content type (Range supported: video/audio seek, pdf)
	projectUpload: (id: string) => `/projects/${id}/upload`, // POST raw bytes ?path= (relative, parent dirs created; refuses to overwrite unless &overwrite=1) → FileEntry
	dirSuggestions: "/fs/suggest", // GET ?prefix= → DirSuggestion[]

	// agents & sessions
	agents: "/agents", // GET Agent[]
	agent: (id: string) => `/agents/${id}`, // PATCH UpdateAgentBody → Agent
	sessions: "/sessions", // GET ?projectId&archived → AgentSession[] · POST CreateSessionBody → AgentSession
	session: (id: string) => `/sessions/${id}`, // GET · PATCH UpdateSessionBody · DELETE
	sessionMessages: (id: string) => `/sessions/${id}/messages`, // GET ?cursor&limit → MessagesPage (newest page first when no cursor)
	sessionOutputs: (id: string) => `/sessions/${id}/outputs`, // GET → SessionOutputsPage (files each agent turn created/modified in the project folder)
	sessionState: (id: string) => `/sessions/${id}/state`, // GET SessionLiveState (starts runtime if needed)
	sessionPrompt: (id: string) => `/sessions/${id}/prompt`, // POST PromptBody → PromptAccepted
	sessionAbort: (id: string) => `/sessions/${id}/abort`, // POST → 204
	sessionModel: (id: string) => `/sessions/${id}/model`, // POST SetModelBody → SessionLiveState
	sessionThinking: (id: string) => `/sessions/${id}/thinking`, // POST SetThinkingBody → SessionLiveState
	sessionUiResponse: (id: string) => `/sessions/${id}/ui-response`, // POST UiResponseBody → 204 (on a mirror of a shared session: forwarded to the driver, 409 already_answered when somebody was first)
	sessionUiRequests: (id: string) => `/sessions/${id}/ui-requests`, // GET PendingUiRequest[] (unanswered)
	sessionSubagents: (id: string) => `/sessions/${id}/subagents`, // GET SubagentsPage (live registry, or the last known snapshot while the runtime is stopped)
	sessionSubagentMessages: (id: string, subagentId: string) => `/sessions/${id}/subagents/${subagentId}/messages`, // GET ?fromByte → SubagentMessagesPage (incremental transcript)
	sessionSubagentCancel: (id: string, subagentId: string) => `/sessions/${id}/subagents/${subagentId}/cancel`, // POST → CancelSubagentResult
	sessionSubagentSteer: (id: string, subagentId: string) => `/sessions/${id}/subagents/${subagentId}/steer`, // POST SteerSubagentBody → 204
	runtime: "/runtime", // GET RuntimeStatus[]
	runtimeStop: (sessionId: string) => `/runtime/${sessionId}/stop`, // POST → 204
	runtimeRestart: (sessionId: string) => `/runtime/${sessionId}/restart`, // POST → RuntimeStatus

	// OMP providers & models
	ompProviders: "/omp/providers", // GET ProvidersOverview
	ompProviderAccounts: (providerId: string) => `/omp/providers/${providerId}/accounts`, // GET ProviderAccount[]
	ompLogin: "/omp/login", // POST StartLoginBody → LoginFlow
	ompLoginInput: (flowId: string) => `/omp/login/${flowId}/input`, // POST LoginInputBody → LoginFlow
	ompLoginCancel: (flowId: string) => `/omp/login/${flowId}/cancel`, // POST → LoginFlow
	ompLogout: "/omp/logout", // POST LogoutBody → { remainingSource: string | null }
	ompModels: "/omp/models", // GET ModelInfo[]
	ompModelRoles: "/omp/model-roles", // GET ModelRoles · PUT SetModelRoleBody → ModelRoles
	ompModelTest: "/omp/models/test", // POST ModelTestBody → ModelTestResult

	// usage
	usageRecorded: "/usage/recorded", // GET ?refresh=1 → RecordedUsage
	usageQuota: "/usage/quota", // GET ?refresh=1 → QuotaReport
	usageMesh: "/usage/mesh", // GET MeshUsage

	// GitHub
	githubConfig: "/github/config", // GET GithubConfig · PUT UpdateGithubConfigBody → GithubConfig
	githubDeviceStart: "/github/device", // POST → DeviceFlowStart
	githubDeviceStatus: (flowId: string) => `/github/device/${flowId}`, // GET DeviceFlowStatus
	githubImportGh: "/github/import-gh", // POST → GithubAccount
	githubAccounts: "/github/accounts", // GET GithubAccount[]
	githubAccount: (id: string) => `/github/accounts/${id}`, // DELETE
	githubAccountDefault: (id: string) => `/github/accounts/${id}/default`, // POST → GithubAccount[]
	githubAccountVerify: (id: string) => `/github/accounts/${id}/verify`, // POST → GithubAccount
	githubRepos: (id: string) => `/github/accounts/${id}/repos`, // GET ?q&page → { items: GithubRepo[], nextPage: number | null }
	githubRepoCheck: (id: string, owner: string, repo: string) => `/github/accounts/${id}/repos/${owner}/${repo}/check`, // GET RepoPermissionCheck

	// Git (M2). Mutating operations on one project are serialized server-side; every mutation answers the fresh GitStatus
	// (or a richer result embedding it) and also publishes `git:<projectId>` { type: "status" }.
	projectClone: "/projects/clone", // POST CloneProjectBody → 202 GitOperation (progress + result on topic `git-op:<id>`)
	gitOperation: (opId: string) => `/git/operations/${opId}`, // GET GitOperation
	gitStatus: (projectId: string) => `/projects/${projectId}/git/status`, // GET GitStatus
	gitDiff: (projectId: string) => `/projects/${projectId}/git/diff`, // GET GitDiffQuery → GitDiff
	gitBranches: (projectId: string) => `/projects/${projectId}/git/branches`, // GET GitBranch[] · POST GitCreateBranchBody → GitStatus
	gitCheckout: (projectId: string) => `/projects/${projectId}/git/checkout`, // POST GitCheckoutBody → GitStatus (refused, not forced, when local changes would be overwritten)
	gitLog: (projectId: string) => `/projects/${projectId}/git/log`, // GET ?ref&limit&cursor → GitLogPage
	gitStage: (projectId: string) => `/projects/${projectId}/git/stage`, // POST GitPathsBody → GitStatus
	gitUnstage: (projectId: string) => `/projects/${projectId}/git/unstage`, // POST GitPathsBody → GitStatus
	gitDiscard: (projectId: string) => `/projects/${projectId}/git/discard`, // POST GitDiscardBody → GitStatus
	gitCommit: (projectId: string) => `/projects/${projectId}/git/commit`, // POST GitCommitBody → { commit: GitCommit, status: GitStatus }
	gitFetch: (projectId: string) => `/projects/${projectId}/git/fetch`, // POST → GitStatus
	gitPull: (projectId: string) => `/projects/${projectId}/git/pull`, // POST → GitPullResult (fast-forward only); refused → 409 `git_pull_refused` with GitPullResult in error.details
	gitPush: (projectId: string) => `/projects/${projectId}/git/push`, // POST GitPushBody → GitPushResult (never forced); rejected → 409 `git_push_rejected` (403 permission/sso, 401 auth) with GitPushResult in error.details
	gitConflicts: (projectId: string) => `/projects/${projectId}/git/conflicts`, // GET ?against= → GitConflictReport
	gitIdentity: (projectId: string) => `/projects/${projectId}/git/identity`, // GET GitIdentity · PUT SetGitIdentityBody → GitIdentity
	gitPullRequests: (projectId: string) => `/projects/${projectId}/git/pulls`, // GET ?state=open|closed|all → PullRequest[] · POST CreatePullRequestBody → PullRequest
	gitPullRequest: (projectId: string, num: number) => `/projects/${projectId}/git/pulls/${num}`, // GET PullRequest
	clmeshInit: (projectId: string) => `/projects/${projectId}/clmesh/init`, // POST → ClmeshInitResult (writes, does not commit)
	gitOverview: "/git/overview", // GET { project: Project; status: GitStatus | null; error: string | null }[] for every project on this node
} as const;
