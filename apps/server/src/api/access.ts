import { LoginBody, SetPasswordBody, UpdateAccessBody, routes, type AccessStatus } from "@clam/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IssuedSession } from "../auth/service.ts";
import { clearedSessionCookie, sessionCookie } from "../auth/token.ts";
import type { RoutePluginOptions } from "../context.ts";
import { ApiError } from "../http/errors.ts";

const LOOPBACK_ONLY = "This can only be changed from the machine this node runs on (the local UI)";

/** The client a login attempt is charged to: the real address behind the tunnel (see docs/security.md on why that header is trustworthy here). */
function clientOf(request: FastifyRequest): string {
	const forwarded = request.headers["cf-connecting-ip"];
	return request.access.via === "remote" && typeof forwarded === "string" && forwarded.length > 0 ? forwarded.slice(0, 64) : request.ip;
}

/** Owner access (remote UI): status, enable/disable, password, login/logout. See `auth/gate.ts` for who may call what and from where. */
export default async function accessRoutes(app: FastifyInstance, { ctx }: RoutePluginOptions): Promise<void> {
	const { access } = ctx;

	/** Run a throttled check; a 429 carries `Retry-After` as well as the body field. */
	async function throttled<T>(reply: FastifyReply, run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (error) {
			if (error instanceof ApiError && error.status === 429) {
				const wait = (error.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
				if (wait) reply.header("Retry-After", String(wait));
			}
			throw error;
		}
	}

	const sendCookie = (reply: FastifyReply, issued: IssuedSession): void => {
		reply.removeHeader("set-cookie"); // the gate may have queued a "drop the stale cookie" header
		reply.header("Set-Cookie", sessionCookie(issued.token, issued.maxAgeSeconds));
	};

	app.get(routes.access, async (request): Promise<AccessStatus> => access.status(request.access));

	app.patch(routes.access, async (request): Promise<AccessStatus> => {
		if (request.access.via !== "loopback") throw new ApiError(403, "loopback_only", LOOPBACK_ONLY);
		access.updateConfig(UpdateAccessBody.parse(request.body));
		return access.status(request.access);
	});

	app.put(routes.accessPassword, async (request, reply): Promise<AccessStatus> => {
		const body = SetPasswordBody.parse(request.body);
		const remote = request.access.via === "remote";
		if (remote) {
			// The very first password is set at the machine; afterwards a signed-in owner must prove the current one.
			if (!access.passwordSet()) throw new ApiError(403, "loopback_only", LOOPBACK_ONLY);
			if (!request.access.session) throw new ApiError(401, "auth_required", "Sign in to continue");
			if (!body.currentPassword) throw ApiError.badRequest("currentPassword is required to change the password remotely");
			const currentPassword = body.currentPassword;
			const matched = await throttled(reply, () => access.verifyOwnerPassword(clientOf(request), currentPassword));
			if (!matched) throw new ApiError(403, "invalid_current_password", "The current password is not correct");
		}
		await access.setPassword(body.password);
		if (!remote) return access.status(request.access);
		// Changing the password ended every session, including this one: continue as a fresh session.
		const issued = await access.startSession();
		sendCookie(reply, issued);
		return access.status({ via: "remote", session: issued.claims });
	});

	app.post(routes.accessLogin, async (request, reply): Promise<AccessStatus> => {
		if (request.access.via === "loopback") throw new ApiError(409, "login_not_required", "No sign-in is needed on the local UI");
		const body = LoginBody.parse(request.body);
		const matched = await throttled(reply, () => access.verifyOwnerPassword(clientOf(request), body.password));
		if (!matched) throw new ApiError(401, "invalid_credentials", "Invalid password");
		const issued = await access.startSession();
		sendCookie(reply, issued);
		return access.status({ via: "remote", session: issued.claims });
	});

	app.post(routes.accessLogout, async (request, reply) => {
		if (request.access.session) access.logout(request.access.session);
		reply.removeHeader("set-cookie");
		if (request.access.via === "remote") reply.header("Set-Cookie", clearedSessionCookie());
		return reply.status(204).send();
	});

	app.post(routes.accessLogoutAll, async (request, reply) => {
		access.logoutAll();
		reply.removeHeader("set-cookie");
		if (request.access.via === "remote") reply.header("Set-Cookie", clearedSessionCookie());
		return reply.status(204).send();
	});
}
