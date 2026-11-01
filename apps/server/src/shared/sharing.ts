import type { wire } from "@clam/agent-network";
import { i18nMsg, type SharedInvite, type SharedSession } from "@clam/contracts";
import { agentSessions, agents, peerAgents, projects, workspaceMembers } from "@clam/database";
import { buildSharedBrief, formatParticipant, normalizeRepoUrl, slugify } from "@clam/task-engine";
import { and, eq, isNull } from "drizzle-orm";
import { ApiError } from "../http/errors.ts";
import { KeyedLock, errorText } from "../network/util.ts";
import type { DecideInput, ShareInput, SharedHub, SharingApi } from "./hub.ts";
import { newInviteId, newSharedId, type InviteRow, type SharedRow } from "./store.ts";
import { candidateProjects } from "./views.ts";
import { createManagedProject, projectVcs } from "../services/project-folders.ts";

const NO_GOAL_TITLE = "New session";

type ProjectRow = typeof projects.$inferSelect;

/**
 * Creating a shared session and managing who is in it: sharing a local session (shared branch, invitation), receiving
 * and deciding invitations (auto-accept when the peer's policy allows it and exactly one local project matches), the
 * sessions a participant node gets (a read-only MIRROR of the driver's conversation and, when an agent is assigned, its own
 * briefed PARTICIPANT agent session in the local clone), leaving and removal. Peer calls go through the shared outbox.
 */
export class SharingService implements SharingApi {
	private readonly lock = new KeyedLock();

	constructor(private readonly hub: SharedHub) {}

	private get ctx() {
		return this.hub.ctx;
	}

	private get store() {
		return this.hub.store;
	}

	private get self(): string {
		return this.ctx.identity.nodeId;
	}

	// ------------------------------------------------------------------ driver: sharing and inviting

	addParticipant(sessionId: string, input: ShareInput): Promise<SharedSession> {
		return this.lock.run(`share:${sessionId}`, async () => {
			const session = this.ctx.sessions.get(sessionId);
			if (session.kind === "mirror" || session.movedTo) throw new ApiError(409, "session_read_only", i18nMsg("Only a session that runs on this node can be shared"));
			let shared = session.sharedSessionId ? this.store.find(session.sharedSessionId) : undefined;
			if (shared && (shared.state !== "active" || shared.localRole !== "driver" || shared.localSessionId !== sessionId)) {
				throw new ApiError(409, "not_driver", i18nMsg("Only the driver of a shared session can add participants"));
			}
			const peer = this.ctx.network.peers.row(input.nodeId);
			if (!peer || peer.status === "revoked") throw ApiError.notFound("Peer");
			this.hub.assertShareable(peer.id);
			const project = this.ctx.db.select().from(projects).where(eq(projects.id, session.projectId)).get();
			if (!project) throw ApiError.notFound("Project");
			// A project with a linked GitHub repository that is a git working tree shares through a branch; anything else shares the folder as bundles.
			const linked = project.repository ? normalizeRepoUrl(project.repository.htmlUrl) : null;
			const repo = shared ? (shared.vcs === "git" && shared.repoUrl ? normalizeRepoUrl(shared.repoUrl) : null) : linked && projectVcs(project.path) === "git" ? linked : null;
			const member = this.ctx.db
				.select()
				.from(workspaceMembers)
				.where(and(eq(workspaceMembers.workspaceId, project.workspaceId), eq(workspaceMembers.memberId, peer.id), isNull(workspaceMembers.revokedAt)))
				.get();
			if (!member) throw new ApiError(409, "not_in_workspace", i18nMsg("{name} is not a member of this project's workspace", { name: peer.name }));
			let agentName: string | null = null;
			if (input.agentId) {
				const agent = this.ctx.db
					.select({ name: peerAgents.name })
					.from(peerAgents)
					.where(and(eq(peerAgents.peerId, peer.id), eq(peerAgents.agentId, input.agentId)))
					.get();
				if (!agent) throw new ApiError(404, "not_found", i18nMsg("Agent {agent} is not known on {name}", { agent: input.agentId, name: peer.name }));
				agentName = agent.name;
			}
			const existing = shared ? this.store.participant(shared.id, peer.id) : undefined;
			if (existing && (existing.state === "active" || existing.state === "invited")) {
				throw new ApiError(409, "already_participant", existing.state === "active" ? i18nMsg("{name} is already in this shared session", { name: peer.name }) : i18nMsg("{name} is already invited to this shared session", { name: peer.name }));
			}
			shared ??= repo ? await this.createShared(session, project, repo.url) : await this.createFilesShared(session, project);
			const inviteId = newInviteId();
			const now = new Date().toISOString();
			this.store.upsertParticipant({
				sharedSessionId: shared.id,
				nodeId: peer.id,
				nodeName: peer.name,
				agentId: input.agentId ?? null,
				agentName,
				role: "participant",
				state: "invited",
				agentSessionId: null,
				uiUrl: null,
				snapshotSeq: 0,
				joinedAt: null,
				createdAt: existing?.createdAt ?? now,
			});
			const ownerAgent = this.ctx.db.select({ name: agents.name }).from(agents).where(eq(agents.id, session.agentId)).get();
			const body: wire.SharedInviteRequest = {
				inviteId,
				sharedSessionId: shared.id,
				workspaceId: shared.workspaceId,
				title: shared.title,
				goal: shared.goal,
				vcs: shared.vcs === "files" ? "files" : "git",
				...(shared.vcs !== "files" && shared.repoUrl && shared.branch && { repo: { url: shared.repoUrl, branch: shared.branch, baseBranch: shared.baseBranch, baseCommit: shared.baseCommit } }),
				epoch: shared.epoch,
				...(input.agentId && { targetAgentId: input.agentId }),
				driver: { agentId: session.agentId, agentName: ownerAgent?.name ?? null, uiUrl: this.hub.uiUrl() },
				model: session.model,
			};
			this.hub.enqueue({ peerId: peer.id, sharedSessionId: shared.id, kind: "shared.invite", refId: inviteId, path: "/shared/invites", body });
			this.hub.mirror.publish(shared.id);
			this.hub.changed(shared.id);
			return this.hub.views.shared(this.store.get(shared.id));
		});
	}

