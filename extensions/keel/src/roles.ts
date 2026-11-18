import { prose, type RoleSettings } from "tau";
import type { ModelRef } from "tau/durable";
import { CodingTools } from "tau/durable";
import { Keel } from "./extension.ts";
import { publishBuild, publishVerdict, recordRuling } from "./tools.ts";

const dir = import.meta.dirname;
const form = prose(dir, "prose/documents/mandate.md", [])({});
const designerProse = prose(dir, "prose/roles/designer.md", ["form"])({ form });
const workerProse = prose(dir, "prose/roles/worker.md", [])({});
const verifierProse = prose(dir, "prose/roles/verifier.md", [])({});
export const reviseInput = prose(dir, "prose/inputs/revise.md", [
	"decision",
	"mandate",
	"annotations",
]);
export const buildInput = prose(dir, "prose/inputs/build.md", [
	"decision",
	"path",
	"branch",
	"mandate",
	"annotations",
]);
const verifySlots = [
	"sha",
	"build",
	"path",
	"base",
	"mandate",
	"summary",
	"rulings",
] as const;
export const verifyInput = prose(dir, "prose/inputs/verify.md", verifySlots);
export const reverifyInput = prose(dir, "prose/inputs/reverify.md", [
	...verifySlots,
	"blocks",
]);
export const reworkInput = prose(dir, "prose/inputs/rework.md", [
	"sha",
	"verdict",
	"blocks",
]);
export const redirectInput = prose(dir, "prose/inputs/redirect.md", [
	"sha",
	"decision",
	"notes",
	"verdict",
	"blocks",
]);
export const retryInput = prose(dir, "prose/inputs/retry.md", [
	"decision",
	"notes",
]);

/** The registered coding tool of that name, so a filter names exactly what `coding-tools` installs. */
function coding(name: string) {
	const tool = CodingTools.tools?.find((candidate) => candidate.name === name);
	if (tool === undefined) throw new Error(`coding-tools has no ${name}`);
	return tool;
}
const read = coding("read");
const write = coding("write");
const edit = coding("edit");
const bash = coding("bash");

/** An open role: the project default and Keel, without Keel's other roles' tools. */
export const designer = (model: ModelRef) =>
	({
		model,
		extensions: { add: [Keel] },
		tools: {
			remove: [write, edit, publishBuild, recordRuling, publishVerdict],
		},
		instructions: designerProse,
	}) satisfies RoleSettings;

export const worker = (model: ModelRef, cwd: string) =>
	({
		model,
		extensions: [CodingTools, Keel],
		tools: [read, write, edit, bash, recordRuling, publishBuild],
		instructions: workerProse,
		cwd,
	}) satisfies RoleSettings;

export const verifier = (model: ModelRef, cwd: string) =>
	({
		model,
		extensions: [CodingTools, Keel],
		tools: [read, bash, publishVerdict],
		cwd,
		instructions: verifierProse,
	}) satisfies RoleSettings;
