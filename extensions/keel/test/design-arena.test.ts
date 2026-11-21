import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkId } from "../src/kernel/ids.ts";
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
	audit: {
		exists: "Orders are currently unchecked.",
		gaps: [],
		contradictions: [],
	},
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
	objections: [
		"Which account does the limit attach to?",
		"Will callers inherit that default?",
	],
});
const draft = {
	intent: "Reject orders above the limit.",
	done: "An over-limit order never reaches the venue.",
	nodes: [
		{
			label: "L1",
			rule: "Check before placing.",
			probe: "Place an over-limit order.",
		},
	],
	checks: [{ id: "P1", argv: ["check-risk"], timeoutMs: 1000 }],
	seams: [],
	never: "No bypass.",
	tradeoffs: "Check at placement rather than serialization.",
	alternatives:
		"The ledger could refuse the order, but it would see it too late.",
	settlements: [],
	riders: [
		{
			label: "R1",
			text: "Use the account default.",
			origin: "incidental",
			disposition: "bind",
		},
		{
			label: "R2",
			text: "Expose a rejected-order count.",
			origin: "seeded",
			disposition: "open",
		},
		{
			label: "R3",
			text: "Limits are measured in lots.",
			origin: "evidence",
			disposition: "bind",
		},
	],
	references: [],
};
const publish = {
	kind: "publish_mandate",
	draft,
	base: "arena_seat_1",
	grafts: [
		{ seat: "arena_seat_2", text: "Attach the check to the placement call." },
	],
	replies: [],
};
const answerChallenger = {
	kind: "answer_challenger",
	dispositions: [
		{ n: 1, status: "considered", reason: "The account is named in R1." },
		{
			n: 2,
			status: "dismissed",
			reason: "The default is local to each account.",
		},
	],
};

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
	const jobs = effect.spec.jobs as {
		seat: string;
		question: string;
		model: string;
	}[];
	return { key: effect.key, jobs };
}
function complete(s: State, answers: Record<string, string | null>, w = world) {
	const { jobs, key } = pending(s, w);
	return step(
		s,
		{
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
		},
		w,
	).state;
}

test("Ground opens framing, not review or direct Mandate publication; candidate plans pin one shared question and the resolved models", () => {
	const s = grounded();
	assert.deepEqual(design.agents(s, world)[0]?.expects[0]?.tools, [
		"frame_arena",
	]);
	assert.deepEqual(design.asks(s, world), []);
	assert.ok("reject" in design.reduce(s, { kind: "publish_mandate" }, world));
	assert.ok("reject" in design.reduce(s, { ...frame, rubric: " " }, world));
	const framed = step(s, frame).state;
	const plan = pending(framed);
	assert.deepEqual(
		plan.jobs.map(({ seat, model }) => [seat, model]),
		[
			["arena_seat_1", "alpha/first"],
			["arena_seat_2", "beta/second"],
		],
	);
	assert.equal(plan.jobs[0]?.question, plan.jobs[1]?.question);
	assert.match(plan.jobs[0]!.question, /Where does the limit belong/);
	assert.match(plan.jobs[0]!.question, /invariant locality/);
	assert.match(plan.jobs[0]!.question, /Orders are currently unchecked/);
	assert.deepEqual(design.asks(framed, world), []);
	assert.deepEqual(
		pending(framed, {
			...world,
			options: { ...world.options, arena_seat_1: "other/changed" },
		}),
		plan,
	);
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
		const expected =
			"designer" in overrides ? ["arena_judge", "designer"] : seats;
		for (const option of expected) assert.ok(ask.basis.includes(option));
		assert.ok(ask.choices.includes("retry"));
		const next = step(framed, {
			kind: "answered",
			subject: ask.subject,
			choice: "retry",
			annotations: [],
		}).state;
		assert.deepEqual(
			pending(next).jobs.map((job) => job.seat),
			seats,
		);
	}
});

