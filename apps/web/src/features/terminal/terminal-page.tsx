import { type AccessStatus, type CreateTerminalBody, type TerminalSession } from "@clam/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
	ClipboardCopy,
	ClipboardPaste,
	Eraser,
	Loader2,
	Lock,
	Menu,
	Minus,
	MoreHorizontal,
	Pencil,
	Plus,
	RotateCcw,
	Search,
	ShieldAlert,
	TerminalSquare,
	Type,
	WifiOff,
	X,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { t, T, msg, tr, type Msg } from "@/i18n";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { PasswordDialog } from "@/features/auth/password-dialog";
import { accessKey, useAccess } from "@/features/auth/hooks";
import { useBreakpoint } from "@/hooks/use-breakpoint";
import { ApiError, errorMessage } from "@/lib/api";
import { useUi } from "@/lib/store";
import { useResolvedTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Sheet, SheetContent, SheetTitle } from "@/ui/sheet";
import { Skeleton } from "@/ui/skeleton";
import { StatusDot } from "@/ui/status-dot";
import { Tip } from "@/ui/tooltip";
import { isElevated, terminalKeys, upsertSession, useCreateTerminal, useEnableRemoteTerminal, useKillTerminal, useRenameTerminal, useStepUp, useTerminalInfo, useTerminalSessions } from "./api";
import type { ConnectionState, TerminalConnection } from "./connection";
import { estimateGrid } from "./grid";
import { NewTerminalDialog, tildePath } from "./new-terminal-dialog";
import { FONT_MAX, FONT_MIN, clampFont, readFontSize, saveFontSize } from "./theme";
import type { TerminalControls } from "./terminal-view";
import { useVisualViewport } from "./use-visual-viewport";

// xterm.js and its addons live in this lazy chunk, loaded when the first terminal is shown.
const TerminalView = lazy(() => import("./terminal-view"));

const RISK = (user: string | undefined) =>
	user ? (
		<T
			text="Anyone who signs in to this machine's domain with the owner password can run commands as <b>{user}</b>, with full access to its files and network."
			params={{ user }}
			tags={{ b: <strong className="font-semibold" /> }}
		/>
	) : (
		t("Anyone who signs in to this machine's domain with the owner password can run commands as the user that runs this machine, with full access to its files and network.")
	);

// ───────────────────────────────────────────── connection pill

const PILL: Record<ConnectionState, { label: Msg; tone: string; dot: "online" | "starting" | "offline" | "crashed" }> = {
	live: { label: msg("Live"), tone: "text-success", dot: "online" },
	connecting: { label: msg("Connecting"), tone: "text-muted-foreground", dot: "starting" },
	reconnecting: { label: msg("Reconnecting"), tone: "text-warning", dot: "starting" },
	ended: { label: msg("Closed"), tone: "text-muted-foreground", dot: "offline" },
	denied: { label: msg("Signed out"), tone: "text-danger", dot: "crashed" },
};

function ConnectionPill({ state, exited }: { state: ConnectionState; exited: boolean }) {
	const p = exited && state === "live" ? { label: msg("Exited"), tone: "text-muted-foreground", dot: "offline" as const } : PILL[state];
	return (
		<span className={cn("inline-flex h-7 items-center gap-1.5 rounded-full bg-surface-2 px-2.5 text-xs font-medium shadow-[inset_0_0_0_1px_var(--border)]", p.tone)} role="status">
			<StatusDot status={p.dot} label={tr(p.label)} />
			{tr(p.label)}
		</span>
	);
}

// ───────────────────────────────────────────── tabs

