import type {
  AutocompleteItem,
  AutocompleteProvider,
  DiscoveryRecord,
  ExtensionContext,
  SkillRecord,
} from "./types";
import {
  skillSourceLabel,
  dedupeRegistryByNormalizedName,
  normalizeKey,
  skillRecordFromFile,
} from "./skill-records";
import {
  dedupeDiscoveryRecordsByNormalizedName,
  recordDescription,
  recordKind,
  recordName,
  recordNormalizedAliases,
  recordNormalizedDescription,
  recordNormalizedName,
  recordPath,
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
  return dedupeRegistryByNormalizedName(records);
}

export async function buildDollarRegistryForContext(
  ctx: ExtensionContext,
  dollarRegistryPromise: Promise<DiscoveryRecord[]>,
): Promise<DiscoveryRecord[]> {
  const baseRegistry = await dollarRegistryPromise;
  const systemPromptRegistry = buildRegistryFromSystemPrompt(ctx.getSystemPrompt?.());
  return dedupeDiscoveryRecordsByNormalizedName([...baseRegistry, ...systemPromptRegistry]);
}

export function extractDollarAutocompletePrefix(textBeforeCursor: string): string | undefined {
  const match = textBeforeCursor.match(/(?:^|[\s([{])(\$[^\s$]*)$/u);
  return match?.[1];
}

function endsAfterCompletedDollarToken(textBeforeCursor: string): boolean {
  return /(?:^|[\s([{])\$[^\s$]+\s$/u.test(textBeforeCursor);
}

function endsWithDollarLikeToken(textBeforeCursor: string): boolean {
  return /\S*\$[^\s$]*$/u.test(textBeforeCursor);
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
  const normalizedQuery = normalizeKey(query);
  if (!normalizedQuery) return 1;
  const fields = [
    { value: recordNormalizedName(record), weight: 100 },
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
  const label = kind === "bundle" ? `bundle · ${(record as any).members?.length ?? 0} members` : skillSourceLabel(recordPath(record));
  const description = compactDescription(recordDescription(record));
  if (!description) return label;
  return label ? `${label} · ${description}` : description;
}

function matchedBundleNameOrAlias(record: DiscoveryRecord, query: string): boolean {
  if (recordKind(record) !== "bundle") return false;
  const normalizedQuery = normalizeKey(query);
  if (!normalizedQuery) return false;
  return [recordNormalizedName(record), ...recordNormalizedAliases(record)]
    .some((value) => value === normalizedQuery || value.startsWith(normalizedQuery) || value.includes(normalizedQuery));
}

export function dollarAutocompleteItems(registry: DiscoveryRecord[], query: string): AutocompleteItem[] {
  return registry
    .map((record) => ({ record, score: scoreDollarSuggestion(record, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      Number(matchedBundleNameOrAlias(b.record, query)) - Number(matchedBundleNameOrAlias(a.record, query)) ||
      recordName(a.record).localeCompare(recordName(b.record))
    )
    .slice(0, 50)
    .map(({ record }) => ({
      value: `$${recordName(record)}`,
      label: recordKind(record) === "bundle" ? `$${recordName(record)} [bundle]` : `$${recordName(record)} [skill]`,
      description: autocompleteDescription(record),
    }));
}

export const discoveryAutocompleteItems = dollarAutocompleteItems;

export function createDollarSkillAutocompleteProvider(
  current: AutocompleteProvider,
  dollarRegistryPromise: Promise<DiscoveryRecord[]>,
): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const currentLine = lines[cursorLine] ?? "";
      const textBeforeCursor = currentLine.slice(0, cursorCol);
      if (endsAfterCompletedDollarToken(textBeforeCursor)) return null;
      const prefix = extractDollarAutocompletePrefix(textBeforeCursor);
      if (prefix === undefined && endsWithDollarLikeToken(textBeforeCursor)) return null;
      if (prefix === undefined) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }
      const registry = await dollarRegistryPromise;
      if (options.signal.aborted) return null;
      const items = dollarAutocompleteItems(registry, prefix.slice(1));
      if (items.length === 0) return null;
      return { items, prefix };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (prefix.startsWith("$")) {
        const currentLine = lines[cursorLine] ?? "";
        const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
        const afterCursor = currentLine.slice(cursorCol);
        const suffix = afterCursor.startsWith(" ") ? "" : " ";
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