	/** First share of a session: shared branch from the project's current HEAD (checked out, pushed), the shared-session rows. */
	private async createShared(session: typeof agentSessions.$inferSelect, project: ProjectRow, repoUrl: string): Promise<SharedRow> {
		const { gitService } = this.ctx;
		const status = await gitService.status(project.id);
		if (!status.isRepo) throw new ApiError(409, "not_a_git_repo", i18nMsg("The session's project directory is not a git repository"));
		if (status.operation) throw new ApiError(409, "git_operation_in_progress", i18nMsg("A {operation} is in progress in the project; finish or abort it first.", { operation: status.operation }));
		const suffix = session.id.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(-6) || "shared";
		const title = session.title === NO_GOAL_TITLE ? "Shared session" : session.title;
		const branch = `clam/shared/${slugify(title, 40)}-${suffix}`;
		try {
			if (status.branch !== branch) {
				const local = (await gitService.branches(project.id)).some((b) => !b.remote && (b.name === branch || b.name === `refs/heads/${branch}`));
				if (local) await gitService.checkout(project.id, branch);
				else await gitService.createBranch(project.id, { name: branch, checkout: true });
			}
			await gitService.push(project.id, { setUpstream: true });
		} catch (error) {
			throw new ApiError(409, "shared_branch_failed", i18nMsg("Could not create and push the shared branch {branch}: {error}", { branch, error: errorText(error, 300) }), { branch });
		}
		const now = new Date().toISOString();
		const owner = this.ctx.db.select({ name: agents.name }).from(agents).where(eq(agents.id, session.agentId)).get();
		const shared = this.store.transaction(() => {
			const row = this.store.insert({
				id: newSharedId(),
				workspaceId: project.workspaceId,
				title,
				goal: title,
				repoUrl,
				branch,
				baseBranch: status.branch,
				baseCommit: status.headSha,
				epoch: 1,
				driverNodeId: this.self,
				driverNodeName: this.hub.nodeName(),
				localRole: "driver",
				state: "active",
				localSessionId: session.id,
				localProjectId: project.id,
				agentMessageLimit: this.hub.options.agentMessageLimit,
			});
			this.store.upsertParticipant({
				sharedSessionId: row.id,
				nodeId: this.self,
				nodeName: this.hub.nodeName(),
				agentId: session.agentId,
				agentName: owner?.name ?? null,
				role: "driver",
				state: "active",
				agentSessionId: session.id,
				uiUrl: null,
				snapshotSeq: 0,
				briefed: true,
				joinedAt: now,
			});
			return row;
		});
		this.ctx.sessions.setSharedSession(session.id, shared.id);
		this.hub.discussion.note(shared.id, i18nMsg("Shared session created by {node} on branch {branch}.", { node: this.hub.nodeName(), branch }));
		return shared;
	}