function TabButton({
	s,
	active,
	renaming,
	onSelect,
	onClose,
	onRenameStart,
	onRenameDone,
}: {
	s: TerminalSession;
	active: boolean;
	renaming: boolean;
	onSelect: () => void;
	onClose: () => void;
	onRenameStart: () => void;
	onRenameDone: (title: string | null) => void;
}) {
	const dot = s.status === "running" ? "online" : s.exitCode === 0 ? "offline" : "crashed";
	return (
		<div
			role="tab"
			aria-selected={active}
			data-active={active || undefined}
			className={cn(
				"group/tab relative flex h-8 min-w-0 max-w-[12rem] shrink-0 items-center gap-1.5 rounded-lg pl-2.5 pr-1 text-[13px] transition-colors duration-150 coarse:h-10 coarse:max-w-[10rem]",
				active ? "bg-surface-3 text-foreground" : "text-muted-foreground hover:bg-surface-2 hover:text-foreground",
			)}
		>
			<StatusDot status={dot} label={s.status === "running" ? t("Running") : t("Exited")} />
			{renaming ? (
				<input
					autoFocus
					defaultValue={s.title}
					maxLength={80}
					aria-label={t("Terminal name")}
					onFocus={(e) => e.currentTarget.select()}
					onBlur={(e) => onRenameDone(e.currentTarget.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") onRenameDone(e.currentTarget.value);
						if (e.key === "Escape") onRenameDone(null);
					}}
					className="h-6 w-28 min-w-0 rounded bg-surface-1 px-1.5 text-base outline-none shadow-[inset_0_0_0_1px_var(--accent)] sm:text-[13px]"
				/>
			) : (
				<button type="button" onClick={onSelect} onDoubleClick={onRenameStart} title={`${s.title} — ${s.cwd}`} className="min-w-0 flex-1 truncate text-left outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:shadow-[0_0_0_2px_var(--ring)]">
					{s.title}
				</button>
			)}
			<button
				type="button"
				aria-label={t("Close {title}", { title: s.title })}
				onClick={onClose}
				className={cn(
					"relative z-10 grid size-6 shrink-0 place-items-center rounded-md text-subtle outline-none transition-[opacity,background-color,color] duration-150 hover:bg-border-strong hover:text-foreground focus-visible:opacity-100 coarse:size-8",
					active ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100 coarse:opacity-100",
				)}
			>
				<X className="size-3.5" />
			</button>
		</div>
	);
}

// ───────────────────────────────────────────── font size

function FontSizeControl({ size, onChange }: { size: number; onChange: (n: number) => void }) {
	return (
		<div className="flex items-center gap-1" role="group" aria-label={t("Font size")}>
			<Button variant="outline" size="icon" aria-label={t("Smaller text")} disabled={size <= FONT_MIN} onClick={() => onChange(clampFont(size - 1))}>
				<Minus />
			</Button>
			<span className="grid h-8 min-w-12 place-items-center font-mono text-[13px] tabular-nums coarse:h-11" aria-live="polite">
				{size}px
			</span>
			<Button variant="outline" size="icon" aria-label={t("Larger text")} disabled={size >= FONT_MAX} onClick={() => onChange(clampFont(size + 1))}>
				<Plus />
			</Button>
		</div>
	);
}

// ───────────────────────────────────────────── gate cards

function GateCard({ icon: Icon, title, children, action, tone = "neutral" }: { icon: typeof Lock; title: string; children: React.ReactNode; action?: React.ReactNode; tone?: "neutral" | "warning" }) {
	return (
		<div className="grid h-full place-items-center overflow-y-auto p-4">
			<div className="flex w-full max-w-md animate-slide-up flex-col items-center gap-4 rounded-2xl bg-surface-1 p-6 text-center shadow-[inset_0_0_0_1px_var(--border)] sm:p-8">
				<div className={cn("grid size-12 place-items-center rounded-2xl shadow-[inset_0_0_0_1px_var(--border)]", tone === "warning" ? "bg-warning/12 text-warning" : "bg-surface-2 text-muted-foreground")}>
					<Icon className="size-5" />
				</div>
				<div className="flex flex-col gap-1.5">
					<h2 className="text-base font-semibold tracking-tight">{title}</h2>
					<div className="text-[13px] leading-relaxed text-muted-foreground">{children}</div>
				</div>
				{action}
			</div>
		</div>
	);
}

