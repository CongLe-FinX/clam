import { hostname } from "node:os";
import { settings } from "@clam/database";
import type { ClamDb } from "@clam/database";
import { NodeSettings, type NodeSettingsPatch } from "@clam/contracts";
import type { SupervisorSettings } from "@clam/agent-runtime";
import { eq } from "drizzle-orm";

const NODE_SETTINGS_KEY = "node.settings";

export function defaultNodeSettings(): NodeSettings {
	return {
		nodeName: hostname().replace(/\.local$/i, "") || "node",
		runtimeIdleTimeoutMin: 30,
		maxConcurrentRuntimes: 4,
		// OMP's own default; stricter modes surface approvals as ui_request events.
		approvalMode: "yolo",
		autoStart: false,
		dependencySetup: "ask",
		autoAcceptHandoffs: false,
	};
}

/** Stored values layered over defaults; an unreadable stored value falls back to defaults rather than blocking boot. */
export function readNodeSettings(db: ClamDb): NodeSettings {
	const defaults = defaultNodeSettings();
	const row = db.select().from(settings).where(eq(settings.key, NODE_SETTINGS_KEY)).get();
	if (!row) return defaults;
	try {
		const parsed = NodeSettings.safeParse({ ...defaults, ...(JSON.parse(row.value) as object) });
		return parsed.success ? parsed.data : defaults;
	} catch {
		return defaults;
	}
}

export function writeNodeSettings(db: ClamDb, patch: NodeSettingsPatch): NodeSettings {
	const { autoStartDetail: _derived, ...stored } = NodeSettings.parse({ ...readNodeSettings(db), ...patch });
	const next: NodeSettings = stored;
	const value = JSON.stringify(next);
	const updatedAt = new Date().toISOString();
	db.insert(settings)
		.values({ key: NODE_SETTINGS_KEY, value, updatedAt })
		.onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } })
		.run();
	return next;
}

export function toSupervisorSettings(s: NodeSettings): SupervisorSettings {
	return {
		maxConcurrentRuntimes: s.maxConcurrentRuntimes,
		idleTimeoutMs: s.runtimeIdleTimeoutMin * 60_000,
		approvalMode: s.approvalMode,
	};
}
