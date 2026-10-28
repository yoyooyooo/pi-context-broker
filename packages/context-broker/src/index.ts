import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  buildDollarRegistryForContext,
  buildRegistryFromSystemPrompt,
  createDollarSkillAutocompleteProvider,
  discoveryAutocompleteItems,
  dollarAutocompleteItems,
  extractDollarAutocompletePrefix,
  scoreDollarSuggestion,
  type DollarMenu,
} from "./dollar";
import { notionCatalogAction, notionCatalogRetryGapMs } from "./catalog-menu";
import {
  buildRegistryFromRoots,
  dedupeLocalSkillPaths,
  normalizeKey,
  skillRecordFromFile,
  stringArray,
  uniqueStrings,
} from "./skill-records";
import {
  buildDiscoveryRegistryFromParts,
  configuredDiscoveryCatalogs,
  readDiscoveryCatalog,
  validateDiscoveryRecords,
  recordAliases,
  recordDescription,
  recordKind,
  recordName,
  recordNormalizedAliases,
  recordNormalizedDescription,
  recordNormalizedName,
  recordPath,
  recordIdentity,
  recordToken,
  isPreciseSelectionToken,
  matchesPreciseRecordToken,
  dedupeDiscoveryRecords,
  InvocationError,
} from "./discovery-records";
import { discoverSourceCatalog, loadSourceSkill, normalizeSources, formatSourceFailures } from "./sources";
import { diagnoseNotionSource, sourceFailureMessage, SourceError, ReferenceMiss } from "./notion-source";
import { installHostSkills } from "./host-skills";
import { resolveViewDiscovery, createViewCommands } from "./view-discovery";
import { createSourceRuntime } from "./source-runtime";
import { installCliWriteInvalidation } from "./cli-write-invalidation";
import { createOmpHostAdapter } from "./omp-host-adapter";
import { createPiHostAdapter } from "./pi-host-adapter";
import { hostCliScope } from "./host-command";
import { bundledBuiltinRecords, isBundledBuiltin, isBundledBuiltinToken } from "./bundled-builtins";
import { createAcceptedSelections } from "./accepted-selections";
import { notifyUnavailableReferences, renderUnavailableReferences, unavailableReferenceDetails, type UnavailableReference } from "./unavailable-references";
import {
  collectRootDiagnostics,
  formatFindDiagnostics,
  formatRootDiagnostics,
} from "./diagnostics";
import type { HostCapabilities } from "./host-adapter";
import type {
  AgentMessage,
  BeforeAgentStartEvent,
  BeforeAgentStartResult,
  ConfigFile,
  ContextEvent,
  ContextInjection,
  ContextResult,
  DiscoveryResult,
  DiscoveryRecord,
  ExtensionAPI,
  ExtensionContext,
  HostPathOptions,
  InvocationRule,
  MatchDecision,
  MatchPredicate,
  MessageContent,
  PathMode,
  RegexPattern,
  RouterDiscoveryRecord,
  ScanConfig,
  SourceConfig,
  SessionEntry,
  SkillRecord,
  SkillRequest,
  TextContent,
} from "./types";

import { invocationText } from "./invocation-text";

const CUSTOM_TYPE = "context-broker";
const BUILTIN_SKILL_PROMPT_TYPE = "skill-prompt";
const CLI_GUIDANCE_TYPE = "ntn-skills-guidance";
const CONFIG_DIR_BASENAME = "context-broker";
const DEFAULT_CONFIG_FILE_BASENAME = "config";
const DEFAULT_CONFIG_EXTENSIONS = [".yml", ".yaml", ".json"];
const DEFAULT_RULE_ROOT_BASENAME = "rules";
const RULE_FILE_EXTENSIONS = new Set(DEFAULT_CONFIG_EXTENSIONS);
const DEFAULT_PATH_MODE: PathMode = "home-relative";
const DOLLAR_SKILL_PATTERN = "(?:^|[^\\w\\\\$])\\$(?<query>[^\\s$]+?)(?=$|[\\s,，。!！？?；;、:：)）\\]】}]|\\.+(?=$|[\\s,，。!！？?；;、:：)）\\]】}]))";
const DEFAULT_RULES: InvocationRule[] = [
  { id: "dollar-skill", match: [{ regex: [{ pattern: DOLLAR_SKILL_PATTERN, flags: "g" }] }] },
  { id: "skill-colon", match: [{ regex: [{ pattern: "^\\s*skill[:：]\\s*(?<query>.+?)\\s*$" }] }] },
  { id: "use-skill-en", match: [{ regex: [{ pattern: "^\\s*use\\s+(?<query>.+?)\\s+skill\\s*$", flags: "i" }] }] },
  { id: "use-skill-en-reversed", match: [{ regex: [{ pattern: "^\\s*use\\s+skill\\s+(?<query>.+?)\\s*$", flags: "i" }] }] },
  { id: "use-skill-zh", match: [{ regex: [{ pattern: "^\\s*使用\\s*(?<query>.+?)\\s*(?:skill|技能)\\s*$", flags: "i" }] }] },
];

function splitEnvList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(delimiter).map((part) => part.trim()).filter(Boolean);
}

function homeDir(): string {
  return process.env.HOME || homedir();
}

