import { subject, type WorkId } from "./kernel/ids.ts";
import { type Ask, type KernelEvent, prose } from "./kernel/lane.ts";

const dir = `${import.meta.dirname}/prose/documents`;
const action = (name: string) =>
	prose(`${dir}/resume`, `${name}.md`, [])({}).trim();
export const resumption = {
	discovery: action("discovery"),
	moved: action("moved"),
	occupied: action("occupied"),
	worker: action("worker"),
	coordinator: action("coordinator"),
	replan: action("replan"),
	trunk: action("trunk"),
	diagnosis: action("diagnosis"),
	pinned: prose(`${dir}/resume`, "pinned.md", ["operation"]),
	stalled: prose(`${dir}/resume`, "stalled.md", ["agent"]),
};

export const holdingBasis = prose(dir, "holding-finding.md", [
	"goal",
	"scope",
	"evidence",
	"resume",
]);
export const holdingScope = (lane: string, item: string | null) =>
	item ? `${lane}/${item}` : lane;
export const holdingSubject = (work: WorkId, lane: string, cause: string) =>
	subject(`finding/${work}/${lane}/${cause}`);
export function holdingAsk(
	work: WorkId,
	lane: string,
	cause: string,
	basis: string,
): Ask {
	return {
		subject: holdingSubject(work, lane, cause),
		title: basis.split("\n", 1)[0] ?? basis,
		basis,
		choices: ["resume", "cancel"],
		works: [work],
	};
}

export const directions = (fact: Extract<KernelEvent, { kind: "answered" }>) =>
	fact.annotations.map((a) => `${a.n}. ${a.text}`).join("\n");
