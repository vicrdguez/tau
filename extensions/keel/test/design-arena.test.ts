import assert from "node:assert/strict";
import { test } from "node:test";
import type { LaneEvent, World } from "../src/kernel/lane.ts";
import { design } from "../src/lanes/design/index.ts";
import { replyJson } from "../src/reply-json.ts";
import { dispatchResult } from "./fixtures/design-review.ts";
import { drive, laneWorld } from "./fixtures/drive.ts";

const world = laneWorld({
	options: {
		design: "design/default",
		arena_seat_1: "alpha/first",
		arena_seat_2: "beta/second",
		arena_judge: "judge/review",
	},
});
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
	`## Usage\nCall site of ${seat}\n\n## Sketch\nSketch of ${seat}\n\n## Rationale\nReason of ${seat}\n\n## Unasked decisions\nDefault of ${seat}`;
const judge = JSON.stringify({
	base: seats[0],
	scores: seats.map((seat, i) => ({
		seat,
		score: 9 - i,
		reason: `Judge's score for ${seat}`,
		unaskedDecisions: [`Judge's independent observation of ${seat}`],
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
		{
			seat: "arena_seat_2",
			label: "L1",
			text: "Attach the check to the placement call.",
		},
	],
	outcomes: [
		{ source: "arena_seat_1", n: 1, label: "R1" },
		{ source: "arena_seat_2", n: 1, label: "L1" },
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
function effect(s: State, w = world) {
	const [effect] = design.effects(s, w);
	assert.ok(effect, "expected an arena effect");
	return effect;
}
function pending(s: State, w = world) {
	const { key, spec } = effect(s, w);
	return {
		key,
		jobs: spec.jobs as { seat: string; question: string; model: string }[],
	};
}
function complete(s: State, answers: Record<string, string | null>, w = world) {
	const planned = effect(s, w);
	return step(
		s,
		{
			kind: "effect_done",
			key: planned.key,
			result: dispatchResult(planned, (seat) => answers[seat] ?? null),
		},
		w,
	).state;
}

test("Ground opens framing, not review or direct Mandate publication; candidate plans pin one shared question and the resolved models", () => {
	const s = grounded();
	assert.deepEqual(design.agents(s, world)[0]?.expects[0]?.tools, [
		"frame_arena",
		"start_experiment",
	]);
	assert.deepEqual(design.asks(s, world), []);
	assert.ok("reject" in design.reduce(s, { kind: "publish_mandate" }, world));
	assert.ok("reject" in design.reduce(s, { ...frame, rubric: " " }, world));
	const framed = step(s, frame).state;
	const declarations = design.effects(framed, world);
	assert.equal(declarations.length, 1);
	assert.equal(declarations[0]!.spec.kind, "arena_dispatch");
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
	for (const model of ["alpha/first", "beta/second", "gamma/third"])
		assert.ok(!job.question.includes(model));
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
		candidate(seats[1]!).split("\n\n## Unasked decisions")[0]!,
		"## Unasked Decisions\n\n  \t\n\n## Other evidence\nText under another heading.",
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
		assert.deepEqual(pending(retried).jobs, jobs.slice(1));
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

test("retry checks the failed seat's current provider against the actual successful seat and keeps its answer", () => {
	const failed = complete(candidateTurn(), {
		...candidates,
		[seats[1]!]: null,
	});
	const retry = (state: State, w: World) =>
		step(
			state,
			{
				kind: "answered",
				subject: ask(state).subject,
				choice: "retry",
				annotations: [],
			},
			w,
		).state;
	const conflict = retry(failed, {
		...world,
		options: {
			...world.options,
			arena_seat_1: "unrelated/changed",
			arena_seat_2: "alpha/other",
		},
	});
	assert.deepEqual(design.effects(conflict, world), []);
	assert.match(ask(conflict).basis, /provider.*family|family.*provider/i);
	assert.match(
		ask(conflict).basis,
		/Set `arena_seat_2` to a different provider from `alpha`/,
	);
	assert.doesNotMatch(ask(conflict).basis, /arena_seat_1|unrelated/);
	const revised = retry(conflict, {
		...world,
		options: { ...world.options, arena_seat_2: "gamma/fixed" },
	});
	assert.deepEqual(
		pending(revised).jobs.map(({ seat, model }) => [seat, model]),
		[[seats[1], "gamma/fixed"]],
	);
	const judge = pending(complete(revised, candidates)).jobs[0]!;
	assert.ok(judge.question.includes(candidate(seats[0]!)));
});

test("judge and challenger retries use current models without invalidating seats that already answered", () => {
	const retry = (state: State, overrides: Partial<World["options"]>) =>
		step(
			state,
			{
				kind: "answered",
				subject: ask(state).subject,
				choice: "retry",
				annotations: [],
			},
			{ ...world, options: { ...world.options, ...overrides } },
		).state;
	const failedJudge = complete(judgeTurn(), { arena_judge: null });
	const badJudge = retry(failedJudge, { arena_judge: "design/judge" });
	assert.match(
		ask(badJudge).basis,
		/Set `arena_judge` to a different provider from `design`/,
	);
	assert.doesNotMatch(ask(badJudge).basis, /`designer`|arena_seat_/);
	const retriedJudge = retry(badJudge, { arena_judge: "review/corrected" });
	assert.deepEqual(
		pending(retriedJudge).jobs.map(({ seat, model }) => [seat, model]),
		[["arena_judge", "review/corrected"]],
	);
	const failedChallenge = complete(challengeTurn(synthesisTurn(retriedJudge)), {
		arena_challenger: null,
	});
	const retriedChallenge = retry(failedChallenge, {
		arena_challenger: "alpha/challenger",
		designer: "review/new-designer",
	});
	assert.deepEqual(
		pending(retriedChallenge).jobs.map(({ seat, model }) => [seat, model]),
		[["arena_challenger", "alpha/challenger"]],
	);
	assert.equal(answeringTurn(retriedChallenge).phase, "answering");
});

test("candidate headings are case-insensitive and nested defaults reach the judge; it may use decimal scores in a fenced report", () => {
	const turn = complete(candidateTurn(), {
		...candidates,
		[seats[1]!]:
			"### UNASKED DECISIONS\n#### Defaults\nName the limit by account.",
	});
	assert.match(pending(turn).jobs[0]!.question, /Name the limit by account/);
	const response = `\`\`\`json\n${judge.replace('"score":9', '"score":7.5')}\n\`\`\``;
	assert.match(input(complete(turn, { arena_judge: response })), /7\.5/);
	const wrongShape = complete(turn, {
		arena_judge: `\`\`\`json\nnull\n\`\`\`\n${judge}`,
	});
	assert.match(ask(wrongShape).basis, /Name a candidate as base/);
});

test("model JSON selects the first parseable fence, otherwise the first parseable value", () => {
	const report = { reason: 'Measured {one} and } inside a quote: "ok".' };
	const json = JSON.stringify(report);
	for (const input of [
		`{}\n\`\`\`text\nNot JSON\n\`\`\`\n\`\`\`json\n${json}\n\`\`\`\n\`\`\`json\n{}\n\`\`\``,
		`{}\n   ~~~~\r\n${json}\r\n   ~~~~\r\n`,
		`\`\`\`text\nNot JSON\n\`\`\`\n{both seats} and {unmatched; result: ${json} trailing {}`,
	])
		assert.deepEqual(replyJson(input), report);
	assert.equal(replyJson(`\`\`\`json\nnull\n\`\`\`\n${json}`), null);
	assert.deepEqual(replyJson(`First {} then ${json}`), {});
});

test("base and graft decisions accept a label or a reason alone and refuse missing, duplicate, ambiguous or unknown outcomes", () => {
	const s = synthesisTurn();
	const reason = {
		source: seats[0]!,
		n: 1,
		reason: "The default is outside the rubric.",
	};
	for (const outcome of [publish.outcomes[0]!, reason])
		assert.equal(
			challengeTurn(s, {
				...publish,
				outcomes: [outcome, publish.outcomes[1]!],
			}).phase,
			"dispatching",
		);
	for (const outcomes of [
		[],
		[publish.outcomes[0]!],
		[publish.outcomes[1]!],
		[...publish.outcomes, publish.outcomes[0]!],
		[...publish.outcomes, { ...reason, n: 2 }],
		[{ ...publish.outcomes[0]!, label: "missing" }, publish.outcomes[1]!],
		[{ source: seats[0]!, n: 1, reason: " " }, publish.outcomes[1]!],
		[{ source: seats[0]!, n: 1 }, publish.outcomes[1]!],
		[{ ...reason, label: "R1" }, publish.outcomes[1]!],
	]) {
		const result = design.reduce(s, { ...publish, outcomes }, world);
		assert.ok("reject" in result, JSON.stringify(outcomes));
		assert.match(result.reject, /unasked|outcome/i);
	}
});

test("a winning prototype uses the same outcomes as candidates and cannot disappear from the draft", () => {
	const framed = step(grounded(), {
		kind: "start_experiment",
		node: "L1",
		question: "Which uses fewer reads?",
		decisionRule: "Minimize reads.",
		controls: ["Same orders"],
		axis: "cache",
		variants: ["local", "remote"],
	}).state;
	const { key } = pending(framed);
	const observed = step(framed, {
		kind: "effect_done",
		key,
		result: {
			results: ["local", "remote"].map((variant) => ({
				seat: "design_prototype",
				conversation: variant,
				error: null,
				answer: JSON.stringify({
					observation: variant,
					evidence: "Counts from a repeated run.",
					incidentalChoices: [`Cache ${variant} names.`],
				}),
			})),
		},
	}).state;
	const compared = step(observed, {
		kind: "record_experiment",
		comparison: "Local uses fewer reads.",
		winner: "local",
	}).state;
	const synthesizing = synthesisTurn(
		complete(step(compared, frame).state, candidates),
	);
	const missingNode = design.reduce(
		synthesizing,
		{
			...publish,
			grafts: [],
			outcomes: [publish.outcomes[0]!],
			draft: { ...draft, nodes: [] },
		},
		world,
	);
	assert.ok("reject" in missingNode);
	assert.match(missingNode.reject, /Mandate node L1/);
	const omitted = design.reduce(synthesizing, publish, world);
	assert.ok("reject" in omitted);
	assert.match(omitted.reject, /experiment-1/);
	const challenge = challengeTurn(synthesizing, {
		...publish,
		outcomes: [
			...publish.outcomes,
			{
				source: "experiment-1",
				n: 1,
				reason: "Cache names are not part of the interface.",
			},
		],
	});
	const basis = ask(
		step(answeringTurn(challenge), answerChallenger).state,
	).basis;
	assert.match(
		basis,
		/Cache local names\.[\s\S]*Not taken: Cache names are not part of the interface/,
	);
	assert.doesNotMatch(basis, /experiment-1-r1: Rider/);
});

test("acted_on needs a changed draft and the owner sees that revision before deciding", () => {
	const awaiting = answeringTurn();
	const dispositions = answerChallenger.dispositions.map((d, i) =>
		i
			? d
			: { ...d, status: "acted_on", reason: "Named the source of the limit." },
	);
	const unchanged = {
		draft,
		grafts: publish.grafts,
		outcomes: publish.outcomes,
	};
	for (const revision of [undefined, unchanged]) {
		const result = design.reduce(
			awaiting,
			{ ...answerChallenger, dispositions, ...(revision && { revision }) },
			world,
		);
		assert.ok("reject" in result);
		assert.match(result.reject, /changed draft/i);
	}
	const revision = {
		...unchanged,
		draft: {
			...draft,
			done: "Check against the configured account limit before contacting the venue.",
		},
	};
	const reviewed = step(awaiting, {
		...answerChallenger,
		dispositions,
		revision,
	}).state;
	assert.match(ask(reviewed).basis, /configured account limit/);
	assert.match(ask(reviewed).basis, /acted_on: Named the source/);
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
				{ ...publish, grafts: [{ ...publish.grafts[0]!, seat: "missing" }] },
				world,
			),
	);
	const challenge = challengeTurn(s);
	const [job] = pending(challenge).jobs;
	assert.ok(job);
	assert.equal(job.seat, "arena_challenger");
	assert.equal(job.model, world.options.design);
	for (const part of [
		"Attach the check to the placement call.",
		"Use the account default.",
		"Sketch of arena_seat_1",
		"Judge's score for arena_seat_1",
	])
		assert.ok(job.question.toLowerCase().includes(part.toLowerCase()), part);
	assert.deepEqual(design.asks(challenge, world), []);
	const malformed = complete(challenge, { arena_challenger: "No objections" });
	assert.match(ask(malformed).basis, /objections/i);
	const answering = answeringTurn(challenge);
	assert.deepEqual(design.asks(answering, world), []);
	assert.match(input(answering), /Which account/);
	for (const dispositions of [
		answerChallenger.dispositions.slice(1),
		[answerChallenger.dispositions[0]!, answerChallenger.dispositions[0]!],
	])
		assert.ok(
			"reject" in
				design.reduce(answering, { ...answerChallenger, dispositions }, world),
		);

	const review = step(answering, answerChallenger).state;
	const decision = ask(review);
	for (const seat of seats)
		assert.ok(decision.basis.replace(/^> ?/gm, "").includes(candidate(seat)));
	assert.match(decision.basis, /arena_seat_2.*L1.*Attach the check/);
	assert.match(
		decision.basis,
		/Judge's independent observation of arena_seat_1[^\n]*\n[^\n]*Rider.*R1/i,
	);
	for (const part of [
		draft.intent,
		"Attach the check to the placement call.",
		"Judge's score for arena_seat_2",
		"Which account does the limit attach to?",
		"The account is named in R1.",
		"Use the account default.",
	])
		assert.ok(decision.basis.includes(part), part);
	assert.deepEqual(design.effects(review, world), []);
	assert.equal(input(review), "");
});

test("review keeps each choice's provenance and quotes model headings as evidence", () => {
	const first = seats[0]!;
	const extra = "Keep an append-only audit log for rejected orders.";
	const judged = complete(candidateTurn(), {
		...candidates,
		[first]: `${candidate(first)}\n\n${extra}\n\n## Unrelated heading\nDo not copy this into the decision list.`,
	});
	const report = judge.replace(
		"Judge's score for arena_seat_1",
		"## Rationale\\nIndependent evidence.",
	);
	const drafting = complete(judged, { arena_judge: report });
	const mapped = {
		...publish,
		outcomes: [{ source: first, n: 1, label: "R2" }, publish.outcomes[1]!],
	};
	const basis = ask(
		step(answeringTurn(challengeTurn(drafting, mapped)), answerChallenger)
			.state,
	).basis;
	const decisions = basis
		.split("\n### arena_seat_1\n")[1]!
		.split("\n## Evidence")[0]!;
	assert.match(
		decisions,
		/Default of arena_seat_1[\s\S]*Keep an append-only audit log[\s\S]*Judge's independent observation of arena_seat_1/,
	);
	assert.match(
		decisions,
		/Default of arena_seat_2[\s\S]*Judge's independent observation of arena_seat_2/,
	);
	assert.doesNotMatch(decisions, /Do not copy this/);
	assert.match(
		decisions,
		/Rider `R2`[^\n]*\n[\s\S]*Expose a rejected-order count\.[\s\S]*Disposition: open/,
	);
	assert.match(
		decisions,
		/Node `L1`[^\n]*\n[\s\S]*Check before placing\.[\s\S]*Place an over-limit order\./,
	);
	assert.match(basis, /^> ## Rationale\n> Independent evidence\.$/m);
	assert.doesNotMatch(basis, /^## Rationale$/m);
});

test("the owner's candidate choice pins the next synthesis base, retains the earlier round, and asks again before binding", () => {
	const first = firstReview();
	const note = "Retain account ownership with this base.";
	const taken = owner(first, "base:arena_seat_2", [{ n: 1, text: note }]);
	assert.deepEqual(taken.send ?? [], []);
	const replies = [
		{ n: 1, status: "acted_on", reason: "Kept account ownership." },
	];
	const wrongBase = design.reduce(taken.state, { ...publish, replies }, world);
	assert.ok("reject" in wrongBase);
	assert.match(wrongBase.reject, /as the owner chose/);
	const second = {
		...publish,
		base: "arena_seat_2",
		grafts: [],
		outcomes: [publish.outcomes[1]!],
	};
	assert.ok("reject" in design.reduce(taken.state, second, world));
	const challenging = step(taken.state, {
		...second,
		replies,
	}).state;
	assert.deepEqual(design.asks(challenging, world), []);
	assert.match(
		pending(challenging).jobs[0]!.question,
		/Default of arena_seat_2/,
	);
	const review = step(answeringTurn(challenging), answerChallenger).state;
	assert.match(ask(review).basis, /challenged round 2.*arena_seat_2/i);
	assert.match(
		ask(review).basis.split("\n## Mandate", 1)[0]!,
		/Base switched to `arena_seat_2`, replacing `arena_seat_1`.*no entries changed/,
	);
	assert.notEqual(ask(review).subject, ask(first).subject);
	assert.match(ask(review).basis, /Retain account ownership/);
	assert.match(ask(review).basis, /Kept account ownership/);
	assert.equal(review.rounds[0]?.answer?.choice, "base:arena_seat_2");
	const approved = owner(review, "approve");
	assert.equal(approved.send?.[0]?.event.kind, "bound");
});

test("seeded and fresh arenas keep the old candidates, judge, challenger and round; only seeded candidates receive the old review", () => {
	for (const choice of ["arena", "arena_fresh"]) {
		const first = firstReview();
		const rerun = owner(first, choice, [
			{ n: 1, text: "Measure ownership independently." },
		]);
		const fresh = choice === "arena_fresh";
		const next = step(rerun.state, {
			...frame,
			question: "What scopes the risk limit?",
		}).state;
		assert.equal(next.rounds[0]?.answer?.choice, choice);
		assert.deepEqual(next.arenas[0], first.arenas[0]);
		assert.notEqual(pending(next).key, pending(candidateTurn()).key);
		const job = pending(next).jobs[0]!;
		assert.equal(
			job.question.replace(/^> ?/gm, "").includes(candidate(seats[0]!)),
			!fresh,
		);
		assert.equal(
			job.question.includes("Measure ownership independently."),
			!fresh,
		);
		assert.match(job.question, /What scopes the risk limit/);
	}
});

test("rework retains the first challenge and round, and replies by annotation number without starting a new challenge", () => {
	const first = firstReview();
	const revised = owner(first, "rework", [
		{ n: 1, text: "Drop the incidental default." },
	]).state;
	assert.match(input(revised), /Drop the incidental default/);
	const newer = { ...draft, riders: draft.riders.slice(1) };
	const review = step(revised, {
		...publish,
		draft: newer,
		outcomes: [
			{
				source: seats[0]!,
				n: 1,
				reason: "Dropped per owner direction.",
			},
			publish.outcomes[1]!,
		],
		replies: [{ n: 1, status: "acted_on", reason: "Dropped R1." }],
	}).state;
	assert.deepEqual(design.effects(review, world), []);
	assert.deepEqual(review.arenas, first.arenas);
	assert.match(ask(review).basis, /challenged round 1/i);
	assert.match(ask(review).basis, /rider R1 removed/);
	assert.match(ask(review).basis, /Dropped R1/);
	assert.deepEqual(review.rounds[0]?.draft, draft);
});

test("declining a failed dispatch stops the arena without binding", () => {
	const failed = complete(candidateTurn(), {
		...candidates,
		[seats[1]!]: null,
	});
	const { state, send } = owner(failed, "decline");
	assert.deepEqual(send ?? [], []);
	assert.deepEqual(design.effects(state, world), []);
	assert.deepEqual(design.asks(state, world), []);
	assert.equal(input(state), "");
});

test("resuming an interrupted challenger response keeps the objections instead of starting another dispatch", () => {
	const s = answeringTurn();
	const held = step(s, {
		kind: "agent_stalled",
		agent: "designer",
		tokens: [design.agents(s, world)[0]!.expects[0]!.token],
		cause: "stopped",
		lastWords: "Still checking the evidence.",
	});
	const resumed = step(held.state, {
		kind: "resume",
		cause: held.send![0]!.event.cause!,
		direction: "Continue this turn.",
	}).state;
	assert.match(input(resumed), /Which account does the limit attach to/);
	assert.deepEqual(design.effects(resumed, world), []);
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