function expandPath(path: string, cwd = process.cwd()): string {
  const home = homeDir();
  const expanded = path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function defaultAgentDir(options: HostPathOptions = {}): string | undefined {
  return defaultAgentDirs(options)[0];
}

function defaultAgentDirs(options: HostPathOptions = {}): string[] {
  if (options.agentDir) return [expandPath(options.agentDir)];
  const envAgentDir = process.env.PI_CODING_AGENT_DIR;
  if (envAgentDir) return [expandPath(envAgentDir)];
  const override = process.env.CONTEXT_BROKER_HOST?.trim().toLowerCase();
  const argv = [process.execPath, ...process.argv].map((part) => basename(part).toLowerCase());
  const host = override === "pi" || override === "omp" ? override : options.host
    ?? (argv.some(part => part === "omp" || part.startsWith("omp-") || part.includes("oh-my-pi")) ? "omp"
      : argv.some(part => part === "pi" || part.includes("earendil-works")) ? "pi"
      : process.env.PI_CONFIG_DIR ? "omp" : undefined);
  const home = homeDir();
  if (host === "omp") return [join(home, process.env.PI_CONFIG_DIR || ".omp", "agent")];
  if (host === "pi") return [join(home, ".pi", "agent")];
  return [
    join(home, ".pi", "agent"),
    join(home, process.env.PI_CONFIG_DIR || ".omp", "agent"),
  ];
}

function candidateConfigPaths(agentDir: string): string[] {
  return DEFAULT_CONFIG_EXTENSIONS.map((extension) => join(agentDir, CONFIG_DIR_BASENAME, `${DEFAULT_CONFIG_FILE_BASENAME}${extension}`));
}

function firstExistingConfigPath(agentDir: string): string | undefined {
  return candidateConfigPaths(agentDir).find((path) => existsSync(path));
}

function defaultConfigPath(options: HostPathOptions = {}): string | undefined {
  const agentDirs = defaultAgentDirs(options);
  for (const agentDir of agentDirs) {
    const path = firstExistingConfigPath(agentDir);
    if (path) return path;
  }
  const agentDir = agentDirs[0];
  return agentDir ? join(agentDir, CONFIG_DIR_BASENAME, `${DEFAULT_CONFIG_FILE_BASENAME}${DEFAULT_CONFIG_EXTENSIONS[0]}`) : undefined;
}

function resolveConfigPaths(options: HostPathOptions = {}): string[] {
  const explicit = options.configPath ?? process.env.CONTEXT_BROKER_CONFIG;
  if (explicit) return [expandPath(explicit)];
  const paths = defaultAgentDirs(options)
    .map(firstExistingConfigPath)
    .filter((path): path is string => path !== undefined);
  return uniqueStrings(paths);
}

function resolveConfigPath(options: HostPathOptions = {}): string | undefined {
  return resolveConfigPaths(options)[0];
}

function parseConfigFile(configPath: string): unknown {
  const content = readFileSync(configPath, "utf8");
  const extension = extname(configPath).toLowerCase();
  if (extension === ".yml" || extension === ".yaml") return parseYaml(content);
  return JSON.parse(content);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeConfigs(configs: ConfigFile[]): ConfigFile {
  const requireAutoloadValues = configs
    .map((config) => config.requireAutoload)
    .filter((value): value is boolean => typeof value === "boolean");
  const pathModes = configs.map((config) => config.pathMode).filter((value): value is PathMode => Boolean(value));
  const logPathValues = configs.map((config) => config.logPaths).filter((value): value is boolean => typeof value === "boolean");
  return {
    skillRoots: uniqueStrings(configs.flatMap((config) => config.skillRoots ?? [])),
    extraSkillRoots: uniqueStrings(configs.flatMap((config) => config.extraSkillRoots ?? [])),
    ruleRoots: uniqueStrings(configs.flatMap((config) => config.ruleRoots ?? [])),
    discoveryCatalogs: uniqueStrings(configs.flatMap((config) => config.discoveryCatalogs ?? [])),
    extraDiscoveryCatalogs: uniqueStrings(configs.flatMap((config) => config.extraDiscoveryCatalogs ?? [])),
    rules: uniqueRules(configs.flatMap((config) => config.rules ?? [])),
    sources: normalizeSources(configs.flatMap(config => config.sources ?? [])),
    requireAutoload: requireAutoloadValues.length > 0 ? requireAutoloadValues.at(-1) : undefined,
    pathMode: pathModes.at(-1),
    logPaths: logPathValues.length > 0 ? logPathValues.at(-1) : undefined,
    scan: mergeScanConfigs(configs.map((config) => config.scan)),
    debug: configs.some((config) => config.debug === true) || undefined,
  };
}

function mergeScanConfigs(configs: Array<ScanConfig | undefined>): ScanConfig | undefined {
  const defined = configs.filter((config): config is ScanConfig => Boolean(config));
  if (defined.length === 0) return undefined;
  const maxDepthValues = defined.map((config) => config.maxDepth).filter((value): value is number => typeof value === "number");
  const maxSkillBytesValues = defined.map((config) => config.maxSkillBytes).filter((value): value is number => typeof value === "number");
  return {
    maxDepth: maxDepthValues.at(-1),
    ignore: uniqueStrings(defined.flatMap((config) => config.ignore ?? [])),
    maxSkillBytes: maxSkillBytesValues.at(-1),
  };
}

function uniqueRules(rules: InvocationRule[]): InvocationRule[] | undefined {
  const seen = new Set<string>();
  const result: InvocationRule[] = [];
  for (const rule of rules) {
    const key = JSON.stringify(rule);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(rule);
  }
  return result.length > 0 ? result : undefined;
}

function ruleRootsForConfig(configPath: string, config: ConfigFile): string[] {
  const baseDir = dirname(configPath);
  const defaultRuleRoot = join(baseDir, DEFAULT_RULE_ROOT_BASENAME);
  const roots = config.ruleRoots && config.ruleRoots.length > 0 ? config.ruleRoots : [defaultRuleRoot];
  return uniqueStrings(roots.map((root) => expandPath(root, baseDir)));
}

function listRuleConfigFiles(ruleRoots: string[]): string[] {
  const files: string[] = [];
  for (const ruleRoot of ruleRoots) {
    let entries;
    try {
      entries = readdirSync(ruleRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      if (!RULE_FILE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      files.push(join(ruleRoot, entry.name));
    }
  }
  return uniqueStrings(files).sort();
}

function normalizeStringList(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean));
}

function normalizeInject(value: unknown): string[] {
  return normalizeStringList(value);
}

function normalizePathMode(value: unknown): PathMode | undefined {
  return value === "absolute" || value === "home-relative" || value === "basename" || value === "hash" ? value : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return undefined;
  return value;
}

function normalizeScanConfig(value: unknown): ScanConfig | undefined {
  if (!isRecord(value)) return undefined;
  const ignore = normalizeStringList(value.ignore);
  const scan: ScanConfig = {
    maxDepth: normalizePositiveInteger(value.maxDepth),
    ignore,
    maxSkillBytes: normalizePositiveInteger(value.maxSkillBytes),
  };
  return scan.maxDepth !== undefined || ignore.length > 0 || scan.maxSkillBytes !== undefined ? scan : undefined;
}

function normalizeRegexPattern(value: unknown): RegexPattern | undefined {
  if (typeof value === "string" && value.trim()) return { pattern: value };
  if (!isRecord(value) || typeof value.pattern !== "string" || !value.pattern.trim()) return undefined;
  return {
    pattern: value.pattern,
    flags: typeof value.flags === "string" ? value.flags : undefined,
  };
}

function normalizeRegexPatterns(value: unknown): RegexPattern[] {
  if (!Array.isArray(value)) {
    const pattern = normalizeRegexPattern(value);
    return pattern ? [pattern] : [];
  }
  return value
    .map(normalizeRegexPattern)
    .filter((pattern): pattern is RegexPattern => pattern !== undefined);
}

function normalizeNotList(value: unknown): MatchPredicate[] {
  if (!Array.isArray(value)) {
    const predicate = normalizeMatchPredicate(value);
    return predicate ? [predicate] : [];
  }
  return value
    .map(normalizeMatchPredicate)
    .filter((predicate): predicate is MatchPredicate => predicate !== undefined);
}

function normalizeMatchPredicate(value: unknown): MatchPredicate | undefined {
  if (!isRecord(value)) return undefined;
  const exact = normalizeStringList(value.exact);
  const contains = normalizeStringList(value.contains);
  const regex = normalizeRegexPatterns(value.regex);
  const not = normalizeNotList(value.not);
  if (exact.length === 0 && contains.length === 0 && regex.length === 0) return undefined;
  return {
    exact: exact.length > 0 ? exact : undefined,
    contains: contains.length > 0 ? contains : undefined,
    regex: regex.length > 0 ? regex : undefined,
    not: not.length > 0 ? not : undefined,
  };
}

function normalizeMatchList(value: unknown): MatchPredicate[] {
  if (!Array.isArray(value)) {
    const predicate = normalizeMatchPredicate(value);
    return predicate ? [predicate] : [];
  }
  return value
    .map(normalizeMatchPredicate)
    .filter((predicate): predicate is MatchPredicate => predicate !== undefined);
}

function normalizeRuleConfigFile(parsed: unknown, filePath: string): ConfigFile {
  if (!isRecord(parsed) || parsed.enabled === false) return {};
  const fileId = basename(filePath, extname(filePath));
  const declaredRules = Array.isArray(parsed.rules)
    ? parsed.rules
      .map((value, index) => normalizeInvocationRule(value, `${fileId}-${index + 1}`))
      .filter((rule): rule is InvocationRule => rule !== undefined)
    : [];
  const legacyRule = declaredRules.length === 0 ? normalizeInvocationRule(parsed, fileId) : undefined;
  const rules = declaredRules.length > 0 ? declaredRules : legacyRule ? [legacyRule] : [];

  return {
    rules: rules.length > 0 ? rules : undefined,
    debug: parsed.debug === true || undefined,
  };
}

function normalizeInvocationRule(value: unknown, fallbackId: string): InvocationRule | undefined {
  if (!isRecord(value) || value.enabled === false) return undefined;
  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : fallbackId;
  const inject = normalizeInject(value.inject);
  const match = normalizeMatchList(value.match);
  return inject.length > 0 && match.length > 0 ? { id, inject, match } : undefined;
}

function readRuleConfigs(configPath: string, config: ConfigFile): ConfigFile[] {
  const configs: ConfigFile[] = [];
  for (const ruleFile of listRuleConfigFiles(ruleRootsForConfig(configPath, config))) {
    try {
      configs.push(normalizeRuleConfigFile(parseConfigFile(ruleFile), ruleFile));
    } catch {
      continue;
    }
  }
  return configs;
}

function normalizeMainConfig(parsed: unknown): ConfigFile {
  if (!isRecord(parsed)) return {};
  return {
    skillRoots: stringArray(parsed.skillRoots),
    sources: normalizeSources(parsed.sources),
    extraSkillRoots: stringArray(parsed.extraSkillRoots),
    ruleRoots: stringArray(parsed.ruleRoots),
    discoveryCatalogs: stringArray(parsed.discoveryCatalogs),
    extraDiscoveryCatalogs: stringArray(parsed.extraDiscoveryCatalogs),
    requireAutoload: typeof parsed.requireAutoload === "boolean" ? parsed.requireAutoload : undefined,
    pathMode: normalizePathMode(parsed.pathMode),
    logPaths: typeof parsed.logPaths === "boolean" ? parsed.logPaths : undefined,
    scan: normalizeScanConfig(parsed.scan),
    debug: parsed.debug === true || undefined,
  };
}

function readConfig(options: HostPathOptions = {}): ConfigFile {
  const configs: ConfigFile[] = [];
  for (const configPath of resolveConfigPaths(options)) {
    try {
      const parsed = parseConfigFile(configPath);
      const config = normalizeMainConfig(parsed);
      configs.push(config);
      configs.push(...readRuleConfigs(configPath, config));
    } catch (error) {
      throw new Error(`context-broker config failed: ${configPath}: ${errorMessage(error)}`);
    }
  }
  if (configs.length === 0) return {};
  if (configs.length === 1) return configs[0];
  return mergeConfigs(configs);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function collectConfigDiagnostics(options: HostPathOptions): string[] {
  const diagnostics: string[] = [];
  for (const configPath of resolveConfigPaths(options)) {
    try {
      const parsed = parseConfigFile(configPath);
      const config = normalizeMainConfig(parsed);
      for (const ruleFile of listRuleConfigFiles(ruleRootsForConfig(configPath, config))) {
        try {
          normalizeRuleConfigFile(parseConfigFile(ruleFile), ruleFile);
        } catch (error) {
          diagnostics.push(`rule parse failed: ${ruleFile}: ${errorMessage(error)}`);
        }
      }
    } catch (error) {
      diagnostics.push(`config parse failed: ${configPath}: ${errorMessage(error)}`);
    }
  }
  return diagnostics;
}

function configuredRoots(config: ConfigFile): string[] {
  const envRoots = splitEnvList(process.env.CONTEXT_BROKER_ROOTS);
  const envExtraRoots = splitEnvList(process.env.CONTEXT_BROKER_EXTRA_ROOTS);
  const roots = [
    ...(envRoots.length > 0 ? envRoots : config.skillRoots ?? []),
    ...(config.extraSkillRoots ?? []),
    ...envExtraRoots,
  ];
  return uniqueStrings(roots.map((root) => expandPath(root)));
}

function configuredRules(config: ConfigFile): InvocationRule[] {
  const rules = config.rules ?? [];
  return uniqueRules([...DEFAULT_RULES, ...rules]) ?? DEFAULT_RULES;
}

function textFromContent(content: MessageContent | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is TextContent => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function latestUserText(messages: AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const text = textFromContent(message.content).trim();
    if (text) return text;
  }
  return undefined;
}

function shouldRequireAutoload(config: ConfigFile): boolean {
  const requireEnabled = process.env.CONTEXT_BROKER_REQUIRE_ENABLED;
  if (requireEnabled === "0") return false;
  if (requireEnabled === "1") return true;
  return config.requireAutoload !== false;
}

function scanOptions(config: ConfigFile): ScanConfig {
  return config.scan ?? {};
}

async function buildRegistry(config?: ConfigFile, paths: HostPathOptions = {}): Promise<SkillRecord[]> {
  config ??= readConfig(paths);
  const requireAutoload = shouldRequireAutoload(config);
  return dedupeDiscoveryRecords(dedupeLocalSkillPaths([
    ...bundledBuiltinRecords(requireAutoload, scanOptions(config)),
    ...await buildRegistryFromRoots(configuredRoots(config), requireAutoload, scanOptions(config)),
  ]));
}

function discoverUsableSkillRoots(config: ConfigFile = readConfig(), cwd = process.cwd()): string[] {
  return uniqueStrings(configuredRoots(config).map((root) => expandPath(root, cwd)));
}

async function buildDiscoveryRegistry(config: ConfigFile = readConfig(), cwd = process.cwd(), options: { refresh?: boolean; stale?: boolean; refreshSourceIds?: readonly string[]; paths?: HostPathOptions } = {}): Promise<DiscoveryResult> {
  const skills = dedupeLocalSkillPaths([
    ...bundledBuiltinRecords(false, scanOptions(config)),
    ...await buildRegistryFromRoots(discoverUsableSkillRoots(config, cwd), false, scanOptions(config)),
  ]);
  const sources = await discoverSourceCatalog(config, cwd, options);
  return { records: dedupeDiscoveryRecords([
    ...await buildDiscoveryRegistryFromParts(skills, configuredDiscoveryCatalogs(config, cwd), scanOptions(config), { sources: config.sources, records: sources.records, failures: sources.failures }),
    ...sources.records,
  ]), failures: sources.failures, lists: sources.lists };
}

async function buildDollarRegistry(config?: ConfigFile, cwd = process.cwd(), paths: HostPathOptions = {}): Promise<DiscoveryResult> {
  return buildDiscoveryRegistry(config ?? readConfig(paths), cwd, { paths });
}

async function buildRawDollarRegistry(config: ConfigFile = readConfig(), cwd = process.cwd(), paths: HostPathOptions = {}): Promise<DiscoveryResult> {
  const skills = dedupeDiscoveryRecords(dedupeLocalSkillPaths([
    ...bundledBuiltinRecords(false, scanOptions(config)),
    ...await buildRegistryFromRoots(discoverUsableSkillRoots(config, cwd), false, scanOptions(config)),
  ]));
  const sources = await discoverSourceCatalog(config, cwd);
  const catalogRecords = configuredDiscoveryCatalogs(config, cwd).flatMap(catalog => readDiscoveryCatalog(catalog, skills, scanOptions(config), { sources: config.sources, records: sources.records, failures: sources.failures }));
  return { records: [
    ...skills.map(skill => ({ ...skill, kind: "skill" as const })),
    ...catalogRecords,
    ...sources.records.filter(record => !catalogRecords.some(catalogRecord => recordIdentity(catalogRecord) === recordIdentity(record))),
  ], failures: sources.failures, lists: sources.lists };
}

function compileRegex(pattern: RegexPattern): RegExp | undefined {
  try {
    return new RegExp(pattern.pattern, pattern.flags);
  } catch {
    return undefined;
  }
}

function predicateMatches(text: string, predicate: MatchPredicate): { matched: boolean; query?: string } {
  const [first] = predicateMatchResults(text, predicate);
  return first ?? { matched: false };
}

function predicateMatchResults(text: string, predicate: MatchPredicate): Array<{ matched: true; query?: string }> {
  if (predicate.exact && !predicate.exact.some((value) => text.trim() === value.trim())) {
    return [];
  }
  if (predicate.contains && !predicate.contains.some((value) => text.includes(value))) {
    return [];
  }
  const results: Array<{ matched: true; query?: string }> = [];
  if (predicate.regex) {
    for (const pattern of predicate.regex) {
      const regex = compileRegex(pattern);
      if (!regex) continue;
      const global = regex.global;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        const matchedQuery = match.groups?.query ?? match[1];
        results.push({
          matched: true,
          query: typeof matchedQuery === "string" && matchedQuery.trim() ? matchedQuery.trim() : undefined,
        });
        if (!global) break;
        if (match[0] === "") regex.lastIndex += 1;
      }
    }
    if (results.length === 0) return [];
  } else {
    results.push({ matched: true });
  }
  if (predicate.not?.some((negative) => predicateMatches(text, negative).matched)) {
    return [];
  }
  return results;
}

function parseInvocations(text: string, rules: InvocationRule[]): SkillRequest[] {
  text = invocationText(text);
  const requests: SkillRequest[] = [];
  for (const rule of rules) {
    for (let index = 0; index < rule.match.length; index += 1) {
      const results = predicateMatchResults(text, rule.match[index]);
      if (results.length === 0) continue;
      for (const result of results) {
        const queries = rule.inject && rule.inject.length > 0 ? rule.inject : result.query ? [result.query] : [];
        for (const rawQuery of queries) {
          const trimmedQuery = rawQuery.trim();
          if (!trimmedQuery) continue;
          const explicitRouter = rule.id !== "dollar-skill" && trimmedQuery.startsWith("router:");
          const query = explicitRouter ? trimmedQuery.slice("router:".length).trim() : trimmedQuery;
          if (!query) continue;
          requests.push({
            query,
            ruleId: rule.id,
            matchIndex: index,
            scope: explicitRouter ? "catalog" : rule.id === "dollar-skill" ? "global" : "configured",
          });
        }
      }
    }
  }
  return requests;
}

function parseInvocation(text: string, rules: InvocationRule[]): { query: string; ruleId: string } | undefined {
  const [first] = parseInvocations(text, rules);
  return first ? { query: first.query, ruleId: first.ruleId } : undefined;
}

function matchDiscoveryRecord(query: string, registry: DiscoveryRecord[], allowFuzzy = false): MatchDecision {
  if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(query)) return { decision: "skip", reason: "invalid-query", query };
  const normalized = normalizeKey(query);
  if (!normalized) return { decision: "skip", reason: "empty-query", query };
  if (isBundledBuiltinToken(query)) registry = registry.filter(isBundledBuiltin);
  const qualified = query.includes("/") || query.includes("@");
  const exact = registry.filter(record => recordToken(record) === query || record.token === query || matchesPreciseRecordToken(query, record)
    || (!record.sourceId && !isBundledBuiltin(record) && query === `${recordNormalizedName(record)}@local`));
  const candidates = exact.length ? exact : registry.filter(record => (record.sourceId && query === `${record.alias ?? recordNormalizedName(record)}@${record.token?.split("/")[0] ?? record.sourceId}`) || (!qualified && (
    record.source === "notion"
      ? record.alias === query || record.name === query
      : recordNormalizedName(record) === normalized || recordNormalizedName(record) === query || recordNormalizedAliases(record).includes(normalized) || recordDescription(record) && normalizeKey(recordDescription(record)) === normalized
  )));
  if (candidates.length === 1) {
    const record = candidates[0];
    const coverage = (record as SkillRecord).coverage;
    if (!exact.length && record.source === "notion" && coverage && typeof coverage === "object" && "exhaustive" in coverage && coverage.exhaustive === false) {
      throw new SourceError("CATALOG_INCOMPLETE", record.sourceId ?? "notion");
    }
    return { decision: "inject", reason: "unique-name-or-alias", query, record };
  }
  if (candidates.length > 1) {
    return { decision: "skip", reason: "ambiguous", query, candidates };
  }

  if (allowFuzzy && !qualified) {
    const fuzzy = registry
      .filter(record => !(record as SkillRecord).sourceId)
      .map((record) => ({ record, score: scoreDollarSuggestion(record, query) }))
      .filter((item) => item.score >= 110)
      .sort((a, b) => b.score - a.score || recordName(a.record).localeCompare(recordName(b.record)));
    const [best, second] = fuzzy;
    if (best && (!second || best.score > second.score)) {
      return { decision: "inject", reason: "unique-fuzzy", query, record: best.record };
    }
    if (best && second && best.score === second.score) {
      return { decision: "skip", reason: "ambiguous", query, candidates: fuzzy.filter((item) => item.score === best.score).map((item) => item.record) };
    }
  }
  return { decision: "skip", reason: "not-found", query };
}

function matchSkill(query: string, registry: SkillRecord[], allowFuzzy = false): MatchDecision {
  return matchDiscoveryRecord(query, registry, allowFuzzy);
}

function resolveSkillRequests(
  requests: SkillRequest[],
  registry: SkillRecord[],
  logExtra: Record<string, unknown> = {},
  globalRegistry: DiscoveryRecord[] = [],
  config: ConfigFile = {},
  accepted: ReadonlyMap<string, DiscoveryRecord> = new Map(),
): { injections: ContextInjection[]; unavailable: UnavailableReference[] } {
  const injections: ContextInjection[] = [];
  const unavailable: UnavailableReference[] = [];
  const byRecordKey = new Map<string, ContextInjection>();
  for (const request of requests) {
    const selected = request.scope === "global" ? accepted.get(request.query) : undefined;
    const decision: MatchDecision = selected
      ? { decision: "inject", reason: "accepted-selection", query: request.query, record: selected }
      : request.scope === "global"
      ? matchDiscoveryRecord(request.query, globalRegistry, true)
      : request.scope === "catalog"
        ? matchDiscoveryRecord(
          request.query,
          globalRegistry.filter((record) => recordKind(record) === "router"),
          false,
        )
        : matchSkill(request.query, registry.filter(record => recordKind(record) === "skill"), false);
    if (decision.decision !== "inject") {
      logDecision(decision, { ...logExtra, ruleId: request.ruleId, matchIndex: request.matchIndex }, config);
      if (request.scope === "global" && decision.reason === "not-found" && isPreciseSelectionToken(request.query) && !unavailable.some(item => item.query === request.query)) {
        unavailable.push({ query: request.query, reason: "catalog-unavailable" });
      }
      if (request.scope === "global" && decision.reason === "ambiguous" && (request.query.includes("/") || request.query.includes("@") || decision.candidates?.some(record => Boolean(record.sourceId) || isBundledBuiltin(record)))) throw new InvocationError(request.query, decision.reason, decision.candidates);
      continue;
    }
    if (recordKind(decision.record) === "prompt" && request.ruleId !== "dollar-skill") continue;
    const recordKey = recordIdentity(decision.record);
    const existing = byRecordKey.get(recordKey);
    if (existing) {
      existing.ruleIds = uniqueStrings([...existing.ruleIds, request.ruleId]);
      continue;
    }
    const injection = { record: decision.record, query: request.query, ruleIds: [request.ruleId] };
    byRecordKey.set(recordKey, injection);
    injections.push(injection);
  }
  return { injections, unavailable };
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function messageTextIncludesRecordBlock(message: AgentMessage, record: DiscoveryRecord): boolean {
  if (message.role !== "custom" || message.customType !== CUSTOM_TYPE) return false;
  if ((record as SkillRecord).sourceId) return false;
  const text = textFromContent(message.content);
  if (!text) return false;
  const namePatterns = [recordName(record), ...recordAliases(record)]
    .map(escapedPattern)
    .filter(Boolean);
  if (namePatterns.length === 0) return false;
  return namePatterns.some((name) => new RegExp(`<context-broker-record\\s+(?=[^>]*kind="${recordKind(record)}")(?=[^>]*name="${name}")[^>]*>`, "i").test(text));
}

function messageTextIncludesSkillBlock(message: AgentMessage, skill: SkillRecord): boolean {
  return messageTextIncludesRecordBlock(message, skill);
}

function hasLoadedRecord(messages: AgentMessage[], record: DiscoveryRecord): boolean {
  if (recordKind(record) === "prompt") return false;
  const normalizedPath = resolve(recordPath(record));
  const normalizedName = recordNormalizedName(record);
  const kind = recordKind(record);
  const sourceSkill = record as SkillRecord;
  if (sourceSkill.sourceId) {
    const identity = recordIdentity(record);
    return messages.some(message => {
      if (message.role !== "custom") return false;
      const details = isRecord(message.details) ? message.details : {};
      if (message.customType === BUILTIN_SKILL_PROMPT_TYPE) {
        return typeof details.path === "string" && resolve(details.path) === resolve(sourceSkill.metadataIndexPath ?? sourceSkill.path);
      }
      if (message.customType !== CUSTOM_TYPE && message.customType !== "skill-prompt-message") return false;
      if (typeof details.nativePromptSha256 === "string" && !messages.some(candidate => candidate.role === "user" && createHash("sha256").update(textFromContent(candidate.content)).digest("hex") === details.nativePromptSha256)) return false;
      const records = Array.isArray(details.records) ? details.records : [details];
      return records.some(item => isRecord(item) && item.identity === identity && (item.loaded === true || typeof item.snapshotId === "string"));
    });
  }
  for (const message of messages) {
    const details = message.details && typeof message.details === "object" ? message.details as Record<string, unknown> : {};
    const detailName = typeof details.name === "string" ? normalizeKey(details.name) : "";
    const detailKind = typeof details.kind === "string" ? details.kind : "skill";
    const detailPath = typeof details.path === "string" ? resolve(details.path) : "";
    const detailSourcePath = typeof details.sourcePath === "string" ? resolve(details.sourcePath) : "";
    if (message.role === "custom" && message.customType === CUSTOM_TYPE) {
      const detailRecords = Array.isArray(details.records) ? details.records : [];
      if (detailRecords.some((item) => {
        if (!isRecord(item)) return false;
        const itemName = typeof item.name === "string" ? normalizeKey(item.name) : "";
        const itemKind = typeof item.kind === "string" ? item.kind : "skill";
        const itemPath = typeof item.path === "string" ? resolve(item.path) : "";
        const itemSourcePath = typeof item.sourcePath === "string" ? resolve(item.sourcePath) : "";
        return item.identity === recordIdentity(record) || itemKind === kind && (itemPath === normalizedPath || itemSourcePath === normalizedPath);
      })) {
        return true;
      }
      if (details.identity === recordIdentity(record) || detailKind === kind && (detailPath === normalizedPath || detailSourcePath === normalizedPath)) return true;
    }
    if (kind === "skill" && message.role === "custom" && message.customType === BUILTIN_SKILL_PROMPT_TYPE) {
      if (detailPath === normalizedPath) return true;
    }

  }
  return false;
}

function hasLoadedSkill(messages: AgentMessage[], skill: SkillRecord): boolean {
  return hasLoadedRecord(messages, skill);
}

function messagesFromSessionEntries(entries: SessionEntry[] | undefined): AgentMessage[] {
  if (!entries) return [];
  return entries
    .map((entry): AgentMessage | undefined => {
      if (entry.type === "message" && entry.message) return entry.message;
      if (entry.type === "custom_message" || entry.type === "custom") {
        return {
          role: "custom",
          customType: entry.customType,
          content: entry.content,
          details: entry.details,
        };
      }
      return undefined;
    })
    .filter((message): message is AgentMessage => message !== undefined);
}

function messagesFromActiveSessionContext(ctx: ExtensionContext): AgentMessage[] {
  const activeMessages = ctx.sessionManager?.buildSessionContext?.()?.messages;
  if (Array.isArray(activeMessages)) return activeMessages;
  return messagesFromSessionEntries(ctx.sessionManager?.getEntries?.());
}

function buildCliGuidance(config: ConfigFile): Omit<AgentMessage, "role" | "timestamp"> {
  const sources = (config.sources ?? []).filter(source => source.type === "notion" && source.enabled !== false);
  const scopes = sources.length ? sources.map(source => hostCliScope([source])) : [hostCliScope()];
  const content = [
    "<ntn-skills-guidance>",
    "Use ntn-skills to discover, read, maintain and sync Skills when requested by the user.",
    ...scopes.map(scope => {
      const database = scope.database ? ["--database", scope.database] : [];
      return [
        `<cli${scope.sourceId ? ` source="${escapeAttribute(scope.sourceId)}"` : ""}${scope.database ? ` database="${escapeAttribute(scope.database)}"` : ""}>${escapeText(JSON.stringify(scope.command))}`,
        `<list-args>${escapeText(JSON.stringify(["list", ...database, "--query", "TERM"]))}</list-args>`,
        `<read-args>${escapeText(JSON.stringify(["read", "EXACT_REF", ...database]))}</read-args>`,
        `<files-args>${escapeText(JSON.stringify(["files", "SNAPSHOT", ...database]))}</files-args>`,
        `<resource-read-args>${escapeText(JSON.stringify(["read", "SNAPSHOT", "--path", "RELATIVE", ...database]))}</resource-read-args>`,
        "</cli>",
      ].join("\n");
    }),
    "Append an argument array to its cli executable argv, replacing TERM/EXACT_REF/SNAPSHOT/RELATIVE with task values. Keep the supplied database scope on list/read/files.",
    "Each cli scope belongs to the named source and database. Use the scope matching the selected content or explicitly requested target; never choose the first source implicitly. For writes, follow the ordinary bundled maintenance or sync Skill and the same CLI scope.",
    "A successful read returns top-level content (the body), pinned ref, and snapshot_id (the files/resource-read target). The record field is metadata. Keep JSON output so ok/error and snapshot identity can be checked.",
    "Choose from supplied metadata; otherwise search with a short name or keyword, broadening an empty query. Select one suitable record before reading its body. Discover through metadata or the CLI, not cache directories.",
    "A complete Skill body supplied by the host/Broker or a successful read is already read. Use it directly. For introductions and summaries, do not reread the entry, list its cache directory, or inspect package/agent metadata.",
    "Read referenced resources only when the current task needs their contents. Resolve a requested relative file directly from a visible Skill directory, without first listing directories or searching the cwd. For CLI resources, use resource-read-args: read SNAPSHOT --path RELATIVE reads the named file on the selected version; files SNAPSHOT lists its inventory when needed. Snapshot arguments avoid shell tools interpreting skill:// URI arguments as filesystem paths. Keep the selected snapshot and supplied database scope.",
    "Check CLI ok/error before using results. Use COMMAND --help for syntax details or an invalid option. When asked to inspect, introduce or summarize a Skill, describe its instructions as content; do not adopt its workflow, style, prerequisite discovery, repository checks or delegation steps unless the user asks to perform them.",
    "</ntn-skills-guidance>",
  ].join("\n");
  return { customType: CLI_GUIDANCE_TYPE, content, display: false };
}

function hasCliGuidance(messages: AgentMessage[], guidance: Omit<AgentMessage, "role" | "timestamp">): boolean {
  return messages.some(message => message.role === "custom" && message.customType === CLI_GUIDANCE_TYPE && textFromContent(message.content) === guidance.content);
}

function configuredPathMode(config: ConfigFile): PathMode {
  return config.pathMode ?? DEFAULT_PATH_MODE;
}

function hashPath(path: string): string {
  return `sha256:${createHash("sha256").update(resolve(path)).digest("hex").slice(0, 16)}`;
}

function formatPathForPayload(path: string, config: ConfigFile): string {
  const absolute = resolve(path);
  const mode = configuredPathMode(config);
  if (mode === "absolute") return absolute;
  if (mode === "basename") return basename(absolute);
  if (mode === "hash") return hashPath(absolute);
  const home = homeDir();
  return absolute === home ? "~" : absolute.startsWith(`${home}/`) ? `~/${absolute.slice(home.length + 1)}` : absolute;
}

function recordDetail(injection: ContextInjection, config: ConfigFile): Record<string, unknown> {
  return {
    kind: recordKind(injection.record),
    identity: recordIdentity(injection.record),
    loaded: true,
    ...({
      sourceId: (injection.record as SkillRecord).sourceId,
      recordId: injection.record.id,
      snapshotId: (injection.record as SkillRecord).snapshotId,
      versionId: (injection.record as SkillRecord).versionId,
      freshness: (injection.record as SkillRecord).freshness,
      token: recordToken(injection.record),
    }),
    name: recordName(injection.record),
    path: formatPathForPayload(recordPath(injection.record), config),
    query: injection.query,
    ruleIds: injection.ruleIds,
  };
}

function renderRouterPolicy(router: RouterDiscoveryRecord): string[] {
  const policy = router.policy;
  if (!policy) return [];
  return [
    `<policy${policy.memberBody ? ` memberBody="${escapeAttribute(String(policy.memberBody))}"` : ""}${policy.scope ? ` scope="${escapeAttribute(String(policy.scope))}"` : ""}>`,
    ...(Array.isArray(policy.prerequisites) && policy.prerequisites.length > 0 ? [
      "<prerequisites>",
      ...policy.prerequisites.map((member) => `<member>${escapeText(String(member))}</member>`),
      "</prerequisites>",
    ] : []),
    ...(Array.isArray(policy.fallback) && policy.fallback.length > 0 ? [
      "<fallback>",
      ...policy.fallback.map((member) => `<member>${escapeText(String(member))}</member>`),
      "</fallback>",
    ] : []),
    "</policy>",
  ];
}

function renderRouterRecord(injection: ContextInjection, config: ConfigFile): string[] {
  const router = injection.record as RouterDiscoveryRecord;
  if (router.sourceId) return renderSkillRecord(injection, config, {});
  const defaultRules = [
    "This is a context router index, not a concrete skill.",
    "Select the needed member by name/description before acting.",
    "Read the selected member SKILL.md before using that member capability.",
    "Member descriptions are routing metadata, not full operating instructions.",
  ];
  const rules = router.render?.rules && router.render.rules.length > 0 ? router.render.rules : defaultRules;
  return [
    `<!-- context-broker:${recordKind(router)}:${router.normalizedName}:${formatPathForPayload(router.path, config)} -->`,
    `<context-broker-record kind="router" name="${escapeAttribute(router.name)}" path="${escapeAttribute(formatPathForPayload(router.path, config))}">`,
    `<description>${escapeText(router.description)}</description>`,
    "<rules>",
    ...rules.map((rule) => `<rule>${escapeText(rule)}</rule>`),
    "</rules>",
    ...renderRouterPolicy(router),
    "<members>",
    ...(router.members ?? []).map((member) => member.type === "remote"
      ? `<member name="${escapeAttribute(member.name)}" source="${escapeAttribute(member.source.namespace)}" id="${escapeAttribute(member.id ?? "")}" ref="${escapeAttribute(member.ref ?? "")}"${member.unavailable ? ` unavailable="${escapeAttribute(member.unavailable.code)}" reason="${escapeAttribute(member.unavailable.message)}"` : ""}>${escapeText(member.description ?? "")}</member>`
      : `<member name="${escapeAttribute(member.name)}" path="${escapeAttribute(formatPathForPayload(member.path, config))}"${member.unavailable ? ` unavailable="${escapeAttribute(member.unavailable.code)}" reason="${escapeAttribute(member.unavailable.message)}"` : ""}>${escapeText(member.description ?? "")}</member>`),
    "</members>",
    "</context-broker-record>",
  ];
}

function renderSkillRecord(injection: ContextInjection, config: ConfigFile, presentation: Pick<HostCapabilities, "skillInstructions">): string[] {
  const skill = injection.record as SkillRecord;
  if (typeof skill.body !== "string") throw new Error(`context-broker: skill ${recordToken(skill)} has not been loaded`);
  return [
    `<!-- context-broker:${recordKind(skill)}:${skill.normalizedName}:${formatPathForPayload(skill.path, config)} -->`,
    `<context-broker-record kind="${recordKind(skill)}" name="${escapeAttribute(skill.name)}" path="${escapeAttribute(formatPathForPayload(skill.path, config))}">`,
    ...(skill.sourceId && skill.ref && skill.snapshotId ? [
      `<skill-ref>${escapeText(`${skill.ref}?snapshot=${skill.snapshotId}`)}</skill-ref>`,
      `<snapshot-id>${escapeText(skill.snapshotId)}</snapshot-id>`,
    ] : []),
    ...((recordKind(skill) === "skill" ? presentation.skillInstructions?.(skill, {
      query: injection.query,
      directory: formatPathForPayload(dirname(skill.path), config),
      directoryRedacted: configuredPathMode(config) === "hash" || configuredPathMode(config) === "basename",
    }) : []) ?? []),
    "<body>",
    escapeText(skill.body),
    "</body>",
    "</context-broker-record>",
  ];
}

function buildInjectedPayloadFromInjections(injections: ContextInjection[], config: ConfigFile = {}, presentation: Pick<HostCapabilities, "skillInstructions"> = {}, unavailable: UnavailableReference[] = []): Omit<AgentMessage, "role" | "timestamp"> {
  const records = injections.map((injection) => recordDetail(injection, config));
  return {
    customType: CUSTOM_TYPE,
    content: [...injections.flatMap((injection) => recordKind(injection.record) === "router" ? renderRouterRecord(injection, config) : renderSkillRecord(injection, config, presentation)), renderUnavailableReferences(unavailable)].filter(Boolean).join("\n"),
    display: false,
    details: {
      ...(records.length === 1 ? records[0] : {}),
      records,
      ...(unavailable.length ? { unavailable: unavailableReferenceDetails(unavailable) } : {}),
      injectedBy: CUSTOM_TYPE,
      version: 3,
    },
  };
}

function buildInjectedPayload(skill: SkillRecord, query: string, config: ConfigFile = {}, presentation: Pick<HostCapabilities, "skillInstructions"> = {}): Omit<AgentMessage, "role" | "timestamp"> {
  return buildInjectedPayloadFromInjections([{ record: skill, query, ruleIds: [] }], config, presentation);
}

function buildInjectedContextMessageFromInjections(injections: ContextInjection[], config: ConfigFile = {}, presentation: Pick<HostCapabilities, "skillInstructions"> = {}, unavailable: UnavailableReference[] = []): AgentMessage {
  return {
    role: "custom",
    ...buildInjectedPayloadFromInjections(injections, config, presentation, unavailable),
    timestamp: Date.now(),
  };
}

function buildInjectedContextMessage(skill: SkillRecord, query: string, config: ConfigFile = {}, presentation: Pick<HostCapabilities, "skillInstructions"> = {}): AgentMessage {
  return buildInjectedContextMessageFromInjections([{ record: skill, query, ruleIds: [] }], config, presentation);
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function logRecord(record: DiscoveryRecord, config: ConfigFile): Record<string, unknown> {
  return {
    kind: recordKind(record),
    name: recordName(record),
    ...(config.logPaths === true ? { path: formatPathForPayload(recordPath(record), config) } : {}),
  };
}

function logDecision(decision: MatchDecision | { decision: "skip"; reason: string }, extra: Record<string, unknown> = {}, config: ConfigFile = {}): void {
  const logFile = process.env.CONTEXT_BROKER_LOG_FILE;
  if (!logFile) return;
  try {
    appendFileSync(logFile, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      decision: decision.decision,
      reason: decision.reason,
      query: "query" in decision ? decision.query : undefined,
      record: "record" in decision ? logRecord(decision.record, config) : undefined,
      candidates: "candidates" in decision ? decision.candidates?.map((record) => logRecord(record, config)) : undefined,
      ...extra,
    })}\n`);
  } catch {
    // Debug logging must never affect prompt execution.
  }
}

function logInjection(injections: ContextInjection[], extra: Record<string, unknown> = {}, config: ConfigFile = {}): void {
  const logFile = process.env.CONTEXT_BROKER_LOG_FILE;
  if (!logFile || injections.length === 0) return;
  try {
    appendFileSync(logFile, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      decision: "inject",
      reason: "matched",
      query: injections.map((injection) => injection.query).join(", "),
      record: logRecord(injections[0].record, config),
      records: injections.map((injection) => ({
        ...logRecord(injection.record, config),
        query: injection.query,
        ruleIds: injection.ruleIds,
      })),
      ...extra,
    })}\n`);
  } catch {
    // Debug logging must never affect prompt execution.
  }
}

