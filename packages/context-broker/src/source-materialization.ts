import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { explicitDollarQueries } from "./invocation-text";
import { materializeNotionSource, SourceManagementUnavailable } from "./notion-management";
import { decodeNotionContentRecord, SourceError } from "./notion-source";
import { noConsumptionWrites } from "./consumption-effects";
import { inputReceiptIsCurrent } from "./preparation-authority";
import { decodeSourceMaterializationFinalizationFailure, decodeSourceMaterializationReceipt, materializationTarget, type SourceMaterializationFinalizationFailure, type SourceMemberCandidate, type SourceMaterializationAuthorization, type SourceMaterializationReceipt, type SourceMaterializationRequest } from "./source-materialization-contract";
import type { SourcePreparationScope, InputReceipt } from "./skill-preparation";
import type { ContentRecord, ExtensionContext, SourceConfig } from "./types";

const observations = channel("context-broker.notion-materialization");
const managerFailureCodes = new Set(["SOURCE_MANAGER_REQUIRED", "SOURCE_MANAGER_CONFIG_INVALID", "SOURCE_MANAGER_SCOPE_MISMATCH", "SOURCE_MANAGER_RESPONSE_INVALID", "SOURCE_MANAGER_UNAVAILABLE"]);
type NotionSource = Extract<SourceConfig, { type: "notion" }>;
export class SourceMaterializationError extends SourceError {
  constructor(code: string, sourceId: string, readonly materialization: SourceMaterializationReceipt | SourceMaterializationFinalizationFailure | {
    request_id: string; remote_writes: "none" | "unknown"; phase: "management";
  }) { super(code, sourceId, undefined, { effects: noConsumptionWrites() }); }
}

/** The metadata candidate is not consumption proof. Only the manager may make
 * it persistent; the caller must still run the ordinary readonly consumer. */