	/** First share of a session whose project has no git repository (or none linked): no branch, the working folder travels as bundles. */
	private async createFilesShared(session: typeof agentSessions.$inferSelect, project: ProjectRow): Promise<SharedRow> {
		const now = new Date().toISOString();
		const title = session.title === NO_GOAL_TITLE ? "Shared session" : session.title;
		const owner = this.ctx.db.select({ name: agents.name }).from(agents).where(eq(agents.id, session.agentId)).get();
		const shared = this.store.transaction(() => {
			const row = this.store.insert({
				id: newSharedId(),
				workspaceId: project.workspaceId,
				title,
				goal: title,
				vcs: "files",
				repoUrl: null,
				branch: null,
				epoch: 1,
				driverNodeId: this.self,
				driverNodeName: this.hub.nodeName(),
				localRole: "driver",
				state: "active",
				localSessionId: session.id,
				localProjectId: project.id,
				agentMessageLimit: this.hub.options.agentMessageLimit,
			});
			this.store.upsertParticipant({
				sharedSessionId: row.id,
				nodeId: this.self,
				nodeName: this.hub.nodeName(),
				agentId: session.agentId,
				agentName: owner?.name ?? null,
				role: "driver",
				state: "active",
				agentSessionId: session.id,
				uiUrl: null,
				snapshotSeq: 0,
				briefed: true,
				joinedAt: now,
			});
			return row;
		});
		this.ctx.sessions.setSharedSession(session.id, shared.id);
		this.hub.discussion.note(shared.id, i18nMsg("Shared session created by {node} (no git repository: the working folder travels as a bundle with every checkpoint).", { node: this.hub.nodeName() }));
		return shared;
	}

	removeParticipant(sharedId: string, nodeId: string): Promise<SharedSession> {
		return this.lock.run(`membership:${sharedId}`, async () => {
			const shared = this.store.get(sharedId);
			if (shared.state !== "active" || shared.localRole !== "driver") throw new ApiError(409, "not_driver", i18nMsg("Only the driver can remove participants"));
			if (nodeId === this.self) throw ApiError.conflict(i18nMsg("The driver cannot remove itself; transfer the driver role first"));
			const participant = this.store.participant(sharedId, nodeId);
			if (!participant || (participant.state !== "active" && participant.state !== "invited")) throw ApiError.notFound("Participant");
			this.store.updateParticipant(sharedId, nodeId, { state: "removed" });
			const notice: wire.SharedMembershipRequest = { epoch: shared.epoch, action: "remove", nodeId, reason: null };
			// The removed node learns it was removed; the others only update their lists.
			for (const target of this.store.participants(sharedId)) {
				if (target.nodeId === this.self || (target.state !== "active" && target.nodeId !== nodeId)) continue;
				this.hub.enqueue({ peerId: target.nodeId, sharedSessionId: sharedId, kind: "shared.membership", refId: `remove:${nodeId}`, path: `/shared/${sharedId}/membership`, body: notice, idempotencyKey: `shared.membership:${sharedId}:remove:${nodeId}:${target.nodeId}:${Date.now()}`.slice(0, 128) });
			}
			this.hub.discussion.note(sharedId, i18nMsg("{name} was removed from the shared session.", { name: participant.nodeName }));
			this.hub.changed(sharedId);
			return this.hub.views.shared(this.store.get(sharedId));
		});
	}

	// ------------------------------------------------------------------ participant: leaving