function notifyInjectedSkill(ctx: ExtensionContext, skill: SkillRecord): void {
  notifyInjectedRecords(ctx, [skill]);
}

function notifyInjectedRecords(ctx: ExtensionContext, records: DiscoveryRecord[], alreadyLoaded: DiscoveryRecord[] = []): void {
  if (!ctx.hasUI) return;
  records = records.filter((record) => !(recordKind(record) === "skill" && (record as SkillRecord).sourceId));
  alreadyLoaded = alreadyLoaded.filter((record) => !(recordKind(record) === "skill" && (record as SkillRecord).sourceId));
  const parts = [];
  if (records.length > 0) parts.push(`injected ${records.map((record) => recordName(record)).join(", ")}`);
  if (alreadyLoaded.length > 0) parts.push(`already loaded ${alreadyLoaded.map((record) => recordName(record)).join(", ")}`);
  if (parts.length === 0) return;
  try {
    ctx.ui?.notify?.(`context-broker: ${parts.join("; ")}`, "info");
  } catch {
    // UI notifications must never affect prompt execution.
  }
}

function notifyInjectedSkills(ctx: ExtensionContext, skills: SkillRecord[], alreadyLoaded: SkillRecord[] = []): void {
  notifyInjectedRecords(ctx, skills, alreadyLoaded);
}

