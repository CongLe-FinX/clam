import type { Catalog } from "../core";
import app from "./vi/app.ts";
import components from "./vi/components.ts";
import lib from "./vi/lib.ts";

const vi: Catalog = { ...app, ...components, ...lib };
export default vi;