function RemoteOffCard({ user }: { user: string | undefined }) {
	const enable = useEnableRemoteTerminal();
	const [open, setOpen] = useState(false);
	return (
		<>
			<GateCard
				icon={Lock}
				title={t("Terminal is off for remote sign-ins")}
				tone="warning"
				action={
					<Button variant="primary" size="lg" onClick={() => setOpen(true)}>
						<ShieldAlert /> {t("Turn on remote Terminal…")}
					</Button>
				}
			>
				<p>{RISK(user)}</p>
				<p className="mt-2 text-xs text-subtle">{t("It stays off by default. You can also switch it on from this machine's local UI under Settings → Security.")}</p>
			</GateCard>
			<PasswordDialog
				open={open}
				onOpenChange={setOpen}
				title={t("Turn on the remote Terminal")}
				description={t("Confirm with the owner password. You can switch it off again at any time.")}
				risk={RISK(user)}
				confirmLabel={t("Turn on")}
				onSubmit={(password) => enable.mutateAsync(password)}
			/>
		</>
	);
}

function StepUpOverlay({ onUnlock }: { onUnlock: () => void }) {
	return (
		<div className="absolute inset-0 z-20 grid place-items-center bg-background/80 p-4 backdrop-blur-sm">
			<div className="flex w-full max-w-sm animate-pop-in flex-col items-center gap-3 rounded-2xl bg-overlay p-6 text-center shadow-pop shadow-[inset_0_0_0_1px_var(--border-strong)]">
				<div className="grid size-11 place-items-center rounded-xl bg-accent-soft text-accent">
					<Lock className="size-5" />
				</div>
				<h2 className="text-[15px] font-semibold tracking-tight">{t("Confirm it's you")}</h2>
				<p className="text-[13px] text-muted-foreground">{t("A terminal can run anything on this machine, so opening one through the domain asks for your password again. It stays unlocked for 10 minutes.")}</p>
				<Button variant="primary" size="lg" className="w-full" onClick={onUnlock}>
					{t("Enter password")}
				</Button>
			</div>
		</div>
	);
}

// ───────────────────────────────────────────── page

/** Re-render when `iso` passes (the step-up expiring must show up without any other event). */
function useExpiry(iso: string | null | undefined): void {
	const [, tick] = useState(0);
	useEffect(() => {
		if (!iso) return;
		const wait = Date.parse(iso) - Date.now();
		if (wait <= 0 || wait > 2 ** 31 - 1) return;
		const timer = setTimeout(() => tick((n) => n + 1), wait + 50);
		return () => clearTimeout(timer);
	}, [iso]);
}