async function loadAvailableInjections(injections: ContextInjection[], load: (record: SkillRecord) => Promise<SkillRecord>): Promise<{ loaded: ContextInjection[]; unavailable: ContextInjection[] }> {
  const loaded: ContextInjection[] = [];
  const unavailable: ContextInjection[] = [];
  for (const injection of injections) {
    try {
      const record = injection.record.sourceId || recordKind(injection.record) !== "router" ? await load(injection.record) : injection.record;
      loaded.push({ ...injection, record });
    } catch (error) {
      if (!(error instanceof ReferenceMiss)) throw error;
      unavailable.push(injection);
    }
  }
  return { loaded, unavailable };
}

function unavailableInCurrentSubmission(messages: AgentMessage[], selection: UnavailableReference): boolean {
  const start = messages.findLastIndex(message => message.role === "user") + 1;
  return messages.slice(start).some(message => {
    if (message.role !== "custom" || message.customType !== CUSTOM_TYPE || !isRecord(message.details)) return false;
    const details = message.details.unavailable;
    return Array.isArray(details) && details.some(item => isRecord(item) && item.state === "not-loaded"
      && (selection.record ? item.identity === recordIdentity(selection.record) : item.query === selection.query));
  });
}

async function invokeForContext(
  event: ContextEvent,
  registryPromise: Promise<SkillRecord[]>,
  config: ConfigFile,
  dollarRegistryPromise: Promise<DiscoveryRecord[]> = Promise.resolve([]),
): Promise<ContextResult | undefined> {
  const prompt = latestUserText(event.messages);
  if (!prompt) return undefined;
  const requests = parseInvocations(prompt, configuredRules(config));
  if (requests.length === 0) return undefined;
  const registry = await registryPromise;
  const dollarRegistry = requests.some((request) => request.scope === "global" || request.scope === "catalog") ? await dollarRegistryPromise : [];
  const resolved = resolveSkillRequests(requests, registry, {}, dollarRegistry, config);
  const injections = resolved.injections.filter(injection => !unavailableInCurrentSubmission(event.messages, injection));
  const unresolved = resolved.unavailable.filter(selection => !unavailableInCurrentSubmission(event.messages, selection));
  const unloaded = injections.filter((injection) => {
    if (!hasLoadedRecord(event.messages, injection.record)) return true;
    logDecision(
      { decision: "skip", reason: "already-loaded", query: injection.query, candidates: [injection.record] },
      { ruleIds: injection.ruleIds },
      config,
    );
    return false;
  });
  if (unloaded.length === 0 && unresolved.length === 0) return undefined;
  const { loaded, unavailable: missing } = await loadAvailableInjections(unloaded, record => loadSourceSkill(record, config));
  const unavailable: UnavailableReference[] = [...missing, ...unresolved];
  if (!loaded.length && !unavailable.length) return undefined;
  const tasks = loaded.filter(injection => recordKind(injection.record) === "prompt");
  const messages = event.messages.slice();
  if (tasks.length) {
    const last = messages.findLastIndex(message => message.role === "user");
    const original = messages[last]!;
    const text = tasks.map(injection => injection.record.body ?? "").join("\n\n");
    const content = typeof original.content === "string" ? original.content + "\n\n" + text : [...(original.content ?? []), { type: "text" as const, text }];
    messages[last] = { ...original, content };
  }
  const context = loaded.filter(injection => recordKind(injection.record) !== "prompt");
  if (context.length || unavailable.length) messages.push(buildInjectedContextMessageFromInjections(context, config, {}, unavailable));
  logInjection(loaded, { action: "inject" }, config);
  return { messages };
}

