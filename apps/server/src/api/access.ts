import { LoginBody, SetPasswordBody, StepUpBody, UpdateAccessBody, routes, type AccessStatus, i18nMsg } from "@clam/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IssuedSession } from "../auth/service.ts";
import { clearedSessionCookie, sessionCookie } from "../auth/token.ts";
import type { RoutePluginOptions } from "../context.ts";
import { ApiError } from "../http/errors.ts";

const LOOPBACK_ONLY = i18nMsg("This can only be changed from the machine this node runs on (the local UI)");

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

	app.patch(routes.access, async (request, reply): Promise<AccessStatus> => {
		const { password, ...patch } = UpdateAccessBody.parse(request.body);
		const via = request.access.via;
		if (via === "remote") {
			// How the UI itself is exposed (on/off, session lifetime) stays with the person at the machine.
			if (patch.remoteUiEnabled !== undefined || patch.sessionTtlHours !== undefined) throw new ApiError(403, "loopback_only", LOOPBACK_ONLY);
			// Switching a machine tool ON from a signed-in remote session needs the owner password in the same request; OFF never does.
			if (patch.remoteTerminalEnabled === true || patch.remoteBrowserEnabled === true) {
				const session = request.access.session;
				if (!session) throw new ApiError(401, "auth_required", i18nMsg("Sign in to continue"));
				if (!password) throw ApiError.badRequest(i18nMsg("password is required to switch this on from a remote session"));
				const matched = await throttled(reply, () => access.verifyOwnerPassword(clientOf(request), password));
				if (!matched) throw new ApiError(401, "invalid_credentials", i18nMsg("Invalid password"));
				access.updateConfig(patch, via);
				access.elevate(session);
				return access.status(request.access);
			}
		}
		access.updateConfig(patch, via);
		return access.status(request.access);
	});

	app.post(routes.accessStepUp, async (request, reply): Promise<AccessStatus> => {
		const session = request.access.session;
		if (request.access.via !== "remote" || !session) throw new ApiError(409, "step_up_not_required", i18nMsg("No re-entry of the password is needed on the local UI"));
		const body = StepUpBody.parse(request.body);
		const matched = await throttled(reply, () => access.verifyOwnerPassword(clientOf(request), body.password));
		if (!matched) throw new ApiError(403, "invalid_credentials", i18nMsg("Invalid password"));
		access.elevate(session);
		return access.status(request.access);
	});

	app.put(routes.accessPassword, async (request, reply): Promise<AccessStatus> => {
		const body = SetPasswordBody.parse(request.body);
		const remote = request.access.via === "remote";
		if (remote) {
			// The very first password is set at the machine; afterwards a signed-in owner must prove the current one.
			if (!access.passwordSet()) throw new ApiError(403, "loopback_only", LOOPBACK_ONLY);
			if (!request.access.session) throw new ApiError(401, "auth_required", i18nMsg("Sign in to continue"));
			if (!body.currentPassword) throw ApiError.badRequest(i18nMsg("currentPassword is required to change the password remotely"));
			const currentPassword = body.currentPassword;
			const matched = await throttled(reply, () => access.verifyOwnerPassword(clientOf(request), currentPassword));
			if (!matched) throw new ApiError(403, "invalid_current_password", i18nMsg("The current password is not correct"));
		}
		await access.setPassword(body.password);
		if (!remote) return access.status(request.access);
		// Changing the password ended every session, including this one: continue as a fresh session.
		const issued = await access.startSession();
		sendCookie(reply, issued);
		return access.status({ via: "remote", session: issued.claims });
	});

	app.post(routes.accessLogin, async (request, reply): Promise<AccessStatus> => {
		if (request.access.via === "loopback") throw new ApiError(409, "login_not_required", i18nMsg("No sign-in is needed on the local UI"));
		const body = LoginBody.parse(request.body);
		const matched = await throttled(reply, () => access.verifyOwnerPassword(clientOf(request), body.password));
		if (!matched) throw new ApiError(401, "invalid_credentials", i18nMsg("Invalid password"));
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
