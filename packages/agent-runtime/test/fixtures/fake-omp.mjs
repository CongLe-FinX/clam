#!/usr/bin/env node
// Test fixture: stand-in for the `omp` binary. `--mode rpc` emulates the RPC server (fake-omp-rpc.mjs);
// every other invocation is handled by the CLI emulation (fake-omp-cli.mjs).
const argv = process.argv.slice(2);
const modeIndex = argv.indexOf("--mode");
if (modeIndex !== -1 && argv[modeIndex + 1] === "rpc") {
	const { runRpc } = await import("./fake-omp-rpc.mjs");
	process.exit(await runRpc(argv, process.env));
} else {
	const { runCli } = await import("./fake-omp-cli.mjs");
	process.exit(await runCli(argv, process.env));
}
