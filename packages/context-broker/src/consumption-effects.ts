/** The public SDK receipt describes this operation, never the selected snapshot's history. */
export type ConsumptionRetentionEffect = {
  skill_page_id: string; file_id: string; operation_id: string; status: "confirmed" | "unknown";
};
export type ConsumptionEffects = {
  version: 1; remote_writes: "none" | "retained" | "unknown";
  author_content: "unchanged" | "unknown"; retention: readonly ConsumptionRetentionEffect[];
};
export const consumptionEffectsJsonSchema = {
  type: "object", properties: {
    version: { const: 1 }, remote_writes: { enum: ["none", "retained", "unknown"] },
    author_content: { enum: ["unchanged", "unknown"] },
    retention: { type: "array", items: {
      type: "object", properties: {
        skill_page_id: { type: "string", minLength: 1 }, file_id: { type: "string", minLength: 1 },
        operation_id: { type: "string", minLength: 1 }, status: { enum: ["confirmed", "unknown"] },
      }, required: ["skill_page_id", "file_id", "operation_id", "status"], additionalProperties: false,
    } },
  }, required: ["version", "remote_writes", "author_content", "retention"], additionalProperties: false,
};
export type ConsumptionPolicy = { readOnly?: boolean; observeEffects?: (effects: ConsumptionEffects) => void };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export const noConsumptionWrites = (): ConsumptionEffects => ({ version: 1, remote_writes: "none", author_content: "unchanged", retention: [] });
export const unknownConsumptionEffects = (): ConsumptionEffects => ({ version: 1, remote_writes: "unknown", author_content: "unknown", retention: [] });
export function isConsumptionEffects(value: unknown): value is ConsumptionEffects {
  if (!object(value) || value.version !== 1 || !["none", "retained", "unknown"].includes(String(value.remote_writes))
    || !["unchanged", "unknown"].includes(String(value.author_content)) || !Array.isArray(value.retention)
    || value.retention.some(entry => !object(entry) || !["confirmed", "unknown"].includes(String(entry.status))
      || ["skill_page_id", "file_id", "operation_id"].some(key => typeof entry[key] !== "string" || !entry[key]))) return false;
  if (value.remote_writes === "none" && (value.retention.length || value.author_content !== "unchanged")) return false;
  if (value.remote_writes === "retained" && (!value.retention.length || value.retention.some(entry => entry.status !== "confirmed"))) return false;
  return true;
}
export function consumptionEffects(value: unknown): ConsumptionEffects {
  return isConsumptionEffects(value) ? value : unknownConsumptionEffects();
}
export function errorConsumptionEffects(error: unknown): ConsumptionEffects {
  return consumptionEffects(object(error) && object(error.details) ? error.details.effects : undefined);
}
export function combineConsumptionEffects(values: readonly (ConsumptionEffects | undefined)[]): ConsumptionEffects {
  const receipts = values.map(consumptionEffects);
  const retention = new Map<string, ConsumptionRetentionEffect>();
  for (const receipt of receipts) for (const entry of receipt.retention) {
    const key = JSON.stringify([entry.skill_page_id, entry.file_id, entry.operation_id]);
    const previous = retention.get(key);
    retention.set(key, { ...entry, status: entry.status === "unknown" || previous?.status === "unknown" ? "unknown" : "confirmed" });
  }
  return { version: 1, remote_writes: receipts.some(value => value.remote_writes === "unknown") ? "unknown"
    : receipts.some(value => value.remote_writes === "retained") ? "retained" : "none",
    author_content: receipts.some(value => value.author_content === "unknown") ? "unknown" : "unchanged",
    retention: [...retention.values()] };
}
