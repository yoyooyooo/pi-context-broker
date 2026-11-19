/** The public SDK receipt describes the observed current operation. */
export type ConsumptionEffects =
  | { version: 1; remote_writes: "none"; author_content: "unchanged" }
  | { version: 1; remote_writes: "unknown"; author_content: "unchanged" | "unknown" };
export const consumptionEffectsJsonSchema = {
  anyOf: [
    { type: "object", properties: {
      version: { const: 1 }, remote_writes: { const: "none" }, author_content: { const: "unchanged" },
    }, required: ["version", "remote_writes", "author_content"], additionalProperties: false },
    { type: "object", properties: {
      version: { const: 1 }, remote_writes: { const: "unknown" }, author_content: { enum: ["unchanged", "unknown"] },
    }, required: ["version", "remote_writes", "author_content"], additionalProperties: false },
  ],
};
export type ConsumptionPolicy = { readOnly?: boolean; observeEffects?: (effects: ConsumptionEffects) => void };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export const noConsumptionWrites = (): ConsumptionEffects => ({ version: 1, remote_writes: "none", author_content: "unchanged" });
export const unknownConsumptionEffects = (): ConsumptionEffects => ({ version: 1, remote_writes: "unknown", author_content: "unknown" });
export function isConsumptionEffects(value: unknown): value is ConsumptionEffects {
  if (!object(value) || Object.keys(value).sort().join(",") !== "author_content,remote_writes,version" || value.version !== 1) return false;
  return value.remote_writes === "none" && value.author_content === "unchanged"
    || value.remote_writes === "unknown" && (value.author_content === "unchanged" || value.author_content === "unknown");
}
export function consumptionEffects(value: unknown): ConsumptionEffects {
  return isConsumptionEffects(value) ? value : unknownConsumptionEffects();
}
export function errorConsumptionEffects(error: unknown): ConsumptionEffects {
  return consumptionEffects(object(error) && object(error.details) ? error.details.effects : undefined);
}
export function combineConsumptionEffects(values: readonly (ConsumptionEffects | undefined)[]): ConsumptionEffects {
  if (!values.length) return unknownConsumptionEffects();
  const receipts = values.map(consumptionEffects);
  return receipts.some(value => value.remote_writes === "unknown")
    ? { version: 1, remote_writes: "unknown", author_content: receipts.some(value => value.author_content === "unknown") ? "unknown" : "unchanged" }
    : noConsumptionWrites();
}
