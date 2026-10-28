import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { isBundledBuiltin } from "./bundled-builtins";
import type {
  AutocompleteItem,
  AutocompleteProvider,
  RouterDiscoveryRecord,
  DiscoveryRecord,
  ExtensionContext,
  SkillRecord,
} from "./types";
import {
  skillSourceLabel,
  normalizeKey,
  skillRecordFromFile,
} from "./skill-records";
import {
  dedupeDiscoveryRecords,
  recordDescription,
  recordIdentity,
  recordKind,
  recordName,
  recordNormalizedAliases,
  recordNormalizedDescription,
  recordNormalizedName,
  recordPath,
  recordToken,
  preciseRecordToken,
} from "./discovery-records";

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function buildRegistryFromSystemPrompt(systemPrompt: string | string[] | undefined): SkillRecord[] {
  const text = Array.isArray(systemPrompt) ? systemPrompt.join("\n") : systemPrompt ?? "";
  const records: SkillRecord[] = [];
  const skillBlockPattern = /<skill>\s*<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>\s*<location>([\s\S]*?)<\/location>\s*<\/skill>/g;
  let match: RegExpExecArray | null;
  while ((match = skillBlockPattern.exec(text)) !== null) {
    const name = decodeXml(match[1] ?? "").trim();
    const description = decodeXml(match[2] ?? "").trim();
    const path = decodeXml(match[3] ?? "").trim();
    if (!name || !path) continue;
    const record = skillRecordFromFile(path, false, {
      name,
      description,
      autoloadEnabled: true,
    });
    if (record) records.push(record);
  }
  return dedupeDiscoveryRecords(records);
}

export async function buildDollarRegistryForContext(
  ctx: ExtensionContext,
  dollarRegistryPromise: Promise<DiscoveryRecord[]>,
): Promise<DiscoveryRecord[]> {
  const systemPrompt = ctx.getSystemPrompt?.();
  const baseRegistry = await dollarRegistryPromise;
  const localPaths = new Set<string>();
  for (const record of baseRegistry) {
    if (recordKind(record) !== "skill") continue;
    const skill = record as SkillRecord;
    const path = skill.metadataIndexPath ?? skill.path;
    try { localPaths.add(realpathSync(path)); }
    catch { localPaths.add(resolve(path)); }
  }
  const systemPromptRegistry = buildRegistryFromSystemPrompt(systemPrompt).filter(record => {
    let path: string;
    try { path = realpathSync(record.path); }
    catch { path = resolve(record.path); }
    if (localPaths.has(path)) return false;
    localPaths.add(path);
    return true;
  });
  return dedupeDiscoveryRecords([...baseRegistry, ...systemPromptRegistry]);
}

export function extractDollarAutocompletePrefix(textBeforeCursor: string): string | undefined {
  const match = textBeforeCursor.match(/(\$[^\s$]*)$/u);
  return match?.[1];
}

export function isAutocompleteCursorBoundary(lines: readonly string[], line: number, col: number): boolean {
  const text = lines[line];
  if (!Number.isInteger(line) || !Number.isInteger(col) || text === undefined || col < 0 || col > text.length) return false;
  const before = text.charCodeAt(col - 1), after = text.charCodeAt(col);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

export function dollarAutocompletePrefixAtCursor(lines: readonly string[], line: number, col: number): string | undefined {
  return isAutocompleteCursorBoundary(lines, line, col) ? extractDollarAutocompletePrefix(lines[line]!.slice(0, col)) : undefined;
}

function endsAfterCompletedDollarToken(textBeforeCursor: string): boolean {
  return /\$[^\s$]+\s$/u.test(textBeforeCursor);
}


function compactKey(value: string): string {
  return value.replace(/-/g, "");
}

function tokenInitials(value: string): string {
  return value
    .split("-")
    .filter(Boolean)
    .map((token) => token[0] ?? "")
    .join("");
}

function fuzzySubsequenceScore(normalizedQuery: string, normalizedValue: string): number {
  const query = compactKey(normalizedQuery);
  const value = compactKey(normalizedValue);
  if (query.length < 3 || !value) return 0;
  if (value.startsWith(query)) return 18;
  if (value.includes(query)) return 15;

  const initials = tokenInitials(normalizedValue);
  if (initials === query) return 18;
  if (initials.startsWith(query)) return 16;

  let valueIndex = 0;
  const positions: number[] = [];
  for (const char of query) {
    const index = value.indexOf(char, valueIndex);
    if (index < 0) return 0;
    positions.push(index);
    valueIndex = index + char.length;
  }
  const first = positions[0] ?? 0;
  const last = positions.at(-1) ?? first;
  const span = last - first + 1;
  let adjacentPairs = 0;
  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index] === positions[index - 1] + 1) adjacentPairs += 1;
  }
  const coverage = query.length / Math.max(span, 1);
  const adjacency = positions.length > 1 ? adjacentPairs / (positions.length - 1) : 0;
  const firstCharBonus = first === 0 ? 2 : 0;
  const score = 4 + coverage * 8 + adjacency * 6 + firstCharBonus;
  return score >= 10 ? Math.round(score) : 0;
}