async function invokeBeforeAgentStart(
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
  registryPromise: Promise<SkillRecord[]>,
  config: ConfigFile,
  dollarRegistryPromise: Promise<DiscoveryRecord[]> = Promise.resolve([]),
  loadRecord: (record: SkillRecord) => Promise<SkillRecord> = record => loadSourceSkill(record, config, ctx.cwd),
  isLoaded: (messages: AgentMessage[], record: DiscoveryRecord) => boolean = hasLoadedRecord,
  presentation: Pick<HostCapabilities, "skillInstructions"> = {},
  accepted: ReadonlyMap<string, DiscoveryRecord> = new Map(),
): Promise<BeforeAgentStartResult | undefined> {
  const requests = parseInvocations(event.prompt, configuredRules(config));
  if (requests.length === 0) return undefined;
  const registry = await registryPromise;
  const dollarRegistry = requests.some((request) => request.scope === "global" || request.scope === "catalog")
    ? await buildDollarRegistryForContext(ctx, dollarRegistryPromise)
    : [];
  const resolved = resolveSkillRequests(requests, registry, { phase: "before_agent_start" }, dollarRegistry, config, accepted);
  const injections = resolved.injections.filter(injection => recordKind(injection.record) !== "prompt");
  const sessionMessages = messagesFromActiveSessionContext(ctx);
  const alreadyLoaded: ContextInjection[] = [];
  const unloaded = injections.filter((injection) => {
    if (!isLoaded(sessionMessages, injection.record)) return true;
    alreadyLoaded.push(injection);
    logDecision(
      { decision: "skip", reason: "already-loaded", query: injection.query, candidates: [injection.record] },
      { ruleIds: injection.ruleIds, phase: "before_agent_start" },
      config,
    );
    return false;
  });
  if (unloaded.length === 0 && resolved.unavailable.length === 0) {
    notifyInjectedRecords(ctx, [], alreadyLoaded.map((injection) => injection.record));
    return undefined;
  }
  const { loaded, unavailable: missing } = await loadAvailableInjections(unloaded, loadRecord);
  const unavailable: UnavailableReference[] = [...missing, ...resolved.unavailable];
  if (!loaded.length && !unavailable.length) return undefined;
  notifyUnavailableReferences(ctx, unavailable);
  const message = buildInjectedPayloadFromInjections(loaded, config, presentation, unavailable);
  logInjection(loaded, { phase: "before_agent_start", action: "inject" }, config);
  notifyInjectedRecords(
    ctx,
    loaded.map((injection) => injection.record),
    alreadyLoaded.map((injection) => injection.record),
  );
  return { message };
}

