import type { Models } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { builtInExtensions, Catalogue, type Loaded } from "./catalogue.js";
import type { ExtensionModule } from "./index.js";
import { Options } from "./options.js";
import { PROJECT } from "./projects.js";

export type ExtensionFailure = {
	readonly name: string;
	readonly path?: string;
	readonly stage: string;
	readonly error: unknown;
};

export type ExtensionScan = {
	readonly modules: Readonly<Record<string, unknown>>;
	readonly failures: readonly ExtensionFailure[];
};

export type ExtensionSource = () => ExtensionScan | Promise<ExtensionScan>;

const object = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const nameRule = new RegExp(PROJECT);

function check(name: string, value: unknown): ExtensionModule {
	if (
		!nameRule.test(name) ||
		builtInExtensions.some((extension) => extension.name === name)
	)
		throw new Error(`Invalid extension name ${name}`);
	if (!object(value) || !object(value.extension))
		throw new Error("The extension export must be an object");
	if (value.extension.name !== name)
		throw new Error(
			`Expected extension.name ${name}, found ${String(value.extension.name)}`,
		);
	if (value.options !== undefined) {
		const options = value.options;
		if (
			!object(options) ||
			!object(options.schema) ||
			options.schema.type !== "object" ||
			options.schema.additionalProperties !== false ||
			typeof options.get !== "function" ||
			typeof options.set !== "function"
		)
			throw new Error(
				"Options require a closed object schema and callable get and set",
			);
	}
	if (
		value.entry !== undefined &&
		!object(value.entry) &&
		typeof value.entry !== "function"
	)
		throw new Error("The entry export must be an object or function");
	const telemetry = value.telemetry;
	if (
		telemetry !== undefined &&
		(!object(telemetry) ||
			!Number.isFinite(telemetry.version) ||
			!object(telemetry.spans) ||
			(telemetry.metrics !== undefined && !object(telemetry.metrics)) ||
			[
				...Object.keys(telemetry.spans),
				...Object.keys(telemetry.metrics ?? {}),
			].some((key) => !key.startsWith(`${name}.`)))
	)
		throw new Error(
			`Telemetry requires a numeric version and span and metric names prefixed with ${name}.`,
		);
	return value as ExtensionModule;
}

function checkProviders(
	value: unknown,
	owners: ReadonlyMap<string, string | null>,
): ReadonlySet<string> {
	const ids = new Set<string>();
	if (!Array.isArray(value)) throw new Error("Providers must be an array");
	for (const [index, provider] of value.entries()) {
		if (
			!object(provider) ||
			typeof provider.id !== "string" ||
			provider.id.length === 0 ||
			provider.id.includes("/") ||
			!object(provider.auth) ||
			typeof provider.getModels !== "function" ||
			typeof provider.stream !== "function" ||
			typeof provider.streamSimple !== "function"
		)
			throw new Error(
				`Provider at index ${index} requires a non-empty id without "/", an auth object, and callable getModels, stream, and streamSimple`,
			);
		const { id } = provider;
		if (ids.has(id)) throw new Error(`Provider ${id} is exported twice`);
		const owner = owners.get(id);
		if (owner === null) throw new Error(`Provider ${id} is built in`);
		if (owner !== undefined)
			throw new Error(
				`Provider ${id} is already installed by extension ${owner}`,
			);
		ids.add(id);
	}
	return ids;
}

export async function loadExtensions(
	source: ExtensionSource,
	models: Models,
	builtInProviders: ReadonlySet<string>,
) {
	const found = await source();
	const failures = [...found.failures];
	const entries: Record<string, Loaded> = Object.create(null);
	const current = () => models;
	const registry = createRegistry();
	for (const extension of builtInExtensions) registry.install(extension);
	const taskOwners = new Map<string, string>();
	const providerOwners = new Map<string, string | null>(
		[...builtInProviders].map((id) => [id, null]),
	);
	for (const name of Object.keys(found.modules).sort()) {
		const value = found.modules[name];
		let stage = "shape";
		try {
			const module = check(name, value);
			stage = "providers";
			const factory = module.providers;
			if (factory !== undefined && typeof factory !== "function")
				throw new Error("The providers export must be a function");
			const providers =
				factory === undefined
					? []
					: factory({ getModels: (provider) => models.getModels(provider) });
			const providerIds = checkProviders(providers, providerOwners);
			stage = "options";
			const contract =
				module.options === undefined
					? undefined
					: new Options(module.options, current);
			stage = "install";
			const tasks = (module.extension.tasks ?? []).map(
				(task) => task.definition.name,
			);
			const shared = tasks.find((task) => taskOwners.has(task));
			if (shared !== undefined)
				throw new Error(
					`Task ${shared} of extension ${name} is already installed by extension ${taskOwners.get(shared)}`,
				);
			registry.install(module.extension);
			for (const task of tasks) taskOwners.set(task, name);
			for (const id of providerIds) providerOwners.set(id, name);
			entries[name] = { module, options: contract, providers };
		} catch (error) {
			failures.push({ name, stage, error });
		}
	}
	for (const failure of failures) {
		const message =
			failure.error instanceof Error
				? failure.error.message
				: String(failure.error);
		process.stderr.write(
			`tau: extension ${failure.name}${failure.path === undefined ? "" : ` ${failure.path}`} [${failure.stage}]: ${message.split(/[\r\n]/, 1)[0]}\n`,
		);
	}
	return { catalogue: new Catalogue(entries), failures };
}