export async function materializeExplicitCandidate(input: {
  candidate: SourceMemberCandidate; source: NotionSource; receipt: InputReceipt; query: string;
  purpose: "inspect" | "use"; ctx: ExtensionContext; signal?: AbortSignal;
  authorization?: SourceMaterializationAuthorization;
  preparation?: SourcePreparationScope;
  onReceipt(receipt: SourceMaterializationReceipt): void | Promise<void>;
}): Promise<{ record: ContentRecord; receipt: SourceMaterializationReceipt }> {
  const { candidate, source, receipt, query, ctx, signal } = input;
  if (!inputReceiptIsCurrent(receipt, ctx, signal)) throw new SourceError("SOURCE_CANCELLED", source.id);
  if (!explicitDollarQueries(receipt.event.text ?? "").has(query)) throw new SourceError("SOURCE_MATERIALIZATION_UNAUTHORIZED", source.id);
  if (source.enabled === false || source.activation?.offline || source.discovery?.offline || !candidate.enabled
    || source.library !== candidate.library_id || candidate.readiness === "blocked" || candidate.readiness === "unknown")
    throw new SourceError("SOURCE_MATERIALIZATION_BLOCKED", source.id);
  input.preparation?.begin();
  const target = materializationTarget(candidate);
  const request: SourceMaterializationRequest = { version: 1, library: candidate.library_id, purpose: input.purpose, target,
    ...(input.authorization ? { authorization_root: input.authorization } : {}),
    request_id: receipt.id + ":" + createHash("sha256").update(JSON.stringify([candidate.library_id, target, input.purpose, input.authorization])).digest("hex") };
  const attribution = { version: 1, request_id: request.request_id, source_id: source.id, library: candidate.library_id,
    registered_source_id: target.source_id, member_key: target.member_key, authorization_root: input.authorization, phase: "management" };
  observations.publish({ ...attribution, event: "start" });
  let result: SourceMaterializationReceipt;
  try {
    const manage = () => materializeNotionSource(request, { cwd: ctx.cwd ?? process.cwd(), library: candidate.library_id, signal,
      env: { ...process.env, ...(source.requestTimeoutMs === undefined ? {} : { NTN_SKILLS_REQUEST_TIMEOUT_MS: String(source.requestTimeoutMs) }) } });
    const response = await (input.preparation ? input.preparation.withManagement(manage) : manage());
    result = decodeSourceMaterializationReceipt(response, request, candidate.scope, value => decodeNotionContentRecord(value, source));
  } catch (error) {
    let finalization: SourceMaterializationFinalizationFailure | undefined;
    try { finalization = decodeSourceMaterializationFinalizationFailure(error, request, value => decodeNotionContentRecord(value, source)); }
    catch { /* An invalid attribution cannot upgrade an unknown management outcome. */ }
    if (finalization) {
      const manager = finalization.verified_management.receipt;
      observations.publish({ ...attribution, event: "result", phase: "consumer_finalization",
        status: signal?.aborted || finalization.local_error_code === "CANCELLED" ? "cancelled" : "failed",
        local_error_code: finalization.local_error_code, verified_management: finalization.verified_management,
        effects: manager.effects, operation_id: manager.operation_id, manager_scope: manager.scope });
      // No consumer scope has been established. Retain the management fact
      // without entering onReceipt, catalog rebuilding or ordinary consumption.
      throw new SourceMaterializationError(signal?.aborted ? "SOURCE_CANCELLED" : finalization.local_error_code, source.id, finalization);
    }
    const unavailable = error instanceof SourceManagementUnavailable;
    const remoteWrites = unavailable ? "none" : "unknown";
    const code = unavailable ? error.code : error instanceof Error && "code" in error && typeof error.code === "string"
      && managerFailureCodes.has(error.code) ? error.code : "SOURCE_MATERIALIZATION_FAILED";
    observations.publish({ ...attribution, event: "result", status: signal?.aborted ? "cancelled" : "failed",
      effects: { remote_writes: remoteWrites, projection: unavailable ? "none" : "unknown" } });
    throw new SourceMaterializationError(signal?.aborted ? "SOURCE_CANCELLED" : code, source.id,
      { request_id: request.request_id, remote_writes: remoteWrites, phase: "management" });
  }
  const record = result.records.find(record => record.locator.type === "shared_skill" && record.locator.skill_id === target.expected_skill_id);
  if ((result.status === "ready" || result.status === "already_ready") && (!record || record.locator.type !== "shared_skill"
    || candidate.record && (candidate.record.id !== record.id || candidate.record.locator.type !== "shared_skill" || candidate.record.locator.page_id !== record.locator.page_id))) {
    observations.publish({ ...attribution, event: "result", status: "failed", effects: result.effects, operation_id: result.operation_id, manager_scope: result.manager_scope });
    throw new SourceMaterializationError("SOURCE_IDENTITY_MISMATCH", source.id, result);
  }
  observations.publish({ ...attribution, event: "result", status: result.status, effects: result.effects, operation_id: result.operation_id, manager_scope: result.manager_scope });
  // Retire old facts even when cancellation races a completed durable write.
  await input.onReceipt(result);
  if (!inputReceiptIsCurrent(receipt, ctx, signal)) throw new SourceMaterializationError("SOURCE_CANCELLED", source.id, result);
  if (result.status !== "ready" && result.status !== "already_ready")
    throw new SourceMaterializationError(result.status === "pending" ? "SOURCE_MATERIALIZATION_PENDING" : "SOURCE_MATERIALIZATION_BLOCKED", source.id, result);
  if (!record) throw new SourceMaterializationError("SOURCE_IDENTITY_MISMATCH", source.id, result);
  return { record, receipt: result };
}

/** Only missing current consumption schema can enter repair. Authentication,
 * identity, invalid author content and arbitrary failures never grant a write. */
export function needsSourceMaterialization(error: unknown): boolean {
  if (!(error instanceof SourceError)) return false;
  const missing = new Set(["CURRENT_SCHEMA_REQUIRED", "CURRENT_SKILL_NOT_READY", "CURRENT_SOURCE_NOT_READY", "CURRENT_SOURCE_INCOMPLETE"]);
  if (missing.has(error.code)) return true;
  const preparation = error.details?.preparation;
  if (error.code !== "PREPARE_REQUIRED_UNAVAILABLE" || !preparation || typeof preparation !== "object"
    || !("errors" in preparation) || !Array.isArray(preparation.errors) || !preparation.errors.length) return false;
  return preparation.errors.every(value => value !== null && typeof value === "object"
    && "code" in value && typeof value.code === "string" && missing.has(value.code));
}
