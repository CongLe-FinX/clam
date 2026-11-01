/**
 * Which local ports a preview host may reach. The proxy's upstream is always loopback, so this is not about SSRF: it keeps the
 * proxy from becoming a door to CLAM itself or to services that are never web apps (databases, SSH, debuggers).
 */

/** Never proxied, whatever listens there: remote-login, mail, directory, database, cache, container-engine and debugger ports. */
export const DENIED_PORTS: ReadonlySet<number> = new Set([
	22, 23, 25, 53, 110, 111, 135, 139, 143, 389, 445, 465, 587, 993, 995, 1433, 1521, 2049, 2375, 2376, 3306, 3389, 5432, 5900, 5984, 6379, 9042, 9200, 9222, 9229, 11211, 27017,
]);

export type PortRefusal = "invalid" | "privileged" | "own" | "denied";

/** Ports below 1024 are not dev servers (except plain `80`). */
const LOWEST_PORT = 1024;

/** `null` when `port` may be previewed; else why not. `own`: CLAM's own UI and network listener ports. */
export function refusePort(port: number, ownPorts: readonly number[]): PortRefusal | null {
	if (!Number.isInteger(port) || port < 1 || port > 65535) return "invalid";
	if (ownPorts.includes(port)) return "own";
	if (DENIED_PORTS.has(port)) return "denied";
	if (port < LOWEST_PORT && port !== 80) return "privileged";
	return null;
}
