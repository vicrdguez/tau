import type { MutableModels, Provider } from "@earendil-works/pi-ai";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import type { Extension } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { ExtensionModule } from "./index.js";
import type { Options } from "./options.js";

export const Codemode = createCodemodeExtension({
	sandbox: new CodemodeSandbox(),
});

export const builtInExtensions: readonly Extension[] = [CodingTools, Codemode];

export type Loaded = {
	readonly module: ExtensionModule;
	readonly options: Options | undefined;
	readonly providers: readonly Provider[];
};

export class Catalogue {
	readonly #entries: Readonly<Record<string, Loaded>>;

	constructor(entries: Readonly<Record<string, Loaded>>) {
		this.#entries = Object.freeze(
			Object.fromEntries(
				Object.entries(entries).map(([name, loaded]) => [
					name,
					Object.freeze(loaded),
				]),
			),
		);
		Object.freeze(this);
	}

	get(name: string): Loaded | undefined {
		return Object.hasOwn(this.#entries, name) ? this.#entries[name] : undefined;
	}

	entries(): readonly (readonly [string, Loaded])[] {
		return Object.entries(this.#entries);
	}

	selected(names: readonly string[]): readonly Loaded[] {
		return names.flatMap((name) => {
			const loaded = this.get(name);
			return loaded === undefined ? [] : [loaded];
		});
	}

	defaults(names: readonly string[]) {
		return [
			...builtInExtensions,
			...this.selected(names)
				.filter(({ module }) => module.entry === undefined)
				.map(({ module }) => module.extension),
		];
	}
}

export async function reconcileProviders(
	models: MutableModels,
	builtInProviders: ReadonlySet<string>,
	catalogue: Catalogue,
): Promise<void> {
	const exported = new Map<string, Provider>();
	for (const [, { providers }] of catalogue.entries())
		for (const provider of providers) exported.set(provider.id, provider);
	for (const { id } of models.getProviders())
		if (!builtInProviders.has(id) && !exported.has(id))
			models.deleteProvider(id);
	for (const provider of exported.values()) models.setProvider(provider);
	if (exported.size > 0)
		await models.refresh({
			allowNetwork: false,
			providers: [...exported.keys()],
		});
}