test("an optional third candidate joins in order and the judge receives every full candidate and the rubric next", () => {
	const w = {
		...world,
		options: { ...world.options, arena_seat_3: "gamma/third" },
	};
	const framed = step(grounded(w), frame, w).state;
	const names = [...seats, "arena_seat_3"];
	assert.deepEqual(
		pending(framed, w).jobs.map(({ seat }) => seat),
		names,
	);
	const judged = complete(
		framed,
		Object.fromEntries(names.map((seat) => [seat, candidate(seat)])),
		w,
	);
	const [job] = pending(judged, w).jobs;
	assert.equal(job?.seat, "arena_judge");
	assert.equal(job?.model, "judge/review");
	for (const seat of names) assert.ok(job.question.includes(candidate(seat)));
	assert.ok(job.question.includes(frame.rubric));
	assert.deepEqual(design.asks(judged, w), []);
});

const candidates = Object.fromEntries(
	seats.map((seat) => [seat, candidate(seat)]),
);
const candidateTurn = () => step(grounded(), frame).state;
const judgeTurn = () => complete(candidateTurn(), candidates);
const synthesisTurn = (s = judgeTurn()) => complete(s, { arena_judge: judge });
const challengeTurn = (s = synthesisTurn(), event: LaneEvent = publish) =>
	step(s, event).state;
const answeringTurn = (s = challengeTurn()) =>
	complete(s, { arena_challenger: objections });
const firstReview = () => step(answeringTurn(), answerChallenger).state;
function ask(s: State) {
	const [current, ...extra] = design.asks(s, world);
	assert.ok(current);
	assert.deepEqual(extra, []);
	return current;
}
function owner(
	s: State,
	choice: string,
	annotations: LaneEvent["annotations"] = [],
) {
	const { subject, choices } = ask(s);
	assert.ok(choices.includes(choice));
	return step(s, {
		kind: "answered",
		subject,
		choice,
		decision: "owner-answer",
		annotations,
	});
}
function input(s: State) {
	return design.agents(s, world)[0]?.expects[0]?.input?.() ?? "";
}

test("a timed-out child or a candidate that omits its unasked decisions cannot start judging; retries get a new plan key and old facts do not advance it", () => {
	for (const answer of [
		null,
		candidate(seats[1]!).split("\n\n## Unasked Decisions")[0]!,
	]) {
		const s = candidateTurn();
		const { key, jobs } = pending(s);
		const failed = complete(s, { ...candidates, [seats[1]!]: answer });
		assert.deepEqual(design.effects(failed, world), []);
		assert.match(
			ask(failed).basis,
			answer === null ? /Child timed out/ : /Unasked Decisions/,
		);
		assert.match(ask(failed).basis, /arena_seat_2/);
		const retried = owner(failed, "retry").state;
		assert.notEqual(pending(retried).key, key);
		assert.deepEqual(pending(retried).jobs, jobs);
		assert.deepEqual(
			step(retried, { kind: "effect_failed", key, error: "Late failure" })
				.state,
			retried,
		);
		assert.equal(
			pending(complete(retried, candidates)).jobs[0]?.seat,
			"arena_judge",
		);
	}
});

test("a failed effect, out-of-order result, or incomplete judge report stays blocked rather than skipping a stage", () => {
	const s = judgeTurn();
	const { key } = pending(s);
	const failed = step(s, {
		kind: "effect_failed",
		key,
		error: "The runner failed.",
	}).state;
	assert.match(ask(failed).basis, /The runner failed/);
	assert.deepEqual(design.effects(failed, world), []);
	const dispatching = candidateTurn();
	const reversed = step(dispatching, {
		kind: "effect_done",
		key: pending(dispatching).key,
		result: {
			results: seats.toReversed().map((seat) => ({
				seat,
				conversation: seat,
				answer: candidate(seat),
				error: null,
			})),
		},
	}).state;
	assert.match(ask(reversed).basis, /result/i);
	const incomplete = complete(s, {
		arena_judge: JSON.stringify({ base: seats[0], scores: [] }),
	});
	assert.match(ask(incomplete).basis, /score/i);
	assert.deepEqual(design.effects(incomplete, world), []);
	assert.equal(input(incomplete), "");
});

