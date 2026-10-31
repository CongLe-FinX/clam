import {
	ApprovePairingBody,
	CreateInvitationBody,
	JoinBody,
	JoinPreviewBody,
	UpdatePeerBody,
	routes,
	type DirectoryAgent,
	type Invitation,
	type NodePreview,
	type OutgoingPairing,
	type PairingRequest,
	type Peer,
} from "@clam/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RoutePluginOptions } from "../context.ts";

const IdParams = z.object({ id: z.string().min(1).max(128) });

/** Local UI side of the agent network: peers, invitations, pairing, joining and the agent directory. */
export default async function networkRoutes(app: FastifyInstance, { ctx }: RoutePluginOptions): Promise<void> {
	const net = ctx.network;

	// ------------------------------------------------------------------ peers
	app.get(routes.peers, async (): Promise<Peer[]> => net.peers.list());
	app.get(routes.peer(":id"), async (req): Promise<Peer> => net.peers.require(IdParams.parse(req.params).id));
	app.patch(routes.peer(":id"), async (req): Promise<Peer> => net.peers.update(IdParams.parse(req.params).id, UpdatePeerBody.parse(req.body)));
	app.post(routes.peerRevoke(":id"), async (req): Promise<Peer> => net.revokePeer(IdParams.parse(req.params).id));

	// ------------------------------------------------------------------ invitations (this node is the inviter)
	app.get(routes.invitations, async (): Promise<Invitation[]> => net.invitations.list());
	app.post(routes.invitations, async (req, reply): Promise<Invitation> => {
		const invitation = await net.invitations.create(CreateInvitationBody.parse(req.body));
		return reply.status(201).send(invitation);
	});
	app.delete(routes.invitation(":id"), async (req, reply) => {
		await net.invitations.revoke(IdParams.parse(req.params).id);
		return reply.status(204).send();
	});

	app.get(routes.pairingRequests, async (): Promise<PairingRequest[]> => net.pairing.listRequests());
	app.post(routes.pairingApprove(":id"), async (req): Promise<PairingRequest> => {
		const { id } = IdParams.parse(req.params);
		return net.pairing.approve(id, ApprovePairingBody.parse(req.body).capabilities);
	});
	app.post(routes.pairingReject(":id"), async (req): Promise<PairingRequest> => net.pairing.reject(IdParams.parse(req.params).id));

	// ------------------------------------------------------------------ joining (this node is the joiner)
	app.post(routes.joinPreview, async (req): Promise<NodePreview> => net.pairing.preview(JoinPreviewBody.parse(req.body).url));
	app.post(routes.join, async (req, reply): Promise<OutgoingPairing> => {
		const pairing = await net.pairing.join(JoinBody.parse(req.body));
		return reply.status(201).send(pairing);
	});
	app.get(routes.join, async (): Promise<OutgoingPairing[]> => net.pairing.listJoins());

	// ------------------------------------------------------------------ directory
	app.get(routes.directory, async (req): Promise<DirectoryAgent[]> => {
		// `?refresh=1` re-reads every reachable peer's agents first instead of answering from the cache.
		if ((req.query as { refresh?: string }).refresh === "1") {
			await Promise.all(net.peers.activeRows().filter((p) => p.status !== "offline").map((p) => net.directory.refresh(p.id)));
		}
		return net.directory.list();
	});
}
