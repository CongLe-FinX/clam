import { create } from "zustand";
import { persist } from "zustand/middleware";

export type GlobalDialog =
	| { kind: "create-workspace" }
	| { kind: "edit-workspace"; workspaceId: string }
	| { kind: "create-project"; workspaceId?: string; mode?: "existing" | "clone" }
	| { kind: "create-session"; projectId?: string }
	| { kind: "invite-node"; workspaceId?: string }
	| { kind: "join-node" }
	| { kind: "pairing-requests" }
	| { kind: "delegate-task"; workspaceId?: string; projectId?: string; peerId?: string; agentId?: string }
	| { kind: "handover"; sessionId: string; toNodeId?: string }
	| null;

interface UiState {
	sidebarCollapsed: boolean;
	expandedWorkspaces: string[];
	drawerOpen: boolean;
	paletteOpen: boolean;
	dialog: GlobalDialog;
	setSidebarCollapsed(v: boolean): void;
	toggleWorkspaceExpanded(id: string, force?: boolean): void;
	setDrawerOpen(v: boolean): void;
	setPaletteOpen(v: boolean): void;
	openDialog(d: NonNullable<GlobalDialog>): void;
	closeDialog(): void;
}

export const useUi = create<UiState>()(
	persist(
		(set) => ({
			sidebarCollapsed: false,
			expandedWorkspaces: [],
			drawerOpen: false,
			paletteOpen: false,
			dialog: null,
			setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
			toggleWorkspaceExpanded: (id, force) =>
				set((s) => {
					const has = s.expandedWorkspaces.includes(id);
					const want = force ?? !has;
					if (want === has) return s;
					return { expandedWorkspaces: want ? [...s.expandedWorkspaces, id] : s.expandedWorkspaces.filter((x) => x !== id) };
				}),
			setDrawerOpen: (v) => set({ drawerOpen: v }),
			setPaletteOpen: (v) => set({ paletteOpen: v }),
			openDialog: (dialog) => set({ dialog }),
			closeDialog: () => set({ dialog: null }),
		}),
		{
			name: "clam.ui",
			version: 1,
			partialize: (s) => ({ sidebarCollapsed: s.sidebarCollapsed, expandedWorkspaces: s.expandedWorkspaces }),
		},
	),
);