	leave(sharedId: string): Promise<SharedSession> {
		return this.lock.run(`membership:${sharedId}`, async () => {
			const shared = this.store.get(sharedId);
			if (shared.state !== "active") return this.hub.views.shared(shared);
			if (shared.localRole === "driver") throw new ApiError(409, "driver_cannot_leave", i18nMsg("The driver cannot leave: transfer the driver role to a participant, or remove the participants first"));
			const notice: wire.SharedMembershipRequest = { epoch: shared.epoch, action: "leave", nodeId: this.self, reason: null };
			// The group hears it from the leaver itself (replicated, queued ahead of the membership notice); the others do not repeat it.
			this.hub.discussion.note(sharedId, i18nMsg("{name} left the shared session.", { name: this.hub.nodeName() }));
			for (const target of this.store.participants(sharedId)) {
				if (target.nodeId === this.self || target.state !== "active") continue;
				this.hub.enqueue({ peerId: target.nodeId, sharedSessionId: sharedId, kind: "shared.membership", refId: `leave:${this.self}`, path: `/shared/${sharedId}/membership`, body: notice, idempotencyKey: `shared.membership:${sharedId}:leave:${this.self}:${target.nodeId}:${Date.now()}`.slice(0, 128) });
			}
			await this.tearDown(shared, "left");
			return this.hub.views.shared(this.store.get(sharedId));
		});
	}

	/** This node stops taking part: the mirror and the participant agent session are archived (history is kept), the row becomes `left`. */
	private async tearDown(shared: SharedRow, state: "left"): Promise<void> {
		this.hub.mirror.unpublish(shared.id);
		const self = this.store.participant(shared.id, this.self);
		const sessionIds = [shared.mirrorSessionId, shared.localRole === "driver" ? null : self?.agentSessionId].filter((id): id is string => id != null);
		for (const id of sessionIds) {
			try {
				this.ctx.sessions.update(id, { archived: true });
			} catch (error) {
				this.hub.log.warn({ err: errorText(error), sessionId: id }, "could not archive a session of the shared session");
			}
		}
		this.store.transaction(() => {
			if (self) this.store.updateParticipant(shared.id, this.self, { state: "left" });
			this.store.update(shared.id, { state, mirrorSessionId: null });
		});
		this.hub.changed(shared.id);
	}

	/** The session service refuses to delete a session that is still part of an active shared session. */
	removeGuard(row: { id: string; kind: string; sharedSessionId: string | null }): void {
		if (!row.sharedSessionId) return;
		const shared = this.store.find(row.sharedSessionId);
		if (!shared || shared.state !== "active") return;
		const self = this.store.participant(shared.id, this.self);
		const inUse = shared.localSessionId === row.id || shared.mirrorSessionId === row.id || (shared.localRole !== "driver" && self?.agentSessionId === row.id);
		if (inUse) throw new ApiError(409, "shared_session_active", i18nMsg("This session is part of an active shared session. Leave (or hand over) the shared session first, then delete it."), { sharedSessionId: shared.id });
	}

	// ------------------------------------------------------------------ participant: receiving invitations

