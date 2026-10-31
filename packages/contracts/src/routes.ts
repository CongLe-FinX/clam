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

	// Owner access to this node's UI through its domain. Login/status answer without a session; everything else needs one remotely.
	access: "/access", // GET AccessStatus · PATCH UpdateAccessBody → AccessStatus (loopback only)
	accessPassword: "/access/password", // PUT SetPasswordBody → AccessStatus
	accessLogin: "/access/login", // POST LoginBody → AccessStatus (sets the session cookie)
	accessLogout: "/access/logout", // POST → 204
	accessLogoutAll: "/access/logout-all", // POST → 204 (invalidates every remote session)

	// Shared sessions (driver/participants, mirror, checkpoints, takeover)
	sharedSessions: "/shared", // GET SharedSession[]
	sharedSession: (id: string) => `/shared/${id}`, // GET SharedSessionDetail
	sessionParticipants: (sessionId: string) => `/sessions/${sessionId}/participants`, // POST AddParticipantBody → SharedSession (shares the session on first use)
	sharedParticipant: (id: string, nodeId: string) => `/shared/${id}/participants/${nodeId}`, // DELETE → SharedSession
	sharedMessages: (id: string) => `/shared/${id}/messages`, // POST PostSharedMessageBody → SharedMessage
	sharedRead: (id: string) => `/shared/${id}/read`, // POST → 204
	sharedCheckpoint: (id: string) => `/shared/${id}/checkpoint`, // POST CheckpointBody → Checkpoint (driver only)
	sharedTakeover: (id: string) => `/shared/${id}/takeover`, // POST TakeoverBody → SharedSession (participant: continue here)
	sharedTransfer: (id: string) => `/shared/${id}/transfer`, // POST TransferBody → 202 SharedSession (driver: hand over to a participant; progress in SharedSession.transfer) · DELETE → SharedSession (cancel a pending hand-over, or dismiss a finished one)
	sessionHandover: (sessionId: string) => `/sessions/${sessionId}/handover`, // POST TransferBody → 202 SharedSession (shares the session first when it is not shared yet, invites the node, then hands over)
	sharedLeave: (id: string) => `/shared/${id}/leave`, // POST → SharedSession (participant leaves)
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
	activity: "/activity", // GET ?workspaceId&limit&before → ActivityItem[]

	// workspaces & projects
	workspaces: "/workspaces", // GET Workspace[] · POST CreateWorkspaceBody → Workspace
	workspace: (id: string) => `/workspaces/${id}`, // GET · PATCH UpdateWorkspaceBody · DELETE
	projects: "/projects", // GET ?workspaceId → Project[] · POST CreateProjectBody → Project
	project: (id: string) => `/projects/${id}`, // GET · PATCH UpdateProjectBody · DELETE
	projectFiles: (id: string) => `/projects/${id}/files`, // GET ?path= → FileEntry[] (one directory level)
	projectFile: (id: string) => `/projects/${id}/file`, // GET ?path= → FileContent
	dirSuggestions: "/fs/suggest", // GET ?prefix= → DirSuggestion[]

	// agents & sessions
	agents: "/agents", // GET Agent[]
	agent: (id: string) => `/agents/${id}`, // PATCH UpdateAgentBody → Agent
	sessions: "/sessions", // GET ?projectId&archived → AgentSession[] · POST CreateSessionBody → AgentSession
	session: (id: string) => `/sessions/${id}`, // GET · PATCH UpdateSessionBody · DELETE
	sessionMessages: (id: string) => `/sessions/${id}/messages`, // GET ?cursor&limit → MessagesPage (newest page first when no cursor)
	sessionState: (id: string) => `/sessions/${id}/state`, // GET SessionLiveState (starts runtime if needed)
	sessionPrompt: (id: string) => `/sessions/${id}/prompt`, // POST PromptBody → PromptAccepted
	sessionAbort: (id: string) => `/sessions/${id}/abort`, // POST → 204
	sessionModel: (id: string) => `/sessions/${id}/model`, // POST SetModelBody → SessionLiveState
	sessionThinking: (id: string) => `/sessions/${id}/thinking`, // POST SetThinkingBody → SessionLiveState
	sessionUiResponse: (id: string) => `/sessions/${id}/ui-response`, // POST UiResponseBody → 204
	sessionUiRequests: (id: string) => `/sessions/${id}/ui-requests`, // GET PendingUiRequest[] (unanswered)
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
