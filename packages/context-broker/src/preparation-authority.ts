import { explicitDollarQueries } from "./invocation-text";
import type { SourcePreparationScope, InputReceipt } from "./skill-preparation";
import type { ExtensionContext, SkillRecord } from "./types";

/** This token is issued only from a real accepted input. It is never a property
 * of a cached Skill, a completion choice, a model tool call or a session pin. */
export type PreparationAuthority = Readonly<{ receiptId: string }>;
type Grant = { receipt: InputReceipt; roots: ReadonlyMap<string, string>; preparation?: SourcePreparationScope };
const grants = new WeakMap<PreparationAuthority, Grant>();

function rootIdentity(record: SkillRecord): string | undefined {
  return record.source === "notion" && record.sourceId && record.sourceScope && record.id
    ? JSON.stringify([record.sourceId, record.sourceScope, record.id]) : undefined;
}

export function authorizeExplicitPreparation(
  receipt: InputReceipt | undefined,
  selected: readonly { query: string; record: SkillRecord }[],
  preparation?: SourcePreparationScope,
): PreparationAuthority | undefined {
  if (!receipt) return undefined;
  const queries = explicitDollarQueries(receipt.event.text ?? "");
  const roots = new Map<string, string>();
  for (const { query, record } of selected) {
    const identity = rootIdentity(record);
    if (queries.has(query) && identity) roots.set(identity, query);
  }
  if (!roots.size) return undefined;
  const authority = Object.freeze({ receiptId: receipt.id });
  grants.set(authority, { receipt, roots, preparation });
  return authority;
}

/** Narrow a submitted set to the roots the user actually selected. Requires
 * closure is decided by the manager; this token never authorizes guessed roots. */
export function authorizedPreparationRoots(
  authority: PreparationAuthority | undefined,
  selected: readonly SkillRecord[],
  ctx: ExtensionContext | undefined,
  signal: AbortSignal | undefined,
): SkillRecord[] {
  const grant = authority && grants.get(authority);
  if (!grant || !inputReceiptIsCurrent(grant.receipt, ctx, signal)) return [];
  return selected.filter(record => {
    const identity = rootIdentity(record);
    return identity !== undefined && grant.roots.has(identity);
  });
}

export function inputReceiptIsCurrent(receipt: InputReceipt, ctx: ExtensionContext | undefined, signal?: AbortSignal): boolean {
  if (!ctx || signal?.aborted || receipt.ctx.cwd !== ctx.cwd
    || receipt.sessionId !== ctx.sessionManager?.getSessionId?.()
    || receipt.sessionId !== receipt.ctx.sessionManager?.getSessionId?.()) return false;
  const branch = ctx.sessionManager?.getBranch?.()?.map(entry => entry.id).filter((id): id is string => typeof id === "string") ?? [];
  return receipt.branch.every((id, index) => branch[index] === id);
}
export function revokePreparationAuthority(authority: PreparationAuthority | undefined): void {
  if (authority) grants.delete(authority);
}
export function preparationReceipt(authority: PreparationAuthority | undefined): InputReceipt | undefined {
  return authority ? grants.get(authority)?.receipt : undefined;
}

export function preparationQuery(authority: PreparationAuthority | undefined, record: SkillRecord): string | undefined {
  const identity = rootIdentity(record);
  return authority && identity ? grants.get(authority)?.roots.get(identity) : undefined;
}

export function preparationScope(authority: PreparationAuthority | undefined): SourcePreparationScope | undefined {
  return authority ? grants.get(authority)?.preparation : undefined;
}
