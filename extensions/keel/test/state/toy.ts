// Independent v1 shapes. Never derive a fixture from the current state.
export const toyFixture = {
	version: 1,
	sample: () => ({
		ask: null as string | null,
		turn: 0,
		agents: 0,
		paused: false,
		effect: false,
		answers: 0,
		publications: 0,
		stalls: 0,
		facts: [] as string[],
		notes: [] as string[],
	}),
};
export const sharedFixture = {
	version: 1,
	sample: () => ({ seen: [] as string[] }),
};
