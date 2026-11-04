import type { PreparationBinding } from "./prepare-protocol";

export type ResourceReadBudget = Readonly<{ maxFiles: number; maxBytes: number; timeBudgetMs: number }>;
export const DEFAULT_RESOURCE_READ_BUDGET: ResourceReadBudget = Object.freeze({ maxFiles: 16, maxBytes: 1024 * 1024, timeBudgetMs: 30_000 });
export const MAX_RESOURCE_READ_BUDGET: ResourceReadBudget = Object.freeze({ maxFiles: 64, maxBytes: 16 * 1024 * 1024, timeBudgetMs: 120_000 });
export const RESOURCE_READ_MAX_CONTEXT_BYTES = 1024 * 1024;

export type ResourceReadFileIdentity = Readonly<{
  requested_ref: string; ref: string; path: string; file_id?: string; bytes: number; sha256: string;
}>;
export type ResourceReadWireFile = ResourceReadFileIdentity & Readonly<{ encoding: "utf8" | "base64"; content: string }>;
export type ResourceReadFile = ResourceReadFileIdentity & (
  | Readonly<{ encoding: "utf8"; content: string }>
  | Readonly<{ encoding: "base64"; content: string; output: string }>
);

/** Independently verified owner metadata and only the explicitly selected file bytes.
 * A resource read never means that the owner's main body has been prepared or delivered. */
export type ResourceReadBatch = Readonly<{
  selection: Readonly<{ scope: string; owner: string; snapshot_id: string; version_id: string }>;
  ownerBinding: PreparationBinding;
  manifest: unknown;
  manifest_sha256: string;
  files: readonly ResourceReadFile[];
  budget: ResourceReadBudget;
  machine: unknown;
}>;
