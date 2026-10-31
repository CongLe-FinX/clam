import {
	type Capability,
	type Invitation,
	type NodePreview,
	type OutgoingPairing,
	type PairingRequest,
	type Peer,
	type TunnelMode,
	type TunnelState,
	routes,
} from "@clam/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queries";

// Request bodies as the UI sends them (the contracts export the Zod schemas, not their inferred types).
interface CreateInvitationInput {
	workspaceId: string;
	capabilities: Capability[];
	ttlMinutes: number;
}
interface JoinInput {
	url: string;
	code: string;
	expectedFingerprint: string;
}
export interface TunnelConfigInput {
	mode: TunnelMode;
	hostname?: string | null;
	/** Write-only. Omit to keep the stored token; null deletes it. */
	token?: string | null;
	autoStart?: boolean;
}

const replaceById = <T extends { id: string }>(list: T[] | undefined, item: T): T[] | undefined => list?.map((x) => (x.id === item.id ? item : x));

export function useCreateInvitation() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: CreateInvitationInput) => api.post<Invitation>(routes.invitations, body),
		onSuccess: (inv) => {
			// The plain code lives only in this response — keep it out of the shared cache.
			const { code: _code, ...stored } = inv;
			qc.setQueryData<Invitation[]>(qk.invitations, (d) => (d ? [stored, ...d.filter((x) => x.id !== inv.id)] : [stored]));
		},
	});
}

export function useRevokeInvitation() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.delete(routes.invitation(id)),
		onMutate: async (id) => {
			await qc.cancelQueries({ queryKey: qk.invitations });
			const prev = qc.getQueryData<Invitation[]>(qk.invitations);
			qc.setQueryData<Invitation[]>(qk.invitations, (d) => d?.map((i) => (i.id === id ? { ...i, state: "revoked" } : i)));
			return { prev };
		},
		onError: (e, _id, ctx) => {
			if (ctx?.prev) qc.setQueryData(qk.invitations, ctx.prev);
			toast.error("Could not revoke the invitation", { description: errorMessage(e) });
		},
		onSuccess: () => toast.success("Invitation revoked — its code no longer works"),
		onSettled: () => void qc.invalidateQueries({ queryKey: qk.invitations }),
	});
}

export function useApprovePairing() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, capabilities }: { id: string; capabilities: Capability[] }) => api.post<PairingRequest>(routes.pairingApprove(id), { capabilities }),
		onSuccess: (r) => {
			qc.setQueryData<PairingRequest[]>(qk.pairingRequests, (d) => replaceById(d, r));
			void qc.invalidateQueries({ queryKey: qk.peers });
			void qc.invalidateQueries({ queryKey: qk.invitations });
		},
		onError: (e) => toast.error("Could not approve the request", { description: errorMessage(e) }),
	});
}

export function useRejectPairing() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.post<PairingRequest>(routes.pairingReject(id)),
		onSuccess: (r) => {
			qc.setQueryData<PairingRequest[]>(qk.pairingRequests, (d) => replaceById(d, r));
			void qc.invalidateQueries({ queryKey: qk.invitations });
			toast.success("Request rejected");
		},
		onError: (e) => toast.error("Could not reject the request", { description: errorMessage(e) }),
	});
}

export const useJoinPreview = () => useMutation({ mutationFn: (url: string) => api.post<NodePreview>(routes.joinPreview, { url }) });

export function useJoin() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: JoinInput) => api.post<OutgoingPairing>(routes.join, body),
		onSuccess: (p) => qc.setQueryData<OutgoingPairing[]>(qk.outgoingPairings, (d) => (d ? [p, ...d.filter((x) => x.id !== p.id)] : [p])),
	});
}

/** Optimistic capability/name edit with rollback. */
export function useUpdatePeer() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, ...patch }: { id: string; name?: string; grantedCapabilities?: Capability[]; autoAcceptTasks?: boolean }) => api.patch<Peer>(routes.peer(id), patch),
		onMutate: async ({ id, ...patch }) => {
			await qc.cancelQueries({ queryKey: qk.peers });
			const prev = qc.getQueryData<Peer[]>(qk.peers);
			qc.setQueryData<Peer[]>(qk.peers, (d) => d?.map((p) => (p.id === id ? { ...p, ...patch } : p)));
			return { prev };
		},
		onError: (e, _v, ctx) => {
			if (ctx?.prev) qc.setQueryData(qk.peers, ctx.prev);
			toast.error("Could not update the peer", { description: errorMessage(e) });
		},
		onSuccess: (peer) => qc.setQueryData<Peer[]>(qk.peers, (d) => replaceById(d, peer)),
	});
}

export function useRevokePeer() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.post<Peer>(routes.peerRevoke(id)),
		onSuccess: (peer) => {
			qc.setQueryData<Peer[]>(qk.peers, (d) => replaceById(d, peer));
			void qc.invalidateQueries({ queryKey: qk.directory });
			toast.success(`${peer.name} was revoked`, { description: "It can no longer reach this machine." });
		},
		onError: (e) => toast.error("Could not revoke the peer", { description: errorMessage(e) }),
	});
}

export function useTunnelActions() {
	const qc = useQueryClient();
	const set = (s: TunnelState) => qc.setQueryData(qk.tunnel, s);
	return {
		save: useMutation({ mutationFn: (body: TunnelConfigInput) => api.put<TunnelState>(routes.tunnelConfig, body), onSuccess: set }),
		start: useMutation({ mutationFn: () => api.post<TunnelState>(routes.tunnelStart), onSuccess: set, onError: (e) => toast.error("Could not start the tunnel", { description: errorMessage(e) }) }),
		stop: useMutation({ mutationFn: () => api.post<TunnelState>(routes.tunnelStop), onSuccess: set, onError: (e) => toast.error("Could not stop the tunnel", { description: errorMessage(e) }) }),
	};
}

export const tunnelBusy = (s: TunnelState["state"]): boolean => s === "starting" || s === "running" || s === "reconnecting";
