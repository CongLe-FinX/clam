import { type AgentSession, type ModelInfo, routes } from "@clam/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { FolderOpen, MessageSquarePlus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { rememberInitialPrompt } from "@/lib/initial-prompt";
import { qk } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Field } from "@/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Textarea } from "@/ui/textarea";

const DEFAULT_MODEL = "__default__";

/** Start a plain chat with an agent: no project, no repository. The machine gives the chat its own folder. */
export default function NewChatDialog({ onClose }: { onClose: () => void }) {
	const qc = useQueryClient();
	const navigate = useNavigate();
	const [prompt, setPrompt] = useState("");
	const [model, setModel] = useState(DEFAULT_MODEL);
	const models = useQuery({ queryKey: qk.ompModels, queryFn: ({ signal }) => api.get<ModelInfo[]>(routes.ompModels, undefined, { signal }), staleTime: 5 * 60_000 });

	const create = useMutation({
		mutationFn: () =>
			api.post<AgentSession>(routes.sessions, {
				model: model === DEFAULT_MODEL ? undefined : model,
				prompt: prompt.trim() || undefined,
			}),
		onSuccess: (s) => {
			qc.setQueryData(qk.session(s.id), s);
			if (prompt.trim()) rememberInitialPrompt(s.id, prompt);
			void qc.invalidateQueries({ queryKey: qk.sessionsAll });
			void qc.invalidateQueries({ queryKey: qk.projectsAll });
			void qc.invalidateQueries({ queryKey: qk.workspaces });
			onClose();
			void navigate({ to: "/sessions/$sessionId", params: { sessionId: s.id } });
		},
		onError: (e) => toast.error(errorMessage(e)),
	});

	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent sheetOnMobile>
				<DialogHeader>
					<DialogTitle>New chat</DialogTitle>
					<DialogDescription>Talk to an agent about anything: research, writing, images, video. You can invite agents on other machines from the chat.</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-4 overflow-y-auto"
					onSubmit={(e) => {
						e.preventDefault();
						create.mutate();
					}}
				>
					<p className="flex gap-2 rounded-lg bg-surface-2 p-3 text-xs text-muted-foreground">
						<FolderOpen aria-hidden className="mt-0.5 size-3.5 shrink-0 text-accent" />
						<span>No repository needed — the agent gets its own folder for notes, reports and media. Browse, preview and download its files from the Files panel.</span>
					</p>
					<Field label="What should the agent do?" hint="Optional — sent as soon as the agent is ready">
						{(id) => (
							<Textarea
								id={id}
								autoFocus
								value={prompt}
								onChange={(e) => setPrompt(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
										e.preventDefault();
										create.mutate();
									}
								}}
								rows={4}
								placeholder="e.g. Research the history of the bicycle and write a one-page report."
							/>
						)}
					</Field>
					<Field label="Model">
						{() => (
							<Select value={model} onValueChange={setModel}>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={DEFAULT_MODEL}>OMP default</SelectItem>
									{models.data?.map((m) => (
										<SelectItem key={m.selector} value={m.selector}>
											<span className={cn("font-mono text-xs")}>{m.selector}</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)}
					</Field>
					<DialogFooter>
						<Button variant="ghost" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" variant="primary" loading={create.isPending}>
							<MessageSquarePlus /> Start chat
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
