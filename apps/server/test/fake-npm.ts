import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * An offline stand-in for `npm`, first on PATH while installed. The handoff engine plans and runs `npm install` for a project with a
 * `package.json` and probes `npm --version`; the real npm is a heavy process whose start alone takes seconds on a machine under load, which
 * is what these tests would then measure instead of the engine. The stand-in keeps the observable contract the tests rely on: `install` runs
 * in the working folder and leaves a `package-lock.json` there, `--version` answers, and anything else fails loudly.
 */
const SCRIPT = `#!/bin/sh
case "$1" in
  --version|-v)
    echo "11.0.0"
    ;;
  install)
    printf '%s\\n' '{"name":"tiny","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"tiny","version":"1.0.0"}}}' > package-lock.json
    echo "up to date, audited 1 package"
    ;;
  *)
    echo "fake npm: unsupported command: $*" >&2
    exit 64
    ;;
esac
`;

export interface FakeNpm {
	/** Put the real PATH back and delete the stand-in. */
	restore(): void;
}

export function installFakeNpm(): FakeNpm {
	const dir = mkdtempSync(path.join(tmpdir(), "clam-fake-npm-"));
	const script = path.join(dir, "npm");
	writeFileSync(script, SCRIPT);
	chmodSync(script, 0o755);
	const previous = process.env.PATH;
	process.env.PATH = previous === undefined ? dir : `${dir}${path.delimiter}${previous}`;
	return {
		restore() {
			if (previous === undefined) delete process.env.PATH;
			else process.env.PATH = previous;
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
