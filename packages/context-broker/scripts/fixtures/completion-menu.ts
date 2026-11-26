import { localCompletionCandidate } from "../../src/completion-candidates";
import type { DiscoveryRecord } from "../../src/types";
import type { DollarMenuSource } from "../../src/dollar";

export function completionMenu(records: DiscoveryRecord[]): DollarMenuSource {
  const candidates = records.map(localCompletionCandidate), scope = {};
  return { read: () => ({ candidates, revision: 1 }), scope: () => scope, subscribe: () => () => {} };
}
