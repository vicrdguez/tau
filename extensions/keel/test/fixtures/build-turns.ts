import type { openScriptedWorkflow } from "./kernel.ts";

type Turn = Awaited<ReturnType<typeof openScriptedWorkflow>>["turn"];

/** Common scripted actions; each caller still chooses commands, facts and verdicts. */
export function buildTurns(turn: Turn) {
	const bash = (role: string, command: string, ...facts: string[]) =>
		turn(role, "bash", { command }, ...facts);
	const publish = (summary: string) =>
		turn("worker", "publish_build", { summary, addresses: [] });
	const pass = (text: string) =>
		turn("verifier", "publish_verdict", {
			outcome: "pass",
			blocks: [],
			notes: [],
			text,
		});
	return {
		bash,
		publish,
		pass,
		verify: (command: string, text: string, ...facts: string[]) => [
			bash("verifier", command, ...facts),
			pass(text),
		],
		implement: (command: string, summary: string, ...facts: string[]) => [
			bash("worker", command, ...facts),
			publish(summary),
		],
	};
}
