import { msg, type Msg } from "@/i18n";
import { Bot, Cloud, GitBranch, Info, Settings2, ShieldCheck, Sparkles, Activity, type LucideIcon } from "lucide-react";

export interface SettingsNavItem {
	path: string;
	label: Msg;
	description: Msg;
	icon: LucideIcon;
}

export const SETTINGS_NAV: SettingsNavItem[] = [
	{ path: "general", label: msg("General"), description: msg("Machine name, runtime limits, approval mode"), icon: Settings2 },
	{ path: "github", label: msg("GitHub Accounts"), description: msg("Connect accounts, browse and link repositories"), icon: GitBranch },
	{ path: "omp", label: msg("OMP Providers"), description: msg("Login, models and model roles"), icon: Sparkles },
	{ path: "usage", label: msg("LLM Usage"), description: msg("Tokens, cost and provider quota"), icon: Activity },
	{ path: "runtime", label: msg("Agent Runtime"), description: msg("Running OMP processes"), icon: Bot },
	{ path: "tunnel", label: msg("Cloudflare Tunnel"), description: msg("Remote access to this machine"), icon: Cloud },
	{ path: "security", label: msg("Security"), description: msg("Bind address, secret store, fingerprint"), icon: ShieldCheck },
	{ path: "about", label: msg("About"), description: msg("Version, node and documentation"), icon: Info },
];

export const SETTINGS_BASE = "/settings";