test("synthesis must name real sources, and the challenged Mandate cannot reach review until each objection has a disposition", () => {
	const s = synthesisTurn();
	assert.match(input(s), /Judge's independent observation of arena_seat_1/);
	assert.ok(
		"reject" in design.reduce(s, { ...publish, base: "missing" }, world),
	);
	assert.ok(
		"reject" in
			design.reduce(
				s,
				{ ...publish, grafts: [{ seat: "missing", text: "A graft." }] },
				world,
			),
	);
	const challenge = challengeTurn(s);
	const [job] = pending(challenge).jobs;
	assert.ok(job);
	assert.equal(job.seat, "arena_challenger");
	assert.equal(job.model, world.options.design);
	for (const part of [
		"what did the winning candidate decide that the question did not ask?",
		"what will the implementer copy from the nearest example?",
		"Attach the check to the placement call.",
		"Use the account default.",
		"Default of arena_seat_1",
	])
		assert.ok(job.question.toLowerCase().includes(part.toLowerCase()), part);
	assert.deepEqual(design.asks(challenge, world), []);
	const malformed = complete(challenge, { arena_challenger: "No objections" });
	assert.match(ask(malformed).basis, /objections/i);
	const answering = answeringTurn(challenge);
	assert.deepEqual(design.asks(answering, world), []);
	assert.match(input(answering), /Which account/);
	assert.ok(
		"reject" in
			design.reduce(
				answering,
				{
					...answerChallenger,
					dispositions: answerChallenger.dispositions.slice(1),
				},
				world,
			),
	);
	assert.ok(
		"reject" in
			design.reduce(
				answering,
				{
					...answerChallenger,
					dispositions: [
						answerChallenger.dispositions[0]!,
						answerChallenger.dispositions[0]!,
					],
				},
				world,
			),
	);
	const review = step(answering, answerChallenger).state;
	const decision = ask(review);
	for (const seat of seats) assert.ok(decision.basis.includes(candidate(seat)));
	for (const part of [
		draft.intent,
		"Attach the check to the placement call.",
		"Judge's score for arena_seat_2",
		"Which account does the limit attach to?",
		"The account is named in R1.",
		"Use the account default.",
		"Expose a rejected-order count.",
		"Limits are measured in lots.",
	])
		assert.ok(decision.basis.includes(part), part);
	assert.deepEqual(design.effects(review, world), []);
	assert.equal(input(review), "");
});

test("the owner's candidate choice pins the next synthesis base, retains the earlier round, and asks again before binding", () => {
	const first = firstReview();
	const note = "Retain account ownership with this base.";
	const taken = owner(first, "base:arena_seat_2", [{ n: 1, text: note }]);
	assert.deepEqual(taken.send ?? [], []);
	assert.deepEqual(design.effects(taken.state, world), []);
	assert.deepEqual(design.asks(taken.state, world), []);
	assert.match(input(taken.state), /arena_seat_2/);
	assert.match(input(taken.state), /Retain account ownership/);
	assert.ok("reject" in design.reduce(taken.state, publish, world));
	const second = { ...publish, base: "arena_seat_2", grafts: [] };
	assert.ok("reject" in design.reduce(taken.state, second, world));
	const challenged = challengeTurn(taken.state, {
		...second,
		replies: [{ n: 1, status: "acted_on", reason: "Kept account ownership." }],
	});
	const review = step(answeringTurn(challenged), answerChallenger).state;
	assert.notEqual(ask(review).subject, ask(first).subject);
	assert.match(ask(review).basis, /Retain account ownership/);
	assert.match(ask(review).basis, /Kept account ownership/);
	assert.equal(review.rounds[0]?.answer?.choice, "base:arena_seat_2");
	const approved = owner(review, "approve");
	assert.equal(approved.send?.[0]?.event.kind, "bound");
	assert.ok(approved.state.mandate?.nodes.some((node) => node.label === "R1"));
	assert.equal(approved.state.mandate?.delegated[0]?.label, "R2");
});

test("seeded and fresh arenas keep the old candidates, judge, challenger and round; only seeded candidates receive the old review", () => {
	for (const choice of ["arena", "arena_fresh"]) {
		const first = firstReview();
		const rerun = owner(first, choice, [
			{ n: 1, text: "Measure ownership independently." },
		]);
		const fresh = choice === "arena_fresh";
		assert.deepEqual(rerun.send ?? [], []);
		assert.match(input(rerun.state), /Measure ownership independently/);
		assert.equal(input(rerun.state).includes(candidate(seats[0]!)), !fresh);
		const next = step(rerun.state, {
			...frame,
			question: "What scopes the risk limit?",
		}).state;
		assert.deepEqual(
			next.rounds[0]?.dispositions,
			answerChallenger.dispositions,
		);
		assert.equal(next.rounds[0]?.answer?.choice, choice);
		assert.deepEqual(next.arenas[0], first.arenas[0]);
		assert.notEqual(pending(next).key, pending(candidateTurn()).key);
		const job = pending(next).jobs[0]!;
		assert.equal(job.question.includes(candidate(seats[0]!)), !fresh);
		assert.equal(
			job.question.includes("Measure ownership independently."),
			!fresh,
		);
		assert.match(job.question, /What scopes the risk limit/);
	}
});

test("rework preserves the first round, rechallenges the amended synthesis, and replies by annotation number", () => {
	const first = firstReview();
	const revised = owner(first, "rework", [
		{ n: 1, text: "Drop the incidental default." },
	]).state;
	assert.match(input(revised), /Drop the incidental default/);
	const newer = { ...draft, riders: draft.riders.slice(1) };
	const challenged = challengeTurn(revised, {
		...publish,
		draft: newer,
		replies: [{ n: 1, status: "acted_on", reason: "Dropped R1." }],
	});
	assert.ok(
		!pending(challenged).jobs[0]?.question.includes("Use the account default."),
	);
	assert.notEqual(pending(challenged).key, pending(challengeTurn()).key);
	const review = step(answeringTurn(challenged), answerChallenger).state;
	assert.match(ask(review).basis, /rider R1 removed/);
	assert.match(ask(review).basis, /Dropped R1/);
	assert.deepEqual(review.rounds[0]?.draft, draft);
});

test("declining after review or a failed dispatch leaves no effects, owner decision, or designer expectation running", () => {
	for (const s of [
		firstReview(),
		complete(candidateTurn(), { ...candidates, [seats[1]!]: null }),
	]) {
		const { state, send } = owner(s, "decline");
		assert.deepEqual(send ?? [], []);
		assert.deepEqual(design.effects(state, world), []);
		assert.deepEqual(design.asks(state, world), []);
		assert.deepEqual(design.agents(state, world)[0]?.expects, []);
		assert.equal(state.mandate, null);
	}
});

test("a stopped designer resumes the same arena turn under a new expectation without starting another effect", () => {
	for (const s of [grounded(), synthesisTurn(), answeringTurn()]) {
		const [turn] = design.agents(s, world)[0]!.expects;
		assert.ok(turn);
		const held = step(s, {
			kind: "agent_stalled",
			agent: "designer",
			tokens: [turn.token],
			cause: "stopped",
			lastWords: "Still checking the evidence.",
		});
		assert.ok(held.send?.[0]);
		assert.equal(input(held.state), "");
		const resumed = step(held.state, {
			kind: "resume",
			cause: held.send[0].event.cause!,
			direction: "Continue this turn.",
			evidence: "Stopped.",
		}).state;
		const [after] = design.agents(resumed, world)[0]!.expects;
		assert.ok(after);
		assert.notEqual(after.token, turn.token);
		assert.deepEqual(after.tools, turn.tools);
		assert.match(input(resumed), /Continue this turn/);
		assert.deepEqual(design.effects(resumed, world), []);
	}
});

test("cancelling a pending arena withdraws its effect and an old completion cannot start its next stage", () => {
	const s = candidateTurn();
	const key = pending(s).key;
	const cancelled = step(s, { kind: "cancel" }).state;
	assert.deepEqual(design.effects(cancelled, world), []);
	assert.deepEqual(
		step(cancelled, { kind: "effect_done", key, result: {} }).state,
		cancelled,
	);
});
