import { defineExtension } from "tau/durable";
import {
	ensureHandoff,
	ensureHandoffHook,
	handoff,
	mandateAnswer,
	prepare,
	retry,
	reworkStart,
	stop,
	verifyStart,
} from "./tasks.ts";
import {
	publishBuild,
	publishMandate,
	publishVerdict,
	recordRuling,
} from "./tools.ts";

export const Keel = defineExtension({
	name: "keel",
	tools: [publishMandate, recordRuling, publishBuild, publishVerdict],
	tasks: [
		mandateAnswer,
		prepare,
		verifyStart,
		reworkStart,
		handoff,
		retry,
		stop,
		ensureHandoff,
	],
	hooks: [ensureHandoffHook],
});