export function scoreDollarSuggestion(record: DiscoveryRecord, query: string): number {
  if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(query)) return 0;
  const normalizedQuery = /[%@/]/u.test(query) ? query : normalizeKey(query);
  if (!normalizedQuery) return 1;
  const fields = [
    { value: recordToken(record), weight: 100 },
    ...(record.selectionToken && record.token ? [{ value: record.token, weight: 100 }] : []),
    { value: recordNormalizedName(record), weight: 100 },
    ...(recordKind(record) === "skill" && record.upstream ? [{ value: `${record.upstream.repo}/${recordNormalizedName(record)}`, weight: 100 }] : []),
    ...recordNormalizedAliases(record).map((value) => ({ value, weight: 90 })),
    { value: recordNormalizedDescription(record), weight: 60 },
  ];
  let best = 0;
  for (const field of fields) {
    if (!field.value) continue;
    if (field.value === normalizedQuery) best = Math.max(best, field.weight + 40);
    else if (field.value.startsWith(normalizedQuery)) best = Math.max(best, field.weight + 20);
    else if (field.value.includes(normalizedQuery)) best = Math.max(best, field.weight);
    else {
      const fuzzy = fuzzySubsequenceScore(normalizedQuery, field.value);
      if (fuzzy > 0) best = Math.max(best, field.weight + fuzzy);
    }
  }
  return best;
}

function compactDescription(value: string): string | undefined {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > 120 ? `${compact.slice(0, 117).trimEnd()}...` : compact;
}

function autocompleteDescription(record: DiscoveryRecord): string | undefined {
  const kind = recordKind(record);
  const label = kind === "router" ? `router · ${(record as RouterDiscoveryRecord).members?.length ?? "indexed"} members`
    : isBundledBuiltin(record) ? "bundled builtin" : (record as SkillRecord).sourceId ?? skillSourceLabel(recordPath(record));
  const description = compactDescription(recordDescription(record));
  const details = description ? (label ? `${label} · ${description}` : description) : label;
  return kind === "skill" && record.upstream
    ? [`$${recordToken(record)}`, details].filter(Boolean).join(" · ") : details;
}

function matchedRouterNameOrAlias(record: DiscoveryRecord, query: string): boolean {
  if (recordKind(record) !== "router") return false;
  const normalizedQuery = normalizeKey(query);
  if (!normalizedQuery) return false;
  return [recordNormalizedName(record), ...recordNormalizedAliases(record)]
    .some((value) => value === normalizedQuery || value.startsWith(normalizedQuery) || value.includes(normalizedQuery));
}

