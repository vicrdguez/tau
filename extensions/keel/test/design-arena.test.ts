import assert from "node:assert/strict";
import { test } from "node:test";
import type { EffectKey, WorkId } from "../src/kernel/ids.ts";
import type { LaneEvent, World } from "../src/kernel/lane.ts";
import { design } from "../src/lanes/design/index.ts";
import { drive } from "./fixtures/drive.ts";

// Scripted model contract: frame_arena({question, rubric}), then child `answer` text
// in the formats below. The designer calls publish_mandate({draft, base, grafts,
// replies}), including on rework, then answer_challenger({dispositions}).
const world: World = {
	work: 17 as WorkId,
	root: "/project",
	now: 1,
	view: () => null,
	options: {
		design: "design/default",
		arena_seat_1: "alpha/first",
		arena_seat_2: "beta/second",
		arena_judge: "judge/review",
		build: "build/default",
		verify: "verify/default",
		queue: "queue/default",
		max_workers: 3,
		base: "main",
		trunk: "trunk",
	},
};
const seats = ["arena_seat_1", "arena_seat_2"];
const ground = {
	kind: "ground",
	route: "precedent",
	reference: "Introduce a first risk limit.",
	audit: { exists: "Orders are currently unchecked.", gaps: [], contradictions: [] },
};
const frame = {
	kind: "frame_arena",
	question: "Where does the limit belong?",
	rubric: "Score invariant locality and ease of changing the limit.",
};
const candidate = (seat: string) =>
	`## Usage\nCall site of ${seat}\n\n## Sketch\nSketch of ${seat}\n\n## Rationale\nReason of ${seat}\n\n## Unasked Decisions\nDefault of ${seat}`;
const judge = JSON.stringify({
	base: seats[0],
	scores: seats.map((seat, i) => ({
		seat,
		score: 9 - i,
		reason: `Judge's score for ${seat}`,
		unaskedDecisions: `Judge's independent observation of ${seat}`,
	})),
});
const objections = JSON.stringify({
	objections: ["Which account does the limit attach to?"],
});

type State = ReturnType<typeof design.state.initial>;
function step(s: State, event: LaneEvent, w = world) {
	const result = drive(design, s, event, w);
	assert.ok(!("reject" in result), JSON.stringify(result));
	return result;
}
function grounded(w = world) {
	return step(design.state.initial(), ground, w).state;
}
function pending(s: State, w = world) {
	const [effect, ...extra] = design.effects(s, w);
	assert.ok(effect);
	assert.deepEqual(extra, []);
	assert.equal(effect.spec.kind, "arena_dispatch");
	const jobs = effect.spec.jobs as { seat: string; question: string; model: string }[];
	return { key: effect.key, jobs };
}
function complete(s: State, answers: Record<string, string | null>, w = world) {
	const { jobs, key } = pending(s, w);
	return step(s, {
		kind: "effect_done",
		key,
		result: {
			results: jobs.map(({ seat }, i) => ({
				seat,
				conversation: `${key}/${i}`,
				answer: answers[seat] ?? null,
				error: answers[seat] === null ? "Child timed out." : null,
			})),
		},
	}, w).state;
}

test("Ground opens framing, not review or direct Mandate publication; candidate plans pin one shared question and the resolved models", () => {
	const s = grounded();
	assert.deepEqual(design.agents(s, world)[0]?.expects[0]?.tools, ["frame_arena"]);
	assert.deepEqual(design.asks(s, world), []);
	assert.ok("reject" in design.reduce(s, { kind: "publish_mandate" }, world));
	assert.ok("reject" in design.reduce(s, { ...frame, rubric: " " }, world));
	const framed = step(s, frame).state;
	const plan = pending(framed);
	assert.deepEqual(plan.jobs.map(({seat, model}) => [seat, model]), [
		["arena_seat_1", "alpha/first"], ["arena_seat_2", "beta/second"],
	]);
	assert.equal(plan.jobs[0]?.question, plan.jobs[1]?.question);
	assert.match(plan.jobs[0]!.question, /Where does the limit belong/);
	assert.match(plan.jobs[0]!.question, /invariant locality/);
	assert.match(plan.jobs[0]!.question, /Orders are currently unchecked/);
	assert.deepEqual(design.asks(framed, world), []);
	assert.deepEqual(pending(framed, { ...world, options: { ...world.options, arena_seat_1: "other/changed" } }), plan);
});

test("same-family candidates or a judge on the designer's override family block all dispatch and name the owner options to fix", () => {
	for (const overrides of [
		{ arena_seat_2: "alpha/other" },
		{ designer: "judge/designer" },
	]) {
		const w = { ...world, options: { ...world.options, ...overrides } };
		const framed = step(grounded(w), frame, w).state;
		assert.deepEqual(design.effects(framed, w), []);
		const [ask] = design.asks(framed, w);
		assert.ok(ask);
		const expected = "designer" in overrides ? ["arena_judge", "designer"] : seats;
		for (const option of expected) assert.ok(ask.basis.includes(option));
		assert.ok(ask.choices.includes("retry"));
		const next = step(framed, { kind: "answered", subject: ask.subject, choice: "retry", annotations: [] }).state;
		assert.deepEqual(pending(next).jobs.map((job) => job.seat), seats);
	}
});

test("an optional third candidate joins in order and the judge receives every full candidate and the rubric next", () => {
	const w = { ...world, options: { ...world.options, arena_seat_3: "gamma/third" } };
	const framed = step(grounded(w), frame, w).state;
	const names = [...seats, "arena_seat_3"];
	assert.deepEqual(pending(framed, w).jobs.map(({ seat }) => seat), names);
	const judged = complete(framed, Object.fromEntries(names.map((seat) => [seat, candidate(seat)])), w);
	const [job] = pending(judged, w).jobs;
	assert.equal(job?.seat, "arena_judge");
	assert.equal(job?.model, "judge/review");
	for (const seat of names) assert.ok(job.question.includes(candidate(seat)));
	assert.ok(job.question.includes(frame.rubric));
	assert.deepEqual(design.asks(judged, w), []);
});
