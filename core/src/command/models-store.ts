import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelsStore, ModelsStoreEntry } from "@earendil-works/pi-ai";

export function fileModelsStore(filename: string): ModelsStore {
	let pending = Promise.resolve();
	async function load(
		signal?: AbortSignal,
	): Promise<Record<string, ModelsStoreEntry>> {
		signal?.throwIfAborted();
		const text = await readFile(filename, { encoding: "utf8", signal }).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return "";
				throw error;
			},
		);
		signal?.throwIfAborted();
		const json = text.replace(/^\uFEFF/, "");
		if (json === "") return {};
		let entries: unknown;
		try {
			entries = JSON.parse(json);
		} catch {
			throw new SyntaxError(`Invalid JSON in ${filename}`);
		}
		if (
			entries === null ||
			typeof entries !== "object" ||
			Array.isArray(entries)
		)
			throw new TypeError(
				`Invalid model cache in ${filename}: expected a provider record`,
			);
		return entries as Record<string, ModelsStoreEntry>;
	}

	async function update(
		provider: string,
		entry: ModelsStoreEntry | undefined,
		signal?: AbortSignal,
	): Promise<void> {
		signal?.throwIfAborted();
		const next = pending.then(async () => {
			let entries = await load(signal);
			if (entry === undefined) {
				if (!Object.hasOwn(entries, provider)) return;
				delete entries[provider];
			} else {
				entries = { ...entries, [provider]: entry };
			}
			const json = `${JSON.stringify(entries, null, 2)}\n`;
			await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
			const temporary = `${filename}.${randomUUID()}.tmp`;
			try {
				await writeFile(temporary, json, { flag: "wx", mode: 0o600, signal });
				signal?.throwIfAborted();
				await rename(temporary, filename);
			} catch (error) {
				await rm(temporary, { force: true }).catch(() => {});
				throw error;
			}
		});
		pending = next.catch(() => {});
		return next;
	}

	return {
		async read(provider, options) {
			const entries = await load(options?.signal);
			return Object.hasOwn(entries, provider) ? entries[provider] : undefined;
		},
		write: (provider, entry, options) =>
			update(provider, entry, options?.signal),
		delete: (provider, options) => update(provider, undefined, options?.signal),
	};
}