	async receiveInvite(peerId: string, request: wire.SharedInviteRequest): Promise<wire.SharedInviteAccepted & { created: boolean }> {
		// No await before the insert: a concurrent duplicate delivery cannot interleave between the lookup and the insert.
		const known = this.store.invite(request.inviteId);
		if (known) {
			if (known.fromNodeId !== peerId) throw new ApiError(409, "idempotency_conflict", i18nMsg("That invitation id belongs to another sender"));
			return { inviteId: known.id, state: known.state === "accepted" ? "accepted" : known.state === "declined" ? "declined" : "pending", created: false };
		}
		const peer = this.ctx.network.peers.row(peerId);
		if (!peer || peer.status === "revoked") throw new ApiError(403, "forbidden", i18nMsg("The sender is not a paired peer"));
		const member = this.ctx.db
			.select()
			.from(workspaceMembers)
			.where(and(eq(workspaceMembers.workspaceId, request.workspaceId), eq(workspaceMembers.memberId, peerId), isNull(workspaceMembers.revokedAt)))
			.get();
		if (!member) throw new ApiError(403, "forbidden", i18nMsg("The sender is not a member of that workspace on this node"));
		const filesMode = request.vcs === "files";
		const repo = filesMode ? null : request.repo ? normalizeRepoUrl(request.repo.url) : null;
		if (!filesMode && !repo) throw ApiError.badRequest(request.repo ? i18nMsg("repo.url is not a GitHub repository URL") : i18nMsg("A git shared session needs repo (its GitHub repository and shared branch)"));
		if (request.targetAgentId && !this.ompAgent(request.targetAgentId)) throw new ApiError(400, "unknown_agent", i18nMsg("The requested agent does not exist on this node"));
		const local = this.store.find(request.sharedSessionId);
		if (local && local.state === "active") {
			if (local.localRole === "driver" || local.driverNodeId !== peerId) throw ApiError.conflict(i18nMsg("This node already takes part in that shared session"));
			return { inviteId: request.inviteId, state: "accepted", created: false };
		}
		const { row } = this.store.insertInvite({
			id: request.inviteId,
			sharedSessionId: request.sharedSessionId,
			fromNodeId: peerId,
			fromNodeName: peer.name,
			fromAgentId: request.driver.agentId ?? null,
			fromAgentName: request.driver.agentName ?? null,
			title: request.title,
			goal: request.goal,
			vcs: filesMode ? "files" : "git",
			repoUrl: repo?.url ?? null,
			repoBranch: filesMode ? null : (request.repo?.branch ?? null),
			workspaceId: request.workspaceId,
			agentId: request.targetAgentId ?? null,
			epoch: request.epoch,
			driverUiUrl: request.driver.uiUrl ?? null,
			model: request.model ?? null,
		});
		const candidates = repo ? candidateProjects(this.ctx, repo.key) : [];
		const only = candidates.length === 1 ? candidates[0] : undefined;
		let state: wire.SharedInviteAccepted["state"] = "pending";
		// Files mode needs no matching clone: auto-accepting gives the session a managed folder of its own.
		if (peer.autoAcceptTasks && (filesMode || only)) {
			try {
				await this.accept(row, only ? { projectId: only.id } : {});
				state = "accepted";
			} catch (error) {
				this.hub.log.warn({ err: errorText(error), inviteId: row.id }, "auto-accepting a shared session invitation failed; it stays pending");
			}
		}
		this.hub.invitePublished(this.store.getInvite(row.id));
		return { inviteId: row.id, state, created: true };
	}

	private ompAgent(id: string) {
		return this.ctx.db.select().from(agents).where(and(eq(agents.id, id), eq(agents.runtime, "omp"))).get();
	}

	/** The driver's model when this node can run it (the joining agent then works with the same model); otherwise OMP's default. */
	private async usableModel(selector: string | null): Promise<string | null> {
		if (!selector) return null;
		try {
			return (await this.ctx.ompCli.models()).some((m) => m.selector === selector) ? selector : null;
		} catch (error) {
			this.hub.log.debug({ err: errorText(error) }, "could not list models; the joining agent uses the default model");
			return null;
		}
	}

	decide(inviteId: string, input: DecideInput): Promise<SharedInvite> {
		return this.lock.run(`invite:${inviteId}`, async () => {
			const invite = this.store.getInvite(inviteId);
			if (invite.state !== "pending") throw ApiError.conflict(i18nMsg("This invitation is already {state}", { state: invite.state }), { state: invite.state });
			if (input.decision === "decline") {
				const updated = this.store.updateInvite(inviteId, { state: "declined", decidedAt: new Date().toISOString() });
				const body: wire.SharedDecisionRequest = { inviteId, decision: "decline", reason: input.reason ?? null };
				this.hub.enqueue({ peerId: invite.fromNodeId, sharedSessionId: invite.sharedSessionId, kind: "shared.decision", refId: inviteId, path: `/shared/${invite.sharedSessionId}/decision`, body });
				this.hub.invitePublished(updated);
				return this.hub.views.invite(updated);
			}
			const accepted = await this.accept(invite, { projectId: input.projectId, agentId: input.agentId });
			return this.hub.views.invite(accepted);
		});
	}