export default function TerminalPage() {
	const access = useAccess();
	const a: AccessStatus | undefined = access.data;
	const remoteOff = a?.via === "remote" && !a.remoteTerminalEnabled;
	const usable = a !== undefined && !remoteOff;
	const info = useTerminalInfo(usable);
	const sessions = useTerminalSessions(usable);
	const bp = useBreakpoint();
	const mobile = bp === "mobile";
	const touch = mobile || (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches);
	const theme = useResolvedTheme();
	const qc = useQueryClient();
	const navigate = useNavigate();
	const search = useSearch({ from: "/terminal" });
	const setDrawer = useUi((s) => s.setDrawerOpen);
	const viewport = useVisualViewport(mobile);

	const create = useCreateTerminal();
	const rename = useRenameTerminal();
	const kill = useKillTerminal();
	const stepUp = useStepUp();

	const [fontSize, setFontSizeState] = useState(readFontSize);
	const setFontSize = useCallback((n: number) => {
		const next = clampFont(n);
		setFontSizeState(next);
		saveFontSize(next);
	}, []);
	const [newOpen, setNewOpen] = useState(false);
	const [newFor, setNewFor] = useState<string | undefined>(undefined);
	const [stepUpOpen, setStepUpOpen] = useState(false);
	const pendingCreate = useRef<CreateTerminalBody | null>(null);
	const paneRef = useRef<HTMLDivElement>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [closing, setClosing] = useState<TerminalSession | null>(null);
	const [menuOpen, setMenuOpen] = useState(false);
	const [conn, setConn] = useState<ConnectionState>("connecting");
	const controls = useRef<TerminalControls | null>(null);
	const connection = useRef<TerminalConnection | null>(null);
	useExpiry(a?.elevatedUntil);

	const list = sessions.data ?? [];
	const selected = list.find((s) => s.id === search.t) ?? list[0];
	const select = useCallback((id: string) => void navigate({ to: "/terminal", search: { t: id }, replace: true }), [navigate]);

	// A fresh terminal always shows `connecting` until its socket reports in.
	const selectedId = selected?.id;
	useEffect(() => {
		setConn("connecting");
	}, [selectedId]);

	const needsStepUp = a?.via === "remote" && !isElevated(a);

	const open = useCallback(
		async (body: CreateTerminalBody): Promise<void> => {
			try {
				// Spawn the shell at about the size of the pane it is going to be shown in, not 80×24 resized under its first prompt.
				const grid = paneRef.current ? estimateGrid(paneRef.current, fontSize, touch) : null;
				const s = await create.mutateAsync({ ...grid, ...body });
				setNewOpen(false);
				select(s.id);
			} catch (e) {
				if (e instanceof ApiError && e.code === "step_up_required") {
					pendingCreate.current = body;
					setNewOpen(false);
					setStepUpOpen(true);
				} else if (e instanceof ApiError && e.code === "tool_disabled") {
					void qc.invalidateQueries({ queryKey: accessKey });
				} else toast.error(errorMessage(e));
			}
		},
		[create, qc, select, fontSize, touch],
	);

	// "Open terminal here" links arrive with ?project=<id>: reuse a running terminal in that folder, else open one.
	const handled = useRef<string | null>(null);
	useEffect(() => {
		const project = search.project;
		if (!project || !sessions.isSuccess || handled.current === project) return;
		handled.current = project;
		const existing = list.find((s) => s.projectId === project && s.status === "running");
		if (existing) {
			select(existing.id);
			return;
		}
		void open({ projectId: project });
	}, [search.project, sessions.isSuccess, list, open, select]);

	const closeTerminal = async (s: TerminalSession) => {
		try {
			await kill.mutateAsync(s.id);
			setClosing(null);
			const rest = list.filter((x) => x.id !== s.id);
			if (selected?.id === s.id) void navigate({ to: "/terminal", search: rest[0] ? { t: rest[rest.length - 1]?.id } : {}, replace: true });
		} catch (e) {
			toast.error(errorMessage(e));
		}
	};

	const commitRename = (s: TerminalSession, title: string | null) => {
		setRenaming(null);
		const next = title?.trim();
		if (!next || next === s.title) return;
		rename.mutate({ id: s.id, title: next }, { onError: (e) => toast.error(errorMessage(e)) });
	};

	const onSession = useCallback((s: TerminalSession) => upsertSession(qc, s), [qc]);
	const onState = useCallback(
		(s: ConnectionState) => {
			setConn(s);
			if (s === "denied") void qc.invalidateQueries({ queryKey: accessKey });
			if (s === "ended") void qc.invalidateQueries({ queryKey: terminalKeys.sessions });
		},
		[qc],
	);
	const onRefused = useCallback(() => {
		void qc.invalidateQueries({ queryKey: accessKey });
		void qc.invalidateQueries({ queryKey: terminalKeys.sessions });
	}, [qc]);

	const copy = async () => {
		try {
			if (await controls.current?.copySelection()) toast.success(t("Copied"));
			else toast.message(t("Select some text first"));
		} catch {
			toast.error(t("The browser blocked clipboard access."));
		}
	};

	const folder = selected ? tildePath(selected.cwd, info.data?.home) : "";
	const shellLabel = selected ? (selected.shell.split("/").pop() ?? selected.shell) : "";

	// ── states before the terminal UI ───────────────────────────────────────────────
	if (access.isPending) return <PageSkeleton />;
	if (access.isError) return <GateCard icon={WifiOff} title={t("Can't reach this machine")} action={<Button onClick={() => void access.refetch()}>{t("Try again")}</Button>}>{errorMessage(access.error)}</GateCard>;
	if (remoteOff) return <RemoteOffCard user={undefined} />;
	if (info.data && !info.data.available)
		return (
			<GateCard icon={TerminalSquare} title={t("The terminal engine isn't available")} tone="warning">
				{info.data.reason ?? t("This machine could not start a terminal.")}
			</GateCard>
		);
	if (sessions.isError && !(sessions.error instanceof ApiError && sessions.error.code === "tool_disabled")) {
		return (
			<GateCard icon={WifiOff} title={t("Couldn't load your terminals")} action={<Button onClick={() => void sessions.refetch()}>{t("Try again")}</Button>}>
				{errorMessage(sessions.error)}
			</GateCard>
		);
	}
	if (sessions.isPending) return <PageSkeleton />;

	const newButton = (
		<Button variant="primary" size="md" onClick={() => { setNewFor(undefined); setNewOpen(true); }} aria-label={t("New terminal")} data-testid="new-terminal">
			<Plus /> <span className="max-sm:sr-only">{t("New terminal")}</span>
		</Button>
	);

	const toolbar = (
		<div className="flex items-center gap-1">
			<Tip label={t("Find in output")} shortcut="⌘F">
				<Button variant="ghost" size="icon" aria-label={t("Find in output")} onClick={() => controls.current?.toggleSearch()} disabled={!selected}>
					<Search />
				</Button>
			</Tip>
			<Tip label={t("Copy selection")}>
				<Button variant="ghost" size="icon" aria-label={t("Copy selection")} onClick={() => void copy()} disabled={!selected}>
					<ClipboardCopy />
				</Button>
			</Tip>
			<Tip label={t("Paste")}>
				<Button variant="ghost" size="icon" aria-label={t("Paste")} onClick={() => void controls.current?.paste()} disabled={!selected}>
					<ClipboardPaste />
				</Button>
			</Tip>
			<Popover>
				<Tip label={t("Text size")}>
					<PopoverTrigger asChild>
						<Button variant="ghost" size="icon" aria-label={t("Text size")}>
							<Type />
						</Button>
					</PopoverTrigger>
				</Tip>
				<PopoverContent align="end" className="w-auto">
					<FontSizeControl size={fontSize} onChange={setFontSize} />
				</PopoverContent>
			</Popover>
			<Tip label={t("Clear screen")}>
				<Button variant="ghost" size="icon" aria-label={t("Clear screen")} onClick={() => controls.current?.clear()} disabled={!selected}>
					<Eraser />
				</Button>
			</Tip>
		</div>
	);

	const tabs = (
		<div role="tablist" aria-label={t("Terminals")} className="scrollbar-none flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
			{list.map((s) => (
				<TabButton
					key={s.id}
					s={s}
					active={s.id === selected?.id}
					renaming={renaming === s.id}
					onSelect={() => select(s.id)}
					onClose={() => (s.status === "running" ? setClosing(s) : void closeTerminal(s))}
					onRenameStart={() => setRenaming(s.id)}
					onRenameDone={(title) => commitRename(s, title)}
				/>
			))}
			<Tip label={t("New terminal")}>
				<Button variant="ghost" size="icon" aria-label={t("New terminal tab")} onClick={() => { setNewFor(undefined); setNewOpen(true); }} className="shrink-0">
					<Plus />
				</Button>
			</Tip>
		</div>
	);

	const header = mobile ? (
		<header className="shrink-0 border-b bg-surface-1 pt-[env(safe-area-inset-top)]">
			<div className="flex h-12 items-center gap-1 px-2">
				<Button variant="ghost" size="icon" aria-label={t("Open navigation")} onClick={() => setDrawer(true)}>
					<Menu />
				</Button>
				<div className="flex min-w-0 flex-1 flex-col leading-tight">
					<span className="truncate text-sm font-semibold">{selected?.title ?? t("Terminal")}</span>
					{selected ? <span className="truncate font-mono text-2xs text-subtle">{folder}</span> : null}
				</div>
				{selected ? <ConnectionPill state={conn} exited={selected.status === "exited"} /> : null}
				<Button variant="ghost" size="icon" aria-label={t("Terminal actions")} onClick={() => setMenuOpen(true)} disabled={!selected}>
					<MoreHorizontal />
				</Button>
			</div>
			<div className="flex items-center gap-1 px-2 pb-1.5">{tabs}</div>
		</header>
	) : (
		<header className="flex h-12 shrink-0 items-center gap-2 border-b bg-surface-1 px-3">
			{tabs}
			<div className="flex shrink-0 items-center gap-2">
				{selected ? (
					<>
						<ConnectionPill state={conn} exited={selected.status === "exited"} />
						{toolbar}
					</>
				) : null}
				{newButton}
			</div>
		</header>
	);

	const body =
		list.length === 0 || !selected ? (
			<EmptyState
				icon={TerminalSquare}
				title={t("A shell on this machine")}
				description={a?.via === "remote" ? t("Commands you run here run on this machine, not on the device you are using.") : t("Open a real terminal on this machine. It keeps running when you close the tab.")}
				action={
					<div className="flex flex-wrap items-center justify-center gap-2">
						<Button variant="primary" size="lg" loading={create.isPending} onClick={() => void open({})} data-testid="open-first-terminal">
							<TerminalSquare /> {t("Open terminal")}
						</Button>
						<Button variant="outline" size="lg" onClick={() => { setNewFor(undefined); setNewOpen(true); }}>
							{t("Choose folder…")}
						</Button>
					</div>
				}
				className="h-full"
			/>
		) : (
			<div className="relative min-h-0 flex-1" data-terminal-id={selected.id}>
				<Suspense fallback={<div className="grid h-full place-items-center bg-surface-1 text-subtle"><Loader2 className="size-5 animate-spin" aria-label={t("Loading terminal")} /></div>}>
					<TerminalView
						key={selected.id}
						session={selected}
						blocked={Boolean(needsStepUp && conn !== "live")}
						fontSize={fontSize}
						onFontSize={setFontSize}
						themeMode={theme}
						touchKeys={touch}
						controlsRef={controls}
						connectionRef={connection}
						onState={onState}
						onSession={onSession}
						onRefused={onRefused}
					/>
				</Suspense>
				{needsStepUp && conn !== "live" ? <StepUpOverlay onUnlock={() => setStepUpOpen(true)} /> : null}
				{selected.status === "exited" && conn === "live" ? (
					<div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-3">
						<div className="pointer-events-auto flex animate-pop-in flex-wrap items-center justify-center gap-2 rounded-xl bg-overlay py-2 pl-3.5 pr-2 shadow-pop shadow-[inset_0_0_0_1px_var(--border-strong)]">
							<span className="text-[13px] text-muted-foreground">
								{t("Shell exited")}{" "}
								<span className="font-mono tabular-nums text-foreground">
									{selected.exitCode !== null ? t("(code {code})", { code: selected.exitCode }) : selected.signal !== null ? t("(signal {signal})", { signal: selected.signal }) : ""}
								</span>
							</span>
							<Button size="sm" variant="primary" onClick={() => void open(selected.projectId ? { projectId: selected.projectId } : {})}>
								<RotateCcw /> {t("Start a new shell")}
							</Button>
							<Button size="sm" variant="ghost" onClick={() => void closeTerminal(selected)}>
								{t("Close")}
							</Button>
						</div>
					</div>
				) : null}
				{conn === "reconnecting" && !needsStepUp ? (
					<div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2">
						<span className="inline-flex animate-pop-in items-center gap-2 rounded-full bg-overlay px-3 py-1.5 text-xs font-medium text-warning shadow-pop shadow-[inset_0_0_0_1px_var(--border-strong)]">
							<Loader2 className="size-3.5 animate-spin" aria-hidden /> {t("Reconnecting… your shell is still running")}
						</span>
					</div>
				) : null}
			</div>
		);

	const footer =
		!mobile && selected ? (
			<footer className="flex h-7 shrink-0 items-center justify-between gap-4 border-t bg-surface-1 px-4 text-2xs text-subtle">
				<span className="flex min-w-0 items-center gap-2">
					<span className="truncate font-mono" title={selected.cwd}>{folder}</span>
					<span aria-hidden>·</span>
					<span className="shrink-0 font-mono">{shellLabel}</span>
				</span>
				<span className="shrink-0 font-mono tabular-nums">
					{selected.cols}×{selected.rows}
					{selected.attached > 1 ? ` · ${t("{count, plural, one {# browser} other {# browsers}}", { count: selected.attached })}` : ""}
				</span>
			</footer>
		) : null;

	const root = (
		<div
			className={cn("flex min-h-0 flex-col bg-background", mobile ? "fixed inset-x-0 z-20" : "h-full")}
			style={mobile ? (viewport ? { top: viewport.top, height: viewport.height } : { top: 0, bottom: 0 }) : undefined}
		>
			{header}
			<div ref={paneRef} className={cn("flex min-h-0 flex-1 flex-col", mobile && !viewport?.keyboardOpen && "pb-[env(safe-area-inset-bottom)]")}>
				{body}
			</div>
			{footer}
		</div>
	);

	return (
		<>
			{root}
			<NewTerminalDialog open={newOpen} onOpenChange={setNewOpen} info={info.data} initialProjectId={newFor} pending={create.isPending} onCreate={(b) => void open(b)} />
			<PasswordDialog
				open={stepUpOpen}
				onOpenChange={(o) => {
					setStepUpOpen(o);
					if (!o) pendingCreate.current = null;
				}}
				title={t("Confirm it's you")}
				description={t("Opening a terminal through the domain needs your owner password again. It stays unlocked for 10 minutes.")}
				confirmLabel={t("Unlock")}
				onSubmit={async (password) => {
					await stepUp.mutateAsync(password);
					const body = pendingCreate.current;
					pendingCreate.current = null;
					if (body) void open(body);
					else connection.current?.retryNow();
				}}
			/>
			<ConfirmDialog
				open={closing !== null}
				onOpenChange={(o) => !o && setClosing(null)}
				title={t("Close “{title}”?", { title: closing?.title ?? "" })}
				description={t("The shell and everything running in it will stop. Anything unsaved in a running program is lost.")}
				confirmLabel={t("Close terminal")}
				danger
				loading={kill.isPending}
				onConfirm={() => closing && void closeTerminal(closing)}
			/>
			<Sheet open={menuOpen} onOpenChange={setMenuOpen}>
				<SheetContent side="bottom" className="gap-1 p-3">
					<SheetTitle className="sr-only">{t("Terminal actions")}</SheetTitle>
					<div className="grid grid-cols-3 gap-2">
						{[
							{ label: msg("Find"), icon: Search, run: () => controls.current?.toggleSearch() },
							{ label: msg("Copy"), icon: ClipboardCopy, run: () => void copy() },
							{ label: msg("Paste"), icon: ClipboardPaste, run: () => void controls.current?.paste() },
							{ label: msg("Clear"), icon: Eraser, run: () => controls.current?.clear() },
							{ label: msg("Rename"), icon: Pencil, run: () => selected && setRenaming(selected.id) },
							{ label: msg("Close"), icon: X, run: () => selected && (selected.status === "running" ? setClosing(selected) : void closeTerminal(selected)) },
						].map((item, i) => (
							<button
								key={i}
								type="button"
								onClick={() => {
									setMenuOpen(false);
									item.run();
								}}
								className="flex h-16 flex-col items-center justify-center gap-1.5 rounded-xl bg-surface-2 text-[13px] outline-none transition-transform active:scale-95"
							>
								<item.icon className="size-5 text-muted-foreground" />
								{tr(item.label)}
							</button>
						))}
					</div>
					<div className="mt-2 flex items-center justify-between rounded-xl bg-surface-2 px-4 py-2">
						<span className="text-[13px] text-muted-foreground">{t("Text size")}</span>
						<FontSizeControl size={fontSize} onChange={setFontSize} />
					</div>
					<p className="px-1 pt-1 text-center text-2xs text-subtle">{t("Pinch the terminal to change the text size.")}</p>
				</SheetContent>
			</Sheet>
		</>
	);
}

function PageSkeleton() {
	return (
		<div className="flex h-full flex-col" aria-busy aria-label={t("Loading terminal")}>
			<div className="flex h-12 items-center gap-2 border-b px-3">
				<Skeleton className="h-8 w-28" />
				<Skeleton className="h-8 w-8" />
			</div>
			<Skeleton className="m-3 flex-1 rounded-xl" />
		</div>
	);
}