export function dollarAutocompleteItems(registry: DiscoveryRecord[], query: string, options: { precise?: boolean } = {}): Array<AutocompleteItem & { identity: string; kind: "skill" | "router" | "prompt"; source: "local" | "notion"; ref: string }> {
  const slash = query.indexOf("/");
  const namespace = slash < 0 ? undefined : query.slice(0, slash);
  const upstreamOnly = namespace !== undefined && registry.some(record => recordKind(record) === "skill" && record.upstream?.repo === namespace);
  return registry
    .map((record) => ({ record, score: upstreamOnly && (recordKind(record) !== "skill" || record.upstream?.repo !== namespace) ? 0 : scoreDollarSuggestion(record, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      Number(matchedRouterNameOrAlias(b.record, query)) - Number(matchedRouterNameOrAlias(a.record, query)) ||
      recordName(a.record).localeCompare(recordName(b.record))
    )
    .slice(0, 50)
    .map(({ record }) => ({
      identity: recordIdentity(record),
      kind: recordKind(record),
      source: record.source ?? "local",
      ref: record.ref ?? record.path,
      value: "$" + (options.precise ? preciseRecordToken(record) : recordToken(record)),
      label: recordKind(record) === "skill" && record.upstream ? `${record.upstream.repo}/${recordName(record)} [skill]` : `$${recordToken(record)} [${recordKind(record)}]`,
      description: autocompleteDescription(record),
    }));
}

export const discoveryAutocompleteItems = dollarAutocompleteItems;

export type DollarMenu = {
  records: DiscoveryRecord[];
  followUp?: Promise<DollarMenu>;
  notice?: string;
};

function menuItems(menu: DollarMenu, query: string) {
  const items = dollarAutocompleteItems(menu.records, query);
  if (!menu.notice) return items;
  return [...items, { identity: "notion-catalog-notice", kind: "skill" as const, source: "notion" as const, ref: "", value: "", label: menu.notice, description: "" }];
}

export function createDollarSkillAutocompleteProvider(
  current: AutocompleteProvider,
  registrySource: Promise<DiscoveryRecord[]> | (() => Promise<DiscoveryRecord[] | DollarMenu>),
  onAccept?: (record: DiscoveryRecord) => void,
): AutocompleteProvider {
  const candidates = new Map<string, DiscoveryRecord>();
  const remember = (records: DiscoveryRecord[]) => {
    for (const record of records) candidates.set(recordIdentity(record), record);
  };
  return {
    getInlineHint: current.getInlineHint?.bind(current),
    trySyncSlashCompletion: current.trySyncSlashCompletion?.bind(current),
    trySyncInlineReplace: current.trySyncInlineReplace?.bind(current),
    async getForceFileSuggestions(lines, cursorLine, cursorCol, signal) {
      if (dollarAutocompletePrefixAtCursor(lines, cursorLine, cursorCol) !== undefined) {
        return this.getSuggestions(lines, cursorLine, cursorCol, signal);
      }
      return current.getForceFileSuggestions
        ? current.getForceFileSuggestions(lines, cursorLine, cursorCol, signal)
        : current.getSuggestions(lines, cursorLine, cursorCol, signal);
    },
    async getSuggestions(lines, cursorLine, cursorCol, options, onPartial) {
      const signal = options && ("signal" in options ? options.signal : options);
      if (signal?.aborted) return null;
      if (!isAutocompleteCursorBoundary(lines, cursorLine, cursorCol)) return null;
      const currentLine = lines[cursorLine] ?? "";
      const textBeforeCursor = currentLine.slice(0, cursorCol);
      if (endsAfterCompletedDollarToken(textBeforeCursor)) return null;
      const prefix = dollarAutocompletePrefixAtCursor(lines, cursorLine, cursorCol);
      if (prefix === undefined) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options, onPartial);
      }
      const loaded = await (typeof registrySource === "function" ? registrySource() : registrySource);
      if (signal?.aborted) return null;
      let menu: DollarMenu = Array.isArray(loaded) ? { records: loaded } : loaded;
      remember(menu.records);
      // Forced completion has no partial callback. Keep its current choices usable
      // while the shared catalog refresh continues for the next editor request.
      if (menu.followUp && menu.records.length && !onPartial) {
        return { items: menuItems(menu, prefix.slice(1)), prefix };
      }
      let offered: ReturnType<typeof dollarAutocompleteItems> = [];
      const suggestions = () => {
        remember(menu.records);
        const next = menuItems(menu, prefix.slice(1));
        const byIdentity = new Map(next.filter(item => item.value).map(item => [item.identity, item]));
        const stable = offered.map(item => {
          const current = byIdentity.get(item.identity);
          byIdentity.delete(item.identity);
          return current ?? { ...item, value: "", ref: "", label: "This item is no longer available" };
        });
        offered = [...stable, ...byIdentity.values()];
        return { items: [...offered, ...next.filter(item => !item.value)], prefix };
      };
      while (menu.followUp) {
        onPartial?.(suggestions());
        const cancelled = Promise.withResolvers<null>();
        const abort = () => cancelled.resolve(null);
        signal?.addEventListener("abort", abort, { once: true });
        try {
          if (signal?.aborted) return null;
          const next = await Promise.race([menu.followUp, cancelled.promise]);
          if (!next || signal?.aborted) return null;
          menu = next;
        } finally { signal?.removeEventListener("abort", abort); }
      }
      const result = suggestions();
      return result.items.length ? result : null;
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (!item.value) return { lines, cursorLine, cursorCol };
      if (prefix.startsWith("$")) {
        if (dollarAutocompletePrefixAtCursor(lines, cursorLine, cursorCol) !== prefix) return { lines, cursorLine, cursorCol };
        const currentLine = lines[cursorLine] ?? "";
        const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
        const afterCursor = currentLine.slice(cursorCol);
        const suffix = afterCursor.startsWith(" ") ? "" : " ";
        const selected = item.identity ? candidates.get(item.identity) : undefined;
        if (selected) onAccept?.(selected);
        const nextLines = [...lines];
        nextLines[cursorLine] = `${beforePrefix}${item.value}${suffix}${afterCursor}`;
        return {
          lines: nextLines,
          cursorLine,
          cursorCol: beforePrefix.length + item.value.length + suffix.length,
        };
      }
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}
