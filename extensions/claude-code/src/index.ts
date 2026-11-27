import type { ModelCatalog } from "tau";
import { defineExtension } from "tau/durable";
import { claudeCode } from "./provider.ts";

export const extension = defineExtension({ name: "claude-code" });
export const providers = (catalog: ModelCatalog) => [claudeCode({ catalog })];
