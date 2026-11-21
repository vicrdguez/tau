import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { prose } from "tau";
import type { RenderInput } from "../kernel/reconcile.ts";
import type { ProjectPrincipleFile } from "../repo/index.ts";
import { ROLES } from "../roles/index.ts";
import { overlapsFence } from "./fences.ts";

type Principle = {
	name: string;
	description: string;
	body: string;
	roles: string[];
	paths: string[];
};
const dir = import.meta.dirname;
const input = prose(dir, "../prose/documents/principle-input.md", [
	"task",
	"principles",
]);
const review = prose(dir, "../prose/documents/project-principles.md", [
	"task",
	"descriptions",
]);

function scalar(s: string) {
	const v = s.trim();
	if (v.startsWith('"')) {
		const parsed: unknown = JSON.parse(v);
		if (typeof parsed !== "string") throw Error("Expected a quoted string");
		return parsed;
	}
	if (v.startsWith("'") && v.endsWith("'"))
		return v.slice(1, -1).replaceAll("''", "'");
	return v;
}

// One description and optional scalar lists, in flow or block form. No YAML dependencies.
function parse(file: string, name: string, source: string): Principle {
	const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source);
	if (!m) throw new Error(`Missing principle frontmatter: ${file}`);
	const p: Principle = {
		name,
		description: "",
		roles: [],
		paths: [],
		body: m[2]!.trim(),
	};
	let list: string[] | undefined;
	for (const line of m[1]!.split(/\r?\n/u)) {
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		const item = /^\s*-\s+(.+)$/.exec(line);
		if (list && item) {
			list.push(scalar(item[1]!));
			continue;
		}
		list = undefined;
		const pair = /^(description|roles|paths):\s*(.*)$/.exec(line);
		if (!pair)
			throw new Error(`Invalid principle frontmatter in ${file}: ${line}`);
		const value = pair[2]!.trim();
		if (pair[1] === "description") {
			p.description = scalar(value);
			continue;
		}
		list = pair[1] === "roles" ? p.roles : p.paths;
		if (!value) continue;
		if (!value.startsWith("[") || !value.endsWith("]"))
			throw new Error(`Expected a list in ${file}: ${line}`);
		const inside = value.slice(1, -1).trim();
		// JSON lists allow quoted globs containing commas; plain YAML lists allow bare role names.
		if (inside.startsWith('"')) {
			const items: unknown = JSON.parse(value);
			if (!Array.isArray(items) || !items.every((x) => typeof x === "string"))
				throw Error(`Expected strings in ${file}: ${line}`);
			list.push(...items);
		} else if (inside) list.push(...inside.split(",").map(scalar));
	}
	if (!p.description || !p.body)
		throw new Error(`A principle needs a description and a body: ${file}`);
	for (const role of p.roles)
		if (!Object.hasOwn(ROLES, role))
			throw new Error(`Unknown role ${JSON.stringify(role)}`);
	return p;
}
function readDirectory(
	path: string,
	project = false,
	pinned?: readonly ProjectPrincipleFile[],
) {
	const principles: Principle[] = [];
	const errors: string[] = [];
	function unavailable(file: string, error: unknown) {
		if (!project) throw error;
		errors.push(
			`Unavailable project principle ${file}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	function add(name: string, source: () => string) {
		const file = join(path, `${name}.md`);
		try {
			principles.push(parse(file, name, source()));
		} catch (error) {
			unavailable(file, error);
		}
	}
	if (pinned) {
		for (const { name, body } of pinned) add(name, () => body);
		return { principles, errors };
	}
	let files: Dirent[];
	try {
		files = readdirSync(path, { withFileTypes: true });
	} catch (error) {
		if (!project || (error as NodeJS.ErrnoException).code !== "ENOENT")
			unavailable(path, error);
		return { principles, errors };
	}
	for (const file of files
		.filter((f) => f.isFile() && f.name.endsWith(".md"))
		.map((f) => f.name)
		.sort()) {
		add(file.slice(0, -3), () => readFileSync(join(path, file), "utf8"));
	}
	return { principles, errors };
}
const { principles: keel } = readDirectory(join(dir, "../prose/principles"));
function project(
	cwd: string | null | undefined,
	pinned?: readonly ProjectPrincipleFile[],
) {
	const local =
		cwd || pinned
			? readDirectory(join(cwd ?? "", ".keel/principles"), true, pinned)
			: { principles: [], errors: [] };
	for (const p of local.principles)
		if (keel.some((k) => k.name === p.name)) p.name = `project/${p.name}`;
	return local;
}
const descriptions = (ps: Principle[]) =>
	ps.map((p) => `${p.name}: ${p.description}`).join("\n");

export function indexFor(
	cwd: string | null | undefined,
	tools: readonly { name: string }[],
	pinned?: readonly ProjectPrincipleFile[],
) {
	if (!tools.some((t) => t.name === "principle")) return undefined;
	const local = project(cwd, pinned);
	return [descriptions([...keel, ...local.principles]), ...local.errors].join(
		"\n",
	);
}
export function bodyOf(
	cwd: string | null | undefined,
	name: string,
	pinned?: readonly ProjectPrincipleFile[],
) {
	return [...keel, ...project(cwd, pinned).principles].find(
		(p) => p.name === name,
	)?.body;
}

const table = [
	{
		role: "designer",
		situation: "shape",
		by: "bound",
		names: ["model-the-domain"],
	},
	{
		role: "worker",
		situation: "survived_fix",
		by: "triggered",
		names: ["attack-the-premise"],
	},
	{
		role: "diagnoser",
		situation: "diagnosis",
		by: "triggered",
		names: ["attack-the-premise", "fix-root-causes"],
	},
] as const;

export const render: RenderInput = (
	{ role, cwd, situation, paths = [], projectPrinciples },
	task,
) => {
	const { principles: local, errors } = project(cwd, projectPrinciples);
	const bound = local.filter(
		(p) =>
			p.roles.includes(role) ||
			p.paths.some((pattern) =>
				paths.some((path) => overlapsFence(path, pattern)),
			),
	);
	const triggered: Principle[] = [];
	for (const row of table) {
		if (row.role !== role || row.situation !== situation) continue;
		for (const name of row.names)
			(row.by === "bound" ? bound : triggered).push(
				keel.find((p) => p.name === name)!,
			);
	}
	const ps = [...bound, ...triggered];
	const text = ps.length
		? input({
				task,
				principles: ps.map((p) => `${p.name}\n\n${p.body}`).join("\n\n"),
			})
		: task;
	const reviewed =
		role === "verifier" && local.length
			? review({ task: text, descriptions: descriptions(local) })
			: text;
	return {
		text: [reviewed, ...errors].join("\n\n"),
		...(ps.length && {
			data: {
				bound: bound.map((p) => p.name),
				triggered: triggered.map((p) => p.name),
			},
		}),
	};
};
