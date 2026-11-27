import { isDeepStrictEqual } from "node:util";
import type { ContentRecord } from "./types";
import { validSharedSkillId } from "./shared-skill-identity";

export type SourceMaterializationTarget = {
  source_id: string; member_key: string; expected_skill_id: string; registration_digest: string;
  expected_source_revision?: string; expected_source_commit?: string;
};
export type SourceMemberCandidate = SourceMaterializationTarget & {
  type: "source_member"; library_id: string; scope: string; name: string; alias: string; description: string;
  enabled: boolean; readiness: "ready" | "materializable" | "preparing" | "blocked" | "unknown";
  reason?: string; record?: ContentRecord;
};
export type SourceMaterializationEffects = {
  remote_writes: "none" | "management" | "unknown"; projection: "none";
};
export type SourceMaterializationAuthorization = { skill_id: string; page_id: string; requires_digest: string };
export type SourceMaterializationRequest = {
  version: 1; library: string; request_id: string; purpose: "inspect" | "use"; target: SourceMaterializationTarget;
  authorization_root?: SourceMaterializationAuthorization;
};
export type SourceMaterializationReceipt = {
  version: 1; request_id: string; library_id: string; scope: string; target: SourceMaterializationTarget;
  status: "ready" | "already_ready" | "pending" | "blocked"; operation_id?: string;
  records: ContentRecord[]; affected_skill_ids: string[]; source_revisions: Array<{ source_id: string; revision: string }>;
  effects: SourceMaterializationEffects; reason?: string; authorization_root?: SourceMaterializationAuthorization; manager_scope?: string;
};
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, limit = 2048): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit && !/[\p{Cc}\p{Cs}]/u.test(value);
}
function invalid(): never { throw Object.assign(new Error("Invalid Source materialization contract"), { code: "SOURCE_MATERIALIZATION_INVALID" }); }
export function materializationTarget(value: unknown): SourceMaterializationTarget {
  if (!object(value) || !text(value.source_id, 200) || !ID.test(value.source_id) || !text(value.member_key, 4096) || !validSharedSkillId(value.expected_skill_id)
    || typeof value.registration_digest !== "string" || !HASH.test(value.registration_digest)
    || value.expected_source_revision !== undefined && (typeof value.expected_source_revision !== "string" || !HASH.test(value.expected_source_revision))
    || value.expected_source_commit !== undefined && (typeof value.expected_source_commit !== "string" || !/^[a-f0-9]{40}$/.test(value.expected_source_commit))) return invalid();
  if (value.member_key !== "." && (value.member_key.startsWith("/") || value.member_key.includes("\\")
    || value.member_key.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git"))) return invalid();
  return { source_id: value.source_id, member_key: value.member_key, expected_skill_id: value.expected_skill_id, registration_digest: value.registration_digest,
    ...(value.expected_source_revision === undefined ? {} : { expected_source_revision: value.expected_source_revision }),
    ...(value.expected_source_commit === undefined ? {} : { expected_source_commit: value.expected_source_commit }) };
}
export function materializationAuthorization(value: unknown): SourceMaterializationAuthorization {
  if (!object(value) || !validSharedSkillId(value.skill_id)
    || typeof value.page_id !== "string" || !UUID.test(value.page_id)
    || typeof value.requires_digest !== "string" || !HASH.test(value.requires_digest)) return invalid();
  return { skill_id: value.skill_id, page_id: value.page_id, requires_digest: value.requires_digest };
}
export function decodeSourceMemberCandidate(value: unknown, expected: { library: string; scope: string },
  decodeRecord: (value: unknown) => ContentRecord): SourceMemberCandidate {
  if (!object(value) || value.type !== "source_member" || value.library_id !== expected.library || !UUID.test(expected.library)
    || value.scope !== expected.scope || !HASH.test(expected.scope) || !text(value.name) || !text(value.alias)
    || typeof value.description !== "string" || typeof value.enabled !== "boolean"
    || !["ready", "materializable", "preparing", "blocked", "unknown"].includes(String(value.readiness))
    || value.reason !== undefined && !text(value.reason, 256)) return invalid();
  const target = materializationTarget(value);
  const record = value.record === undefined ? undefined : decodeRecord(value.record);
  if (record && (record.kind !== "skill" || record.enabled !== value.enabled || record.locator.type !== "shared_skill" || record.locator.library_id !== expected.library
    || record.locator.skill_id !== target.expected_skill_id)) return invalid();
  const readiness = value.readiness;
  if (readiness !== "ready" && readiness !== "materializable" && readiness !== "preparing" && readiness !== "blocked" && readiness !== "unknown") return invalid();
  if (readiness === "ready" && !record) return invalid();
  return { ...target, type: "source_member", library_id: expected.library, scope: expected.scope,
    name: value.name, alias: value.alias, description: value.description, enabled: value.enabled, readiness,
    ...(record ? { record } : {}), ...(typeof value.reason === "string" ? { reason: value.reason } : {}) };
}
export function decodeSourceMaterializationReceipt(value: unknown, request: SourceMaterializationRequest, expectedScope: string,
  decodeRecord: (value: unknown) => ContentRecord): SourceMaterializationReceipt {
  if (!object(value) || value.version !== 1 || value.request_id !== request.request_id || value.library_id !== request.library
    || value.scope !== expectedScope || !HASH.test(expectedScope) || value.manager_scope !== undefined && !text(value.manager_scope)
    || !["ready", "already_ready", "pending", "blocked"].includes(String(value.status))
    || !Array.isArray(value.records) || !Array.isArray(value.affected_skill_ids) || !Array.isArray(value.source_revisions)
    || value.operation_id !== undefined && (typeof value.operation_id !== "string" || !ID.test(value.operation_id)) || value.reason !== undefined && !text(value.reason, 256)
    || !object(value.effects) || value.effects.projection !== "none"
    || !["none", "management", "unknown"].includes(String(value.effects.remote_writes))) return invalid();
  const target = materializationTarget(value.target);
  if (!isDeepStrictEqual(target, request.target)) return invalid();
  const authorization = value.authorization_root === undefined ? undefined : materializationAuthorization(value.authorization_root);
  if (!isDeepStrictEqual(authorization, request.authorization_root)) return invalid();
  const records = value.records.map(decodeRecord), ids = new Set<string>(), pages = new Set<string>();
  for (const record of records) {
    if (record.locator.type !== "shared_skill" || record.locator.library_id !== request.library
      || ids.has(record.id) || pages.has(record.locator.page_id)) return invalid();
    ids.add(record.id); pages.add(record.locator.page_id);
  }
  const affected: string[] = [];
  for (const id of value.affected_skill_ids) { if (!validSharedSkillId(id) || affected.includes(id)) return invalid(); affected.push(id); }
  const revisions: Array<{ source_id: string; revision: string }> = [];
  for (const item of value.source_revisions) {
    if (!object(item) || (typeof item.source_id !== "string" || !ID.test(item.source_id)) || typeof item.revision !== "string" || !HASH.test(item.revision)
      || revisions.some(revision => revision.source_id === item.source_id)) return invalid();
    revisions.push({ source_id: item.source_id, revision: item.revision });
  }
  const status = value.status, remoteWrites = value.effects.remote_writes;
  if (status !== "ready" && status !== "already_ready" && status !== "pending" && status !== "blocked") return invalid();
  if (remoteWrites !== "none" && remoteWrites !== "management" && remoteWrites !== "unknown") return invalid();
  if ((status === "pending" || status === "blocked") && records.length) return invalid();
  if ((status === "ready" || status === "already_ready") && (!records.some(record => record.locator.type === "shared_skill" && record.locator.skill_id === target.expected_skill_id)
    || !revisions.some(revision => revision.source_id === target.source_id) || remoteWrites === "unknown")) return invalid();
  return { version: 1, request_id: request.request_id, library_id: request.library, scope: expectedScope, target, status, records,
    affected_skill_ids: affected, source_revisions: revisions, ...(authorization ? { authorization_root: authorization } : {}), effects: { remote_writes: remoteWrites, projection: "none" },
    ...(typeof value.operation_id === "string" ? { operation_id: value.operation_id } : {}),
    ...(typeof value.manager_scope === "string" ? { manager_scope: value.manager_scope } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}) };
}

/** This is a failed consumer outcome, never a consumer-scope ready receipt.
 * The paired SDK validates execution_id against its transport binding; Broker
 * binds the retained manager result to this exact request again. */
export type SourceMaterializationFinalizationFailure = {
  phase: "consumer_finalization";
  local_error_code: string;
  verified_management: {
    request_id: string; execution_id: string; library: string;
    receipt: SourceMaterializationReceipt;
  };
  local_error_details?: unknown;
};

export function decodeSourceMaterializationFinalizationFailure(error: unknown, request: SourceMaterializationRequest,
  decodeRecord: (value: unknown) => ContentRecord): SourceMaterializationFinalizationFailure | undefined {
  if (!object(error) || !object(error.details) || error.details.phase !== "consumer_finalization") return undefined;
  const details = error.details, verified = details.verified_management;
  if (typeof error.code !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)
    || details.local_error_code !== error.code || !object(verified)
    || verified.request_id !== request.request_id || verified.library !== request.library
    || !text(verified.execution_id, 256) || !object(verified.receipt)
    || typeof verified.receipt.scope !== "string" || verified.receipt.manager_scope !== undefined) return invalid();
  const receipt = decodeSourceMaterializationReceipt(verified.receipt, request, verified.receipt.scope, decodeRecord);
  return { phase: "consumer_finalization", local_error_code: error.code,
    verified_management: { request_id: request.request_id, execution_id: verified.execution_id, library: request.library, receipt },
    ...(details.local_error_details === undefined ? {} : { local_error_details: details.local_error_details }) };
}