	/** Git mode: the local clone the user chose, or the only local project of the invitation's repository. */
	private cloneProject(invite: InviteRow, chosen: string | undefined): ProjectRow {
		const key = normalizeRepoUrl(invite.repoUrl ?? "")?.key ?? "";
		const candidates = candidateProjects(this.ctx, key);
		const projectId = chosen ?? (candidates.length === 1 ? candidates[0]?.id : undefined);
		if (!projectId) {
			throw new ApiError(409, "project_required", candidates.length === 0 ? i18nMsg("No local project is linked to this repository; clone it and link it first, or choose a project explicitly") : i18nMsg("Several local projects match this repository; choose one"), {
				candidates: candidates.map((p) => p.id),
			});
		}
		const project = this.ctx.db.select().from(projects).where(eq(projects.id, projectId)).get();
		if (!project) throw ApiError.notFound("Project");
		if (!project.repository || `${project.repository.owner}/${project.repository.name}`.toLowerCase() !== key) {
			throw new ApiError(409, "project_mismatch", i18nMsg("That project is not linked to the shared session's repository"));
		}
		return project;
	}

	/** Files mode: a local project of the invitation's workspace the user chose, or a new managed folder for this session. */
	private folderProject(invite: InviteRow, chosen: string | undefined): ProjectRow {
		if (chosen) {
			const project = this.ctx.db.select().from(projects).where(eq(projects.id, chosen)).get();
			if (!project) throw ApiError.notFound("Project");
			if (project.workspaceId !== invite.workspaceId) throw new ApiError(409, "project_mismatch", i18nMsg("That project belongs to another workspace than the shared session"));
			return project;
		}
		return createManagedProject(this.ctx, { workspaceId: invite.workspaceId, name: `Shared: ${invite.title}`.slice(0, 80), origin: "chat" });
	}

	/** Accept an invitation: local project + agent, the shared-session rows, the mirror, the participant agent session, the answer to the driver. */
	private async accept(invite: InviteRow, choice: { projectId?: string; agentId?: string }): Promise<InviteRow> {
		const filesMode = invite.vcs === "files";
		const agentId = choice.agentId ?? invite.agentId;
		let agent = agentId ? this.ompAgent(agentId) : undefined;
		if (agentId && !agent) throw new ApiError(400, "unknown_agent", i18nMsg("The agent does not exist on this node"));
		agent ??= this.ctx.db.select().from(agents).where(eq(agents.runtime, "omp")).orderBy(agents.createdAt).get();
		const project = filesMode ? this.folderProject(invite, choice.projectId) : this.cloneProject(invite, choice.projectId);

		const now = new Date().toISOString();
		const nodeName = this.hub.nodeName();
		const existing = this.store.find(invite.sharedSessionId);
		const shared = this.store.transaction(() => {
			const values = {
				workspaceId: invite.workspaceId,
				title: invite.title,
				goal: invite.goal,
				vcs: filesMode ? "files" : "git",
				repoUrl: invite.repoUrl,
				branch: invite.repoBranch,
				epoch: invite.epoch,
				driverNodeId: invite.fromNodeId,
				driverNodeName: invite.fromNodeName,
				localRole: "participant",
				state: "active",
				localProjectId: project.id,
				mirrorSessionId: null,
				localSessionId: null,
				agentMessageLimit: this.hub.options.agentMessageLimit,
			};
			const row = existing ? this.store.update(existing.id, values) : this.store.insert({ id: invite.sharedSessionId, ...values });
			this.store.upsertParticipant({ sharedSessionId: row.id, nodeId: invite.fromNodeId, nodeName: invite.fromNodeName, agentId: invite.fromAgentId, agentName: invite.fromAgentName, role: "driver", state: "active", agentSessionId: null, uiUrl: invite.driverUiUrl, snapshotSeq: 0, joinedAt: null });
			this.store.upsertParticipant({ sharedSessionId: row.id, nodeId: this.self, nodeName, agentId: agent?.id ?? null, agentName: agent?.name ?? null, role: "participant", state: "active", agentSessionId: null, uiUrl: null, snapshotSeq: 0, briefed: false, joinedAt: now });
			return row;
		});
		const mirrorId = this.ensureMirror(shared);
		let agentSessionId: string | null = null;
		if (agent) {
			const model = await this.usableModel(invite.model);
			agentSessionId = this.ctx.sessions.create({ projectId: project.id, title: `Shared: ${invite.title}`.slice(0, 120), ...(model && { model }) }, { agentId: agent.id, sharedSessionId: shared.id }).id;
			this.store.updateParticipant(shared.id, this.self, { agentSessionId });
		}
		const updated = this.store.updateInvite(invite.id, { state: "accepted", decidedAt: now });
		const body: wire.SharedDecisionRequest = {
			inviteId: invite.id,
			decision: "accept",
			agent: agent ? { agentId: agent.id, agentName: agent.name } : null,
			agentSessionId,
			uiUrl: this.hub.uiUrl(),
		};
		this.hub.enqueue({ peerId: invite.fromNodeId, sharedSessionId: shared.id, kind: "shared.decision", refId: invite.id, path: `/shared/${shared.id}/decision`, body });
		this.hub.invitePublished(updated);
		this.hub.changed(shared.id);
		this.hub.log.info({ sharedId: shared.id, mirrorId }, "joined a shared session");
		void this.briefPending();
		return updated;
	}

