import type { GitOperation } from "@clam/contracts";
import { create } from "zustand";

export type BusyOp = "fetch" | "pull" | "push" | "commit" | "commit-push" | "checkout" | "branch" | "clmesh";

/** A persistent, dismissible result that needs more than a toast (refusals, rejections, verbatim remote messages). */
export interface GitNotice {
	id: number;
	tone: "error" | "warning" | "success" | "info";
	title: string;
	/** Plain-language explanation of what happened and that nothing was lost. */
	body?: string;
	/** Local paths that caused the refusal. */
	paths?: string[];
	/** Verbatim message from git / GitHub. */
	detail?: string;
	/** Suggested next step. */
	next?: string;
}

/** Something the command palette asks the Git panel to do after navigating to it. */
export type GitIntent = "commit" | "create-pr" | "switch-branch";

interface GitUiState {
	busy: Record<string, BusyOp | null | undefined>;
	notices: Record<string, GitNotice | null | undefined>;
	operations: Record<string, GitOperation | null | undefined>;
	drafts: Record<string, string | undefined>;
	intent: { projectId: string; action: GitIntent; nonce: number } | null;
	setBusy(projectId: string, op: BusyOp | null): void;
	setNotice(projectId: string, notice: Omit<GitNotice, "id"> | null): void;
	setOperation(projectId: string, op: GitOperation | null): void;
	setDraft(projectId: string, message: string): void;
	requestIntent(projectId: string, action: GitIntent): void;
	clearIntent(): void;
}

let noticeId = 0;

export const useGitUi = create<GitUiState>()((set) => ({
	busy: {},
	notices: {},
	operations: {},
	drafts: {},
	intent: null,
	setBusy: (projectId, op) => set((s) => ({ busy: { ...s.busy, [projectId]: op } })),
	setNotice: (projectId, notice) => set((s) => ({ notices: { ...s.notices, [projectId]: notice ? { ...notice, id: ++noticeId } : null } })),
	setOperation: (projectId, op) => set((s) => ({ operations: { ...s.operations, [projectId]: op } })),
	setDraft: (projectId, message) => set((s) => ({ drafts: { ...s.drafts, [projectId]: message } })),
	requestIntent: (projectId, action) => set({ intent: { projectId, action, nonce: Date.now() } }),
	clearIntent: () => set({ intent: null }),
}));
