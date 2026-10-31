import { locateOmpBinary } from "@clam/agent-runtime/omp";
import type { OmpLocator } from "./context.ts";

const RETRY_WHEN_MISSING_MS = 10_000;

/**
 * Resolves the omp executable at boot. While it is missing, `binaryPath()` re-scans in the background at most
 * every 10 s, so installing OMP while the server runs is picked up without a restart.
 */
export async function createOmpLocator(override: string | null): Promise<OmpLocator> {
	let current = await locateOmpBinary({ override });
	let lastScan = Date.now();
	let scanning: Promise<string | null> | null = null;
	const refresh = (): Promise<string | null> => {
		scanning ??= locateOmpBinary({ override })
			.then((found) => {
				current = found;
				return found;
			})
			.finally(() => {
				lastScan = Date.now();
				scanning = null;
			});
		return scanning;
	};
	return {
		binaryPath() {
			if (current === null && !scanning && Date.now() - lastScan >= RETRY_WHEN_MISSING_MS) void refresh();
			return current;
		},
		refresh,
	};
}