function contextBrokerCommandCompletions(argumentPrefix: string) {
  const commands = [
    { value: "status", label: "status", description: "Show loaded discovery record summary" },
    { value: "doctor", label: "doctor", description: "Diagnose config, catalogs, names, aliases, and routers" },
    { value: "refresh", label: "refresh", description: "Refresh metadata and prepare default source snapshots in background" },
    { value: "sources", label: "sources", description: "Show local source preparation state and freshness" },
    { value: "views", label: "views", description: "List Notion Views in API order with exact selection commands" },
    { value: "view", label: "view", description: "Show current View or select [source-id] <view-id|URL|default> for this session" },
    { value: "roots", label: "roots", description: "Show skill roots" },
    { value: "catalogs", label: "catalogs", description: "Show discovery catalogs" },
    { value: "find ", label: "find", description: "Explain lookup for a query" },
    { value: "explain ", label: "explain", description: "Show resolved record and injection strategy" },
  ];
  const prefix = argumentPrefix.trimStart();
  return commands.filter((command) => command.value.startsWith(prefix) || command.label.startsWith(prefix));
}

function formatCatalogs(config: ConfigFile, cwd = process.cwd()): string {
  const catalogs = configuredDiscoveryCatalogs(config, cwd);
  if (catalogs.length === 0) return "context-broker catalogs: none";
  return [
    `context-broker catalogs: ${catalogs.length}`,
    ...catalogs.map((catalog) => `${existsSync(catalog) ? "ok" : "missing"} ${catalog}`),
  ].join("\n");
}

async function formatContextBrokerDoctor(config: ConfigFile, cwd = process.cwd(), paths: HostPathOptions = {}): Promise<string> {
  const roots = discoverUsableSkillRoots(config, cwd);
  const catalogs = configuredDiscoveryCatalogs(config, cwd);
  const { records: rawRegistry, failures } = await buildRawDollarRegistry(config, cwd, paths);
  const errors = validateDiscoveryRecords(rawRegistry);
  const diagnostics = collectConfigDiagnostics(paths);
  const sourceHealth: string[] = [];
  diagnostics.push(...formatSourceFailures(failures));
  for (const source of normalizeSources(config.sources) ?? []) {
    if (source.enabled === false || source.type !== "notion" || source.command || failures.some(failure => failure.sourceId === source.id)) continue;
    try {
      const health = await diagnoseNotionSource(source, cwd);
      sourceHealth.push(`Source ${source.id}: ntn ${health.version}, authentication available`);
    } catch (error) {
      const code = error instanceof SourceError ? error.code : "SOURCE_DIAGNOSTIC_FAILED";
      diagnostics.push(`Source ${source.id}: unavailable (${code}). ${sourceFailureMessage(code)}`);
    }
  }
  const routers = rawRegistry.filter((record) => recordKind(record) === "router");
  const skills = rawRegistry.filter((record) => recordKind(record) === "skill");
  for (const catalog of catalogs) {
    try {
      readDiscoveryCatalog(catalog, skills.filter(skill => skill.source !== "notion"), scanOptions(config), { sources: config.sources, records: rawRegistry.filter(record => record.source === "notion"), failures });
    } catch (error) {
      diagnostics.push(`catalog read failed: ${catalog}: ${errorMessage(error)}`);
    }
  }
  return [
    "Context Broker Doctor",
    "",
    `Config: ${resolveConfigPath(paths) ?? "none"}`,
    `Path mode: ${configuredPathMode(config)}`,
    `Log paths: ${config.logPaths === true ? "enabled" : "disabled"}`,
    `Scan: maxDepth=${config.scan?.maxDepth ?? 8}, maxSkillBytes=${config.scan?.maxSkillBytes ?? 65536}`,
    `Skill roots: ${roots.length}`,
    `Discovery catalogs: ${catalogs.length}`,
    ...catalogs.map((catalog) => `  ${existsSync(catalog) ? "ok" : "missing"} ${catalog}`),
    `Records: ${skills.length} skills, ${routers.length} routers`,
    diagnostics.length === 0 ? "Config diagnostics: ok" : "Config diagnostics: failed",
    ...diagnostics.map((diagnostic) => `  fail ${diagnostic}`),
    ...sourceHealth,
    errors.length === 0 ? "Namespace: ok no discovery namespace collisions" : "Namespace: failed",
    ...errors.map((error) => `  fail ${error}`),
    "Routers:",
    ...(routers.length > 0 ? routers.map((record) => `  ${recordName(record)}: ${(record as any).members?.length ?? 0} members`) : ["  none"]),
  ].join("\n");
}

function formatExplainRecord(record: DiscoveryRecord): string {
  if (recordKind(record) === "router") {
    const router = record as RouterDiscoveryRecord;
    return [
      `record: ${router.name}`,
      `select: $${recordToken(router)}`,
      "kind: router",
      "inject: member-index",
      `members: ${(router.members?.length ?? 0)}`,
      `path: ${router.path}`,
      router.description ? `description: ${router.description}` : undefined,
    ].filter(Boolean).join("\n");
  }
  return [
    `record: ${recordName(record)}`,
    `select: $${recordToken(record)}`,
    "kind: skill",
    "inject: full-file",
    `path: ${recordPath(record)}`,
    recordDescription(record) ? `description: ${recordDescription(record)}` : undefined,
  ].filter(Boolean).join("\n");
}

