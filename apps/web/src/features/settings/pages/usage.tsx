import { t } from "@/i18n";
import { UsageDashboard } from "@/features/usage/dashboard";
import { PageBody, PageIntro } from "../components/section";

export default function UsagePage() {
	return (
		<>
			<PageIntro
				title={t("LLM Usage")}
				description={t("Token consumption and cost recorded by OMP on this machine, plus quota reported by each provider. Every figure is labeled with where it comes from; nothing is guessed.")}
			/>
			<PageBody>
				<UsageDashboard />
			</PageBody>
		</>
	);
}
