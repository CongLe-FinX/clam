import { z } from "zod";
import { IsoDate } from "./common.ts";

export const GithubConfig = z.object({
	/** OAuth App client id used for the device flow; null until configured. */
	clientId: z.string().nullable(),
	/** True when the `gh` CLI is installed and logged in (import option). */
	ghCliAvailable: z.boolean(),
	scopes: z.array(z.string()),
});
export type GithubConfig = z.infer<typeof GithubConfig>;
export const UpdateGithubConfigBody = z.object({ clientId: z.string().trim().min(1).nullable() });

export const GithubAccount = z.object({
	id: z.string(),
	login: z.string(),
	name: z.string().nullable(),
	email: z.string().nullable(),
	avatarUrl: z.string().nullable(),
	scopes: z.array(z.string()),
	source: z.enum(["oauth-device", "gh-cli"]),
	isDefault: z.boolean(),
	status: z.enum(["connected", "invalid", "unknown"]),
	lastVerifiedAt: IsoDate.nullable(),
	createdAt: IsoDate,
});
export type GithubAccount = z.infer<typeof GithubAccount>;

export const DeviceFlowStart = z.object({
	flowId: z.string(),
	userCode: z.string(),
	verificationUri: z.string(),
	expiresAt: IsoDate,
	intervalSec: z.number(),
});
export type DeviceFlowStart = z.infer<typeof DeviceFlowStart>;

export const DeviceFlowStatus = z.object({
	flowId: z.string(),
	state: z.enum(["pending", "success", "expired", "denied", "error"]),
	account: GithubAccount.optional(),
	error: z.string().optional(),
});
export type DeviceFlowStatus = z.infer<typeof DeviceFlowStatus>;

export const GithubRepo = z.object({
	id: z.string(),
	owner: z.string(),
	name: z.string(),
	fullName: z.string(),
	private: z.boolean(),
	description: z.string().nullable(),
	htmlUrl: z.string(),
	defaultBranch: z.string(),
	pushedAt: IsoDate.nullable(),
	permissions: z.object({ pull: z.boolean(), push: z.boolean(), admin: z.boolean() }),
});
export type GithubRepo = z.infer<typeof GithubRepo>;

export const RepoPermissionCheck = z.object({
	repo: z.string(),
	accountId: z.string(),
	clone: z.boolean(),
	fetch: z.boolean(),
	push: z.boolean(),
	createPr: z.boolean(),
	details: z.string().optional(),
});
export type RepoPermissionCheck = z.infer<typeof RepoPermissionCheck>;