async function dispatchContextBrokerCommand(args: string, ctx: ExtensionContext, config: ConfigFile, getDollarRegistry: (cwd?: string) => Promise<DiscoveryRecord[]>, registryPromise: Promise<SkillRecord[]>, refresh: (ctx: ExtensionContext) => Promise<void>, paths: HostPathOptions): Promise<void> {
  const [command = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
  if (command === "refresh" && refresh) {
    await refresh(ctx);
    return;
  }
  if (command === "roots") {
    const roots = discoverUsableSkillRoots(config, ctx.cwd);
    ctx.ui?.notify?.(formatRootDiagnostics(await collectRootDiagnostics(roots)), "info");
    return;
  }
  if (command === "catalogs") {
    ctx.ui?.notify?.(formatCatalogs(config, ctx.cwd), "info");
    return;
  }
  if (command === "doctor") {
    ctx.ui?.notify?.(await formatContextBrokerDoctor(config, ctx.cwd, paths), "info");
    return;
  }
  if (command === "find") {
    const query = rest.join(" ");
    const registry = await buildDollarRegistryForContext(ctx, getDollarRegistry(ctx.cwd));
    const { records: rawRegistry } = await buildRawDollarRegistry(config, ctx.cwd, paths);
    ctx.ui?.notify?.(formatFindDiagnostics(query, registry, rawRegistry), "info");
    return;
  }
  if (command === "explain") {
    const query = rest.join(" ");
    const registry = await buildDollarRegistryForContext(ctx, getDollarRegistry(ctx.cwd));
    const decision = matchDiscoveryRecord(query, registry, false);
    ctx.ui?.notify?.(decision.decision === "inject" ? formatExplainRecord(decision.record) : `context-broker explain: no unique record for ${query}`, decision.decision === "inject" ? "info" : "warning");
    return;
  }
  const registry = await registryPromise;
  const dollarRegistry = await getDollarRegistry(ctx.cwd);
  const routers = dollarRegistry.filter((record) => recordKind(record) === "router").length;
  ctx.ui?.notify?.(
    `context-broker status: ${registry.length} configured skills, ${dollarRegistry.length} $ records, ${routers} routers\ncommands: doctor, refresh, roots, catalogs, find <query>, explain <name>`,
    registry.length > 0 || dollarRegistry.length > 0 ? "info" : "warning",
  );
}

export default async function contextBroker(pi: ExtensionAPI): Promise<void> {
  const adapter = pi.pi !== undefined ? createOmpHostAdapter(pi) : createPiHostAdapter(pi);
  const paths = adapter.paths;
  const config = readConfig(paths);
  const acceptedSelections = createAcceptedSelections();
  for (const event of ["session_shutdown", "session_before_switch", "session_before_branch", "session_before_tree"] as const) {
    pi.on(event, (_event, ctx) => acceptedSelections.clear(ctx));
  }
  const cliGuidance = buildCliGuidance(config);
  pi.on("before_agent_start", (_event, ctx) => {
    if (!hasCliGuidance(messagesFromActiveSessionContext(ctx), cliGuidance)) return { message: cliGuidance };
    return undefined;
  });
  pi.on("context", event => {
    if (!hasCliGuidance(event.messages, cliGuidance)) {
      return { messages: [...event.messages, { ...cliGuidance, role: "custom", timestamp: Date.now() }] };
    }
    return undefined;
  });
  const sourceRuntime = createSourceRuntime((record, signal) => loadSourceSkill(record, config, process.cwd(), { signal }));
  pi.on("session_shutdown", () => sourceRuntime.dispose());
  let registryPromise = buildRegistry(config, paths);
  let refreshGeneration = 0;
  type CatalogState = { status: "pending"; promise: Promise<DiscoveryResult> }
    | { status: "ready"; promise: Promise<DiscoveryResult>; result: DiscoveryResult }
    | { status: "failed"; promise: Promise<DiscoveryResult>; error: unknown };
  const dollarRegistryByCwd = new Map<string, CatalogState>();
  const sourceChanges = new Map<string, number>();
  const observedChangesByCwd = new Map<string, Map<string, number>>();
  const notionRefresh = new Map<string, Promise<DiscoveryResult>>();
  const notionRetryAt = new Map<string, number>();
  const autocompleteUis = new WeakSet<object>();
  const catalogCwd = (cwd: string) => { try { return realpathSync(cwd); } catch { return resolve(cwd); } };
  const unseenChanges = (cwd: string) => new Map([...sourceChanges].filter(([id, version]) => (observedChangesByCwd.get(cwd)?.get(id) ?? 0) < version));
  const publishCatalog = (cwd: string, promise: Promise<DiscoveryResult>, changes = new Map<string, number>()) => {
    const entry: CatalogState = { status: "pending", promise };
    dollarRegistryByCwd.set(cwd, entry);
    void promise.then(result => {
      if (dollarRegistryByCwd.get(cwd) !== entry) return;
      const observed = observedChangesByCwd.get(cwd) ?? new Map<string, number>();
      for (const [id, version] of changes) if (!result.failures.some(failure => failure.sourceId === id)) observed.set(id, version);
      observedChangesByCwd.set(cwd, observed);
      if (changes.size && unseenChanges(cwd).size) notionRetryAt.set(cwd, Date.now() + notionCatalogRetryGapMs);
      dollarRegistryByCwd.set(cwd, { status: "ready", promise, result });
    }, error => {
      if (dollarRegistryByCwd.get(cwd) === entry) {
        if (changes.size) notionRetryAt.set(cwd, Date.now() + notionCatalogRetryGapMs);
        dollarRegistryByCwd.set(cwd, { status: "failed", promise, error });
      }
    });
    return promise;
  };
  const getCatalog = (cwd = process.cwd()) => {
    const key = catalogCwd(cwd);
    const entry = dollarRegistryByCwd.get(key);
    const changes = unseenChanges(key);
    if (entry && (entry.status === "pending" || !changes.size || Date.now() < (notionRetryAt.get(key) ?? 0))) return entry.promise;
    return publishCatalog(key, buildDiscoveryRegistry(config, key, { paths, stale: true, refreshSourceIds: [...changes.keys()] }), changes);
  };
  installCliWriteInvalidation(pi, {
    sources: config.sources ?? [],
    records: () => [...dollarRegistryByCwd.values()].flatMap(entry => entry.status === "ready"
      ? entry.result.records.filter((record): record is SkillRecord => Boolean(record.sourceId)) : []),
    changed(sourceIds, ctx) {
      // Publication generations fence old directory requests without cancelling an accepted draft.
      refreshGeneration++;
      for (const id of sourceIds) sourceChanges.set(id, refreshGeneration);
      for (const cwd of new Set([...dollarRegistryByCwd.keys(), catalogCwd(ctx.cwd ?? process.cwd())])) {
        dollarRegistryByCwd.delete(cwd);
        notionRefresh.delete(cwd);
        notionRetryAt.delete(cwd);
      }
      sourceRuntime.forgetSources(sourceIds);
    },
  });
  const getDollarRegistry = async (cwd?: string) => (await getCatalog(cwd)).records;
  const notionSources = () => (config.sources ?? []).filter((source): source is Extract<SourceConfig, { type: "notion" }> => source.type === "notion" && source.enabled !== false);
  const catalogError = (error: unknown) => error instanceof Error ? error.message : "context-broker source discovery failed";
  const dollarMenu = async (ctx: ExtensionContext): Promise<DollarMenu> => {
    const systemPrompt = ctx.getSystemPrompt?.() ?? "";
    const registryContext: ExtensionContext = { getSystemPrompt: () => systemPrompt };
    const cwd = catalogCwd(ctx.cwd ?? process.cwd());
    const pendingCatalog = getCatalog(cwd);
    const state = dollarRegistryByCwd.get(cwd)!;
    if (state.status === "failed") return { records: [], notice: catalogError(state.error) };
    if (state.status === "pending") return {
      // Source collisions can change local selection tokens; do not offer an unqualified guess.
      records: config.sources?.some(source => source.enabled !== false) ? [] : await buildDollarRegistryForContext(registryContext, registryPromise),
      notice: notionSources().length ? "Reading Notion catalog" : "Reading source catalog",
      followUp: pendingCatalog.then(async result => ({
        records: await buildDollarRegistryForContext(registryContext, Promise.resolve(result.records)),
        notice: formatSourceFailures(result.failures).join("\n") || undefined,
      })).catch(error => ({ records: [], notice: catalogError(error) })),
    };
    const current = state.result;
    const records = await buildDollarRegistryForContext(registryContext, Promise.resolve(current.records));
    const sources = notionSources();
    const sourceIds = sources.map((source) => source.id);
    const offline = sources.length > 0 && sources.every((source) => source.discovery?.offline);
    const action = notionCatalogAction({
      offline,
      sourceIds,
      observations: current.lists ?? [],
      failedSourceIds: current.failures.map((failure) => failure.sourceId),
      now: Date.now(),
      retryAt: notionRetryAt.get(cwd),
    });
    const failureNotice = formatSourceFailures(current.failures.filter((failure) => sourceIds.includes(failure.sourceId))).join("\n");
    if (action !== "refresh") return { records, notice: action === "wait" && failureNotice ? failureNotice : undefined };
    let pending = notionRefresh.get(cwd);
    if (!pending) {
      const generation = refreshGeneration;
      const changes = unseenChanges(cwd);
      pending = (async () => {
        try {
          const next = await buildDiscoveryRegistry(config, cwd, { paths, refreshSourceIds: [...changes.keys()] });
          if (generation !== refreshGeneration) return await getCatalog(cwd);
          const failed = next.failures.some((failure) => failure.blocking !== false && sourceIds.includes(failure.sourceId));
          const unsafe = next.failures.some(failure => sourceIds.includes(failure.sourceId) && ["AUTH_REQUIRED", "ACCESS_DENIED", "CACHE_SCOPE_UNAVAILABLE", "SOURCE_IDENTITY_MISMATCH"].includes(failure.code));
          const published = failed && !unsafe && current.records.some((record) => record.source === "notion")
            ? { records: current.records, failures: next.failures, lists: current.lists }
            : next;
          const stillStale = notionCatalogAction({
            offline: false,
            sourceIds,
            observations: published.lists ?? [],
            failedSourceIds: published.failures.map((failure) => failure.sourceId),
            now: Date.now(),
          }) === "refresh";
          if (failed || stillStale) notionRetryAt.set(cwd, Date.now() + notionCatalogRetryGapMs);
          else notionRetryAt.delete(cwd);
          publishCatalog(cwd, Promise.resolve(published), changes);
          return published;
        } finally {
          if (notionRefresh.get(cwd) === pending) notionRefresh.delete(cwd);
        }
      })();
      notionRefresh.set(cwd, pending);
    }
    const hasNotion = current.records.some((record) => record.source === "notion");
    return {
      records,
      notice: hasNotion ? "Updating Notion catalog" : failureNotice || "Reading Notion catalog",
      followUp: pending.then(async (next) => ({
        records: await buildDollarRegistryForContext(registryContext, Promise.resolve(next.records)),
        notice: formatSourceFailures(next.failures.filter((failure) => sourceIds.includes(failure.sourceId))).join("\n") || undefined,
      })).catch(error => ({ records, notice: catalogError(error) })),
    };
  };
  let menuContext: ExtensionContext | undefined;
  let menuGeneration = 0;
  const retireMenuContext = () => { menuGeneration++; menuContext = undefined; };
  pi.on("session_shutdown", retireMenuContext);
  for (const event of ["session_switch", "session_branch", "session_tree"] as const) pi.on(event, (_event, ctx) => { menuGeneration++; menuContext = ctx; });
  pi.on("session_start", (_event, ctx) => {
    const generation = ++menuGeneration;
    menuContext = ctx;
    const ui = ctx.ui;
    if (ui?.addAutocompleteProvider && !autocompleteUis.has(ui)) {
      ui.addAutocompleteProvider((current) => createDollarSkillAutocompleteProvider(current, () => menuContext ? dollarMenu(menuContext) : Promise.resolve({ records: [] }), record => { if (menuContext) acceptedSelections.remember(menuContext, record); }));
      autocompleteUis.add(ui);
    }
    // The editor and provider become usable while the owned catalog request continues.
    void getCatalog(ctx.cwd).then(async ({ failures }) => {
      if (generation !== menuGeneration) return;
      for (const message of formatSourceFailures(failures)) ui?.notify?.(message, "warning");
      const menu = await dollarMenu(ctx);
      await menu.followUp;
    }).catch(error => { if (generation === menuGeneration) ui?.notify?.(catalogError(error), "error"); });
  });
  const host = await installHostSkills(pi, {
    config,
    getRecords: async (ctx, signal) => {
      const result = await getCatalog(ctx?.cwd);
      return resolveViewDiscovery(config, { records: result.records.filter((record): record is SkillRecord => Boolean(record.sourceId)), failures: result.failures }, ctx, signal);
    },
    loadRecord: (record, signal) => sourceRuntime.load(record, signal),
    isLoaded: (record, ctx) => hasLoadedRecord(messagesFromActiveSessionContext(ctx), record),
    onMetadata: records => sourceRuntime.prepare(records.filter(record => recordKind(record) !== "prompt" && record.defaultDiscovery === true && config.sources?.some(source => source.id === record.sourceId && source.type === "notion"))),
    needsPreflightPrompt: text => parseInvocations(text, configuredRules(config)).length > 0,
    onPreparation: entry => acceptedSelections.capture(entry.ctx, entry.controller.signal,
      parseInvocations(entry.event.text ?? "", configuredRules(config)).filter(request => request.scope === "global").map(request => request.query)),
    taskPrompt: async (text, ctx, signal, invocation) => {
      const requests = parseInvocations(text, configuredRules(config));
      const { injections } = resolveSkillRequests(requests, await registryPromise, {}, await buildDollarRegistryForContext(ctx, getDollarRegistry(ctx.cwd)), config, acceptedSelections.forSubmission(signal));
      const tasks: string[] = [];
      for (const injection of injections) {
        if (recordKind(injection.record) !== "prompt") continue;
        const prepared = await host.prepare(injection.record, ctx, signal);
        if (prepared.status === "miss") {
          notifyUnavailableReferences(ctx, [injection]);
          tasks.push(renderUnavailableReferences([injection]));
          continue;
        }
        const record = prepared.record;
        tasks.push(`<prompt-task invocation="${escapeAttribute(invocation?.id ?? "")}" session="${escapeAttribute(invocation?.sessionId ?? "")}" generation="${invocation?.generation ?? 0}" identity="${escapeAttribute(recordIdentity(record))}" snapshot="${escapeAttribute(record.snapshotId ?? "")}" version="${escapeAttribute(record.versionId ?? "")}">\n${record.body}\n</prompt-task>`);
      }
      return tasks.length ? text + "\n\n" + tasks.join("\n\n") : text;
    },
    preflightPrompt: async (text, ctx, signal) => {
      const requests = parseInvocations(text, configuredRules(config));
      if (requests.length === 0) return;
      const registry = await registryPromise;
      const dollarRegistry = requests.some(request => request.scope === "global" || request.scope === "catalog")
        ? await buildDollarRegistryForContext(ctx, getDollarRegistry(ctx.cwd)) : [];
      const { injections } = resolveSkillRequests(requests, registry, { phase: "input" }, dollarRegistry, config, acceptedSelections.forSubmission(signal));
      for (const injection of injections) {
        if (signal?.aborted) throw Object.assign(new Error("Skill preparation cancelled"), { code: "SOURCE_ACTIVATION_CANCELLED" });
        if (injection.record.sourceId) await host.prepare(injection.record, ctx, signal);
      }
    },
  }, adapter);
  const refresh = async (ctx: ExtensionContext) => {
    const selectedGeneration = ++refreshGeneration;
    host.invalidate();
    sourceRuntime.invalidate();
    registryPromise = buildRegistry(config, paths);
    const result = await buildDiscoveryRegistry(config, ctx.cwd, { refresh: true, paths });
    if (selectedGeneration !== refreshGeneration) return;
    dollarRegistryByCwd.clear();
    notionRetryAt.delete(catalogCwd(ctx.cwd ?? process.cwd()));
    publishCatalog(catalogCwd(ctx.cwd ?? process.cwd()), Promise.resolve(result), new Map(sourceChanges));
    await host.refresh(ctx);
  };
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const result = await host.withPreparedPrompt(event.prompt, ctx, async (signal, native, original) => {
        if (original === undefined) return undefined;
        const submission = { ...event, prompt: original ?? event.prompt };
        if (!parseInvocations(submission.prompt, configuredRules(config)).length) return undefined;
        return invokeBeforeAgentStart(
          submission, ctx, registryPromise, config, getDollarRegistry(ctx.cwd),
          async record => {
            if (!record.sourceId) return loadSourceSkill(record, config, ctx.cwd, { signal });
            const prepared = await host.prepare(record, ctx, signal);
            if (prepared.status === "miss") throw new ReferenceMiss(record.sourceId);
            return prepared.record;
          },
          (messages, record) => hasLoadedRecord(messages, record) || (recordKind(record) === "skill" && (
            (native !== undefined && recordIdentity(native) === recordIdentity(record)) || host.isNativeLoaded(messages, record as SkillRecord)
          )),
          adapter,
          acceptedSelections.forSubmission(signal),
        );
      });
      return result;
    } catch (error) {
      ctx.ui?.notify?.(error instanceof Error ? error.message : "Skill preparation failed.", "error");
      return undefined;
    }
  });
  const viewCommand = createViewCommands(pi, config, ctx => host.refresh(ctx), () => host.viewStatus());
  const command = {
    description: "Inspect context-broker discovery records, routers, catalogs, and config health",
    getArgumentCompletions: contextBrokerCommandCompletions,
    handler: async (args: string, ctx: ExtensionContext) => {
      if (await viewCommand(args, ctx)) return;
      if (args.trim() === "sources") {
        ctx.ui?.notify?.(`context-broker sources: ${JSON.stringify({ prefetch: sourceRuntime.diagnostics() })}`, "info");
        return;
      }
      return dispatchContextBrokerCommand(args, ctx, config, getDollarRegistry, registryPromise, refresh, paths);
    },
  };
  pi.registerCommand?.("context-broker", command);

}

