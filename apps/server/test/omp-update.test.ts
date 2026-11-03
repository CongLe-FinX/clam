import type { OmpUpdateCheck, OmpUpdateResult, ProvidersOverview } from "@clam/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { api, createFullHarness, type FullHarness } from "./full-harness.ts";

/** `GET/POST /omp/update` against the fake omp binary: `omp update --check` / `omp update`, the installed version as `omp --version` reports it. */
let full: FullHarness | null = null;
afterEach(async () => {
	await full?.cleanup();
	full = null;
});

describe("OMP updates", () => {
	it("reports a newer release, installs it, and the install shows the new version; a second update finds nothing to do", async () => {
		full = await createFullHarness({ env: { FAKE_OMP_LATEST: "18.16.0" } });
		const http = api(full);
		const check = await http.get<OmpUpdateCheck>("/omp/update");
		expect(check.status, JSON.stringify(check.body)).toBe(200);
		expect(check.body).toMatchObject({ current: "18.14.0", latest: "18.16.0", available: true });

		const updated = await http.post<OmpUpdateResult>("/omp/update");
		expect(updated.status, JSON.stringify(updated.body)).toBe(200);
		expect(updated.body).toMatchObject({ previous: "omp/18.14.0", version: "omp/18.16.0", updated: true, runningSessions: 0 });
		expect(updated.body.output).toContain("Updated to 18.16.0");
		expect((await http.get<ProvidersOverview>("/omp/providers")).body.install.version).toBe("omp/18.16.0");

		// The cached check was dropped by the update: asking again tells the truth at once.
		expect((await http.get<OmpUpdateCheck>("/omp/update")).body).toMatchObject({ current: "18.16.0", latest: "18.16.0", available: false });
		const again = await http.post<OmpUpdateResult>("/omp/update");
		expect(again.body).toMatchObject({ updated: false, version: "omp/18.16.0" });
	});

	it("passes the failure of an unreachable release service on, and keeps the installed version", async () => {
		full = await createFullHarness({ env: { FAKE_OMP_UPDATE_FAIL: "fetch failed" } });
		const http = api(full);
		const check = await http.get<{ error: { code: string; message: string } }>("/omp/update");
		expect(check.status).toBe(409);
		expect(check.body.error.message).toContain("fetch failed");
		expect((await http.post<{ error: { code: string } }>("/omp/update")).status).toBe(409);
		expect((await http.get<ProvidersOverview>("/omp/providers")).body.install.version).toBe("omp/18.14.0");
	});
});