	// ------------------------------------------------------------------ driver: decisions, membership notices

	async receiveDecision(peerId: string, sharedId: string, request: wire.SharedDecisionRequest): Promise<void> {
		const shared = this.store.find(sharedId);
		if (!shared || shared.state !== "active" || shared.localRole !== "driver") throw ApiError.notFound("Shared session");
		const participant = this.store.participant(sharedId, peerId);
		if (!participant) throw ApiError.notFound("Participant");
		if (request.decision === "decline") {
			if (participant.state === "invited") {
				this.store.updateParticipant(sharedId, peerId, { state: "declined" });
				this.hub.discussion.note(sharedId, request.reason ? i18nMsg("{name} declined the invitation: {reason}", { name: participant.nodeName, reason: request.reason }) : i18nMsg("{name} declined the invitation.", { name: participant.nodeName }));
				this.hub.changed(sharedId);
			}
			return;
		}
		const wasActive = participant.state === "active";
		this.store.updateParticipant(sharedId, peerId, {
			state: "active",
			agentId: request.agent?.agentId ?? participant.agentId,
			agentName: request.agent?.agentName ?? participant.agentName,
			agentSessionId: request.agentSessionId ?? participant.agentSessionId,
			uiUrl: request.uiUrl ?? participant.uiUrl,
			joinedAt: participant.joinedAt ?? new Date().toISOString(),
		});
		if (!wasActive) {
			// The newcomer gets the thread so far (stored, not injected), the live conversation and the latest snapshot.
			for (const message of this.store.messages(sharedId)) this.hub.discussion.enqueue(message, peerId);
			this.hub.discussion.note(sharedId, request.agent ? i18nMsg("{name} joined the shared session with {agent}.", { name: participant.nodeName, agent: request.agent.agentName }) : i18nMsg("{name} joined the shared session.", { name: participant.nodeName }));
		}
		this.hub.mirror.publish(sharedId);
		this.hub.mirror.syncPeer(sharedId, peerId);
		this.hub.checkpoints.shipLatest(sharedId, peerId);
		this.hub.changed(sharedId);
	}

	async receiveMembership(peerId: string, sharedId: string, request: wire.SharedMembershipRequest): Promise<void> {
		const shared = this.store.find(sharedId);
		if (!shared || shared.state !== "active") throw ApiError.notFound("Shared session");
		const sender = this.store.participant(sharedId, peerId);
		if (!sender) throw new ApiError(403, "forbidden", i18nMsg("Only participants of the shared session may change its membership"));
		if (request.action === "leave") {
			if (request.nodeId !== peerId) throw new ApiError(403, "forbidden", i18nMsg("A node can only announce its own departure"));
			if (sender.state === "active" || sender.state === "invited") {
				this.store.updateParticipant(sharedId, peerId, { state: "left" });
				this.hub.changed(sharedId);
			}
			return;
		}
		if (peerId !== shared.driverNodeId) throw new ApiError(403, "forbidden", i18nMsg("Only the driver may remove a participant"));
		if (request.epoch < shared.epoch) throw new ApiError(409, "stale_epoch", i18nMsg("The notice carries epoch {epoch}; the shared session is at epoch {current}", { epoch: request.epoch, current: shared.epoch }), { currentEpoch: shared.epoch });
		if (request.nodeId === this.self) {
			await this.tearDown(shared, "left");
			this.hub.discussion.note(sharedId, i18nMsg("{name} removed this node from the shared session.", { name: sender.nodeName }), { local: true });
			return;
		}
		const removed = this.store.participant(sharedId, request.nodeId);
		if (removed && removed.state !== "removed") {
			this.store.updateParticipant(sharedId, request.nodeId, { state: "removed" });
			this.hub.changed(sharedId);
		}
	}

