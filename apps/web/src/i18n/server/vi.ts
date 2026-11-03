import type { Catalog } from "../core";
import a from "./vi/part-a.ts";
import b from "./vi/part-b.ts";
import c from "./vi/part-c.ts";
import d from "./vi/part-d.ts";
import e from "./vi/part-e.ts";
import f from "./vi/part-f.ts";
import g from "./vi/part-g.ts";

const vi: Catalog = { ...a, ...b, ...c, ...d, ...e, ...f, ...g };
export default vi;
