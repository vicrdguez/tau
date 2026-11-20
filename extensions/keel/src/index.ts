import { createKernel } from "./kernel/kernel.ts";

export { options } from "./roles/index.ts";

export const { extension, entry } = createKernel({
	lanes: [],
	tools: [],
	runEffect: async () => {
		throw new Error("No Keel effects are installed");
	},
});
