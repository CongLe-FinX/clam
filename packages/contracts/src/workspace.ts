import { z } from "zod";
import { IsoDate } from "./common.ts";

export const Workspace = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string(),
	ownerNodeId: z.string(),
	projectCount: z.number().int(),
	createdAt: IsoDate,
	updatedAt: IsoDate,
});
export type Workspace = z.infer<typeof Workspace>;

export const CreateWorkspaceBody = z.object({
	name: z.string().trim().min(1).max(80),
	description: z.string().max(500).default(""),
});
export const UpdateWorkspaceBody = CreateWorkspaceBody.partial();

export const RepositoryRef = z.object({
	owner: z.string(),
	name: z.string(),
	/** GitHub numeric id as string. */
	externalId: z.string().nullable(),
	htmlUrl: z.string(),
	defaultBranch: z.string().nullable(),
	/** GitHub account id (CL Agent Mesh connection id) used on this node. */
	accountId: z.string().nullable(),
});
export type RepositoryRef = z.infer<typeof RepositoryRef>;

export const Project = z.object({
	id: z.string(),
	workspaceId: z.string(),
	name: z.string(),
	/** Absolute local working directory on this node. */
	path: z.string(),
	repository: RepositoryRef.nullable(),
	/** `git` when the directory is a git working tree; `none` for a plain folder (no repo needed for sessions, tasks or shared sessions). */
	vcs: z.enum(["git", "none"]),
	/** Created by CL Agent Mesh under its data dir (no path chosen by the user); deleting the project may delete it. */
	managed: z.boolean(),
	/** `chat` = the managed folder created for a chat started without a project (research, reports, media…); listed under Chats, not Projects. */
	origin: z.enum(["user", "chat"]),
	sessionCount: z.number().int(),
	lastActivityAt: IsoDate.nullable(),
	createdAt: IsoDate,
	updatedAt: IsoDate,
});
export type Project = z.infer<typeof Project>;

export const CreateProjectBody = z.object({
	workspaceId: z.string().min(1),
	name: z.string().trim().min(1).max(80),
	/**
	 * An existing absolute directory (git or not). Omit to let CL Agent Mesh create an empty managed folder for the
	 * project under its data dir — for work that has no repository at all.
	 */
	path: z.string().min(1).optional(),
});
export const UpdateProjectBody = z.object({
	name: z.string().trim().min(1).max(80).optional(),
	repository: RepositoryRef.nullable().optional(),
});

export const FileEntry = z.object({
	name: z.string(),
	/** Path relative to the project root, POSIX separators. */
	path: z.string(),
	kind: z.enum(["file", "dir", "symlink"]),
	size: z.number().nullable(),
	modifiedAt: IsoDate.nullable(),
});
export type FileEntry = z.infer<typeof FileEntry>;

export const FileContent = z.object({
	path: z.string(),
	size: z.number(),
	/** null when binary or larger than the cap. */
	content: z.string().nullable(),
	truncated: z.boolean(),
	binary: z.boolean(),
	language: z.string().nullable(),
});
export type FileContent = z.infer<typeof FileContent>;

/** Directory suggestions when picking a project path. */
export const DirSuggestion = z.object({ path: z.string(), isGitRepo: z.boolean() });
export type DirSuggestion = z.infer<typeof DirSuggestion>;
