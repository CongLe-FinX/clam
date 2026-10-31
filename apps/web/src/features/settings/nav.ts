import { Bot, Cloud, GitBranch, Info, Settings2, ShieldCheck, Sparkles, Activity, type LucideIcon } from "lucide-react";

export interface SettingsNavItem {
	path: string;
	label: string;
	description: string;
	icon: LucideIcon;
}

export const SETTINGS_NAV: SettingsNavItem[] = [
	{ path: "general", label: "General", description: "Machine name, runtime limits, approval mode", icon: Settings2 },
	{ path: "github", label: "GitHub Accounts", description: "Connect accounts, browse and link repositories", icon: GitBranch },
	{ path: "omp", label: "OMP Providers", description: "Login, models and model roles", icon: Sparkles },
	{ path: "usage", label: "LLM Usage", description: "Tokens, cost and provider quota", icon: Activity },
	{ path: "runtime", label: "Agent Runtime", description: "Running OMP processes", icon: Bot },
	{ path: "tunnel", label: "Cloudflare Tunnel", description: "Remote access to this machine", icon: Cloud },
	{ path: "security", label: "Security", description: "Bind address, secret store, fingerprint", icon: ShieldCheck },
	{ path: "about", label: "About", description: "Version, node and documentation", icon: Info },
];

export const SETTINGS_BASE = "/settings";
