/*!
 * Adapted from pi's remote-catalog-provider.ts. MIT License.
 * Copyright (c) 2025 Mario Zechner
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import path from "node:path";
import {
	type AnyModel,
	type CredentialStore,
	createModels,
	formatUserAgent,
	getModelType,
	isModelType,
	type Models,
	type ModelsStoreEntry,
	type Provider,
} from "@earendil-works/pi-ai";
import {
	builtinProviders,
	getBuiltinModelDataGeneratedAt,
} from "@earendil-works/pi-ai/providers/all";
import { personalizeOpenRouterCatalog } from "@earendil-works/pi-ai/providers/openrouter";
import { fileModelsStore } from "./models-store.js";

const modelTypes = ["chat", "image", "classifier"];

function parseShard(provider: string, data: unknown): AnyModel[] {
	if (typeof data !== "object" || data === null)
		throw new Error(`Invalid ${provider} catalog`);
	const entries: unknown[] = Array.isArray(data)
		? data
		: "models" in data && Array.isArray(data.models)
			? data.models
			: Object.values(data);
	const models: AnyModel[] = [];
	for (const entry of entries) {
		const model = entry as Partial<AnyModel> | null;
		if (typeof model?.id !== "string")
			throw new Error(`Invalid ${provider} catalog entry`);
		if (model.type !== undefined && !modelTypes.includes(model.type)) continue;
		if (
			typeof model.api !== "string" ||
			typeof model.name !== "string" ||
			typeof model.baseUrl !== "string" ||
			!Array.isArray(model.input) ||
			!model.cost
		)
			throw new Error(`Invalid ${provider} model: ${model.id}`);
		models.push({ ...model, provider } as AnyModel);
	}
	return models;
}

function newer(date: number | undefined, generatedAt: number | undefined) {
	return (
		generatedAt === undefined || (date !== undefined && date > generatedAt)
	);
}

async function fetchShard(
	provider: string,
	generatedAt: number | undefined,
	signal: AbortSignal,
	validator?: string,
): Promise<ModelsStoreEntry | undefined> {
	const url = new URL(
		`/api/models/providers/${encodeURIComponent(provider)}`,
		"https://pi.dev",
	);
	url.searchParams.set("types", modelTypes.join(","));
	const response = await fetch(url, {
		headers: {
			accept: "application/json",
			"user-agent": formatUserAgent(),
			...(validator ? { "if-none-match": validator } : {}),
		},
		signal: AbortSignal.any([signal, AbortSignal.timeout(4_000)]),
	});
	if (
		(response.status === 304 && validator) ||
		response.status === 404 ||
		response.status === 501
	)
		return;
	if (!response.ok)
		throw new Error(
			`Model catalog request failed for ${provider}: ${response.status}`,
		);
	const lastModified =
		Date.parse(response.headers.get("last-modified") ?? "") || 0;
	if (!newer(lastModified, generatedAt)) return;
	const etag = response.headers.get("etag");
	return {
		models: parseShard(provider, await response.json()),
		lastModified,
		...(etag ? { etag } : {}),
	};
}

function mergeModels(
	builtins: readonly AnyModel[],
	shard: readonly AnyModel[],
) {
	const byTypeAndId = new Map<string, AnyModel>();
	for (const model of [...builtins, ...shard])
		byTypeAndId.set(`${getModelType(model)}\0${model.id}`, model);
	return [...byTypeAndId.values()];
}

export function catalogProvider(
	provider: Provider,
	generatedAt: number | undefined,
): Provider {
	if (provider.refreshModels) return provider;
	const personalized = provider.id === "openrouter";
	const builtins = provider.getAllModels?.() ?? provider.getModels();
	let models: readonly AnyModel[] = builtins;
	return {
		...provider,
		getAllModels: () => models,
		getModels: () => models.filter((model) => isModelType(model, "chat")),
		refreshModelsAuth: personalized ? "credential" : "configured",
		async refreshModels(context) {
			const { stored, signal } = context;
			if (!context.allowNetwork) {
				const saved = stored?.models.filter(
					(model) => model.provider === provider.id,
				);
				await context.publish({
					update: () => {
						if (!saved?.length) models = builtins;
						else if (personalized) models = saved;
						else
							models = newer(stored?.lastModified, generatedAt)
								? mergeModels(builtins, saved)
								: builtins;
					},
				});
				return;
			}
			const validator =
				!personalized && stored?.models.length ? stored.etag : undefined;
			let entry = await fetchShard(provider.id, generatedAt, signal, validator);
			signal.throwIfAborted();
			const merged = entry ? mergeModels(builtins, entry.models) : builtins;
			if (personalized)
				entry = { models: await personalizeOpenRouterCatalog(merged, context) };
			if (!entry) return;
			const next = personalized ? entry.models : merged;
			signal.throwIfAborted();
			await context.publish({
				persist: { ...entry, checkedAt: Date.now() },
				update: () => {
					models = next;
				},
			});
		},
	};
}

export async function loadModels(
	home: string,
	credentials: CredentialStore,
): Promise<Models> {
	const models = createModels({
		credentials,
		modelsStore: fileModelsStore(path.join(home, "models-store.json")),
	});
	const generatedAt = getBuiltinModelDataGeneratedAt();
	for (const provider of builtinProviders())
		models.setProvider(catalogProvider(provider, generatedAt));
	await models.refresh({ allowNetwork: false });
	return models;
}