	// ------------------------------------------------------------------ sessions of a participant node

	ensureMirror(shared: SharedRow): string {
		const current = this.store.get(shared.id);
		if (current.mirrorSessionId) return current.mirrorSessionId;
		if (!current.localProjectId) throw ApiError.conflict(i18nMsg("No local clone is linked to this shared session"));
		const self = this.store.participant(shared.id, this.self);
		const session = this.ctx.sessions.createMirror({
			projectId: current.localProjectId,
			agentId: self?.agentId ?? null,
			title: `${current.title} · live from ${current.driverNodeName}`,
			sharedSessionId: shared.id,
		});
		// The participant's view of the shared session IS the mirror; a former driver keeps its moved copy as `localSessionId`.
		this.store.update(shared.id, { mirrorSessionId: session.id, ...(current.localRole === "participant" && { localSessionId: session.id }) });
		return session.id;
	}

	/** The participant agent session of this node for `sharedId`, created when the node has an agent and none exists yet. */
	ensureParticipantAgent(sharedId: string): string | null {
		const shared = this.store.get(sharedId);
		if (shared.state !== "active" || shared.localRole === "driver" || !shared.localProjectId) return null;
		const self = this.store.participant(sharedId, this.self);
		if (!self) return null;
		if (self.agentSessionId && self.agentSessionId !== shared.localSessionId) {
			const live = this.ctx.db.select({ archived: agentSessions.archived, kind: agentSessions.kind, movedTo: agentSessions.movedTo }).from(agentSessions).where(eq(agentSessions.id, self.agentSessionId)).get();
			if (live && !live.archived && live.kind === "local" && !live.movedTo) return self.agentSessionId;
		}
		const agent = (self.agentId ? this.ompAgent(self.agentId) : undefined) ?? this.ctx.db.select().from(agents).where(eq(agents.runtime, "omp")).orderBy(agents.createdAt).get();
		if (!agent) return null;
		const created = this.ctx.sessions.create({ projectId: shared.localProjectId, title: `Shared: ${shared.title}`.slice(0, 120) }, { agentId: agent.id, sharedSessionId: shared.id });
		this.store.updateParticipant(sharedId, this.self, { agentSessionId: created.id, agentId: agent.id, agentName: agent.name, briefed: false });
		return created.id;
	}

	async briefPending(): Promise<void> {
		for (const shared of this.store.active()) {
			if (shared.localRole === "driver") continue;
			const self = this.store.participant(shared.id, this.self);
			if (!self?.agentSessionId || self.briefed) continue;
			const driver = this.store.participant(shared.id, shared.driverNodeId);
			const others = this.store
				.participants(shared.id)
				.filter((p) => p.state === "active" && p.nodeId !== this.self && p.nodeId !== shared.driverNodeId)
				.map((p) => formatParticipant({ agentName: p.agentName, nodeName: p.nodeName }));
			const message = buildSharedBrief({
				sharedSessionId: shared.id,
				title: shared.title,
				goal: shared.goal,
				driver: { agentName: driver?.agentName ?? null, nodeName: shared.driverNodeName },
				self: { agentName: self.agentName, nodeName: this.hub.nodeName() },
				repo: shared.repoUrl && shared.branch ? { url: shared.repoUrl, branch: shared.branch } : null,
				others,
				agentMessageLimit: shared.agentMessageLimit,
			});
			try {
				await this.ctx.sessions.prompt(self.agentSessionId, { message, clientId: `shared_brief_${shared.id}_${shared.epoch}` });
				this.store.updateParticipant(shared.id, this.self, { briefed: true });
			} catch (error) {
				this.hub.log.warn({ err: errorText(error), sharedId: shared.id }, "could not brief the participant agent session");
			}
		}
	}
}
