import { modelRef } from "tau";
import type { AgentChange, Tx } from "tau/durable";
import { designer } from "./roles.ts";
import { KeelOptions } from "./work.ts";

export { Keel as extension } from "./extension.ts";
export const options = KeelOptions;

/** The designer's settings for the conversation the host creates. The host adds the project's `cwd`. */
export const entry = async (tx: Tx): Promise<AgentChange> =>
	designer(modelRef((await KeelOptions.read(tx)).designer));
