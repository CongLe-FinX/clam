import type { Catalog } from "@/i18n";
import chat from "./parts/chat.ts";
import omp from "./parts/omp.ts";
import shell from "./parts/shell.ts";

const vi: Catalog = { ...shell, ...chat, ...omp };
export default vi;