export {
  CUSTOM_TYPE,
  BUILTIN_SKILL_PROMPT_TYPE,
  buildInjectedContextMessage,
  buildInjectedPayload,
  buildCliGuidance,
  buildDiscoveryRegistry,
  buildDollarRegistry,
  buildRawDollarRegistry,
  buildRegistry,
  buildRegistryFromSystemPrompt,
  createDollarSkillAutocompleteProvider,
  defaultAgentDir,
  defaultAgentDirs,
  discoverUsableSkillRoots,
  defaultConfigPath,
  discoveryAutocompleteItems,
  dollarAutocompleteItems,
  extractDollarAutocompletePrefix,
  hasLoadedSkill,
  homeDir,
  invokeBeforeAgentStart,
  invokeForContext,
  matchDiscoveryRecord,
  matchSkill,
  messagesFromSessionEntries,
  normalizeKey,
  normalizeRuleConfigFile,
  notifyInjectedSkill,
  parseConfigFile,
  readDiscoveryCatalog,
  parseInvocation,
  parseInvocations,
  readConfig,
  resolveConfigPath,
  resolveConfigPaths,
  configuredRules,
  ruleRootsForConfig,
  listRuleConfigFiles,
};

export { parseCatalogMember, resolveCatalogReference, CatalogReferenceError } from "./discovery-records";
export type { RawCatalogMember, CatalogRemoteReference, CatalogResolutionContext } from "./types";
