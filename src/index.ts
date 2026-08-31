import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  buildDollarRegistryForContext,
  buildRegistryFromSystemPrompt,
  createDollarSkillAutocompleteProvider,
  discoveryAutocompleteItems,
  dollarAutocompleteItems,
  extractDollarAutocompletePrefix,
  scoreDollarSuggestion,
} from "./dollar";
import {
  buildRegistryFromRoots,
  normalizeKey,
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
} from "./discovery-records";
import {
  collectRootDiagnostics,
  formatFindDiagnostics,
  formatRootDiagnostics,
} from "./diagnostics";
import {
  GENERATED_BUNDLE_OWNER,
  materializeGeneratedBundleSkills,
} from "./generated-bundle-skills";
import { installPiDollarAutocompleteEditor } from "./pi-dollar-editor";
import type {
  AgentMessage,
  BeforeAgentStartEvent,
  BeforeAgentStartResult,
  BundleSkillExposureConfig,
  ConfigFile,
  ContextEvent,
  ContextInjection,
  ContextResult,
  DiscoveryRecord,
  ExtensionAPI,
  ExtensionContext,
  InvocationRule,
  MatchDecision,
  MatchPredicate,
  MessageContent,
  PathMode,
  RegexPattern,
  ScanConfig,
  SessionEntry,
  SkillRecord,
  SkillRequest,
  TextContent,
} from "./types";

const CUSTOM_TYPE = "context-broker";
const BUILTIN_SKILL_PROMPT_TYPE = "skill-prompt";
const CONFIG_DIR_BASENAME = "context-broker";
const DEFAULT_CONFIG_FILE_BASENAME = "config";
const DEFAULT_CONFIG_EXTENSIONS = [".yml", ".yaml", ".json"];
const DEFAULT_RULE_ROOT_BASENAME = "rules";
const GENERATED_SKILL_ROOT_BASENAME = "generated-skills";
const RULE_FILE_EXTENSIONS = new Set(DEFAULT_CONFIG_EXTENSIONS);
const DEFAULT_PATH_MODE: PathMode = "home-relative";
const DOLLAR_SKILL_PATTERN = "(?:^|[\\s,，。.!！？?；;、:：([{（【])\\$(?<query>[^\\s$]+?)(?=$|[\\s,，。.!！？?；;、:：)）\\]】}])";
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

type HostName = "pi" | "omp";

function detectHost(): HostName | undefined {
  const override = process.env.CONTEXT_BROKER_HOST?.trim().toLowerCase();
  if (override === "pi" || override === "omp") return override;
  const argv = [process.execPath, ...process.argv].map((part) => basename(part).toLowerCase());
  if (argv.some((part) => part === "omp" || part.includes("oh-my-pi"))) return "omp";
  if (argv.some((part) => part === "pi" || part.includes("earendil-works"))) return "pi";
  if (process.env.PI_CONFIG_DIR) return "omp";
  return undefined;
}

function defaultAgentDir(): string | undefined {
  return defaultAgentDirs()[0];
}

function defaultAgentDirs(): string[] {
  const envAgentDir = process.env.PI_CODING_AGENT_DIR;
  if (envAgentDir) return [expandPath(envAgentDir)];
  const host = detectHost();
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

function defaultConfigPath(): string | undefined {
  const agentDirs = defaultAgentDirs();
  for (const agentDir of agentDirs) {
    const path = firstExistingConfigPath(agentDir);
    if (path) return path;
  }
  const agentDir = agentDirs[0];
  return agentDir ? join(agentDir, CONFIG_DIR_BASENAME, `${DEFAULT_CONFIG_FILE_BASENAME}${DEFAULT_CONFIG_EXTENSIONS[0]}`) : undefined;
}

function resolveConfigPaths(): string[] {
  const explicit = process.env.CONTEXT_BROKER_CONFIG;
  if (explicit) return [expandPath(explicit)];
  const paths = defaultAgentDirs()
    .map(firstExistingConfigPath)
    .filter((path): path is string => path !== undefined);
  return uniqueStrings(paths);
}

function resolveConfigPath(): string | undefined {
  const explicit = process.env.CONTEXT_BROKER_CONFIG;
  if (explicit) return expandPath(explicit);
  return resolveConfigPaths()[0];
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
  const exposeBundlesAsSkillsValues = configs
    .map((config) => config.exposeBundlesAsSkills)
    .filter((value): value is boolean | BundleSkillExposureConfig => value !== undefined);
  const pathModes = configs.map((config) => config.pathMode).filter((value): value is PathMode => Boolean(value));
  const logPathValues = configs.map((config) => config.logPaths).filter((value): value is boolean => typeof value === "boolean");
  return {
    skillRoots: uniqueStrings(configs.flatMap((config) => config.skillRoots ?? [])),
    extraSkillRoots: uniqueStrings(configs.flatMap((config) => config.extraSkillRoots ?? [])),
    ruleRoots: uniqueStrings(configs.flatMap((config) => config.ruleRoots ?? [])),
    discoveryCatalogs: uniqueStrings(configs.flatMap((config) => config.discoveryCatalogs ?? [])),
    extraDiscoveryCatalogs: uniqueStrings(configs.flatMap((config) => config.extraDiscoveryCatalogs ?? [])),
    rules: uniqueRules(configs.flatMap((config) => config.rules ?? [])),
    requireAutoload: requireAutoloadValues.length > 0 ? requireAutoloadValues.at(-1) : undefined,
    exposeBundlesAsSkills: exposeBundlesAsSkillsValues.length > 0 ? exposeBundlesAsSkillsValues.at(-1) : undefined,
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

function normalizeBundleSkillExposure(value: unknown, baseDir = process.cwd()): boolean | BundleSkillExposureConfig | undefined {
  if (typeof value === "boolean") return value;
  if (!isRecord(value) || !("include" in value)) return undefined;
  const outputRoot = typeof value.outputRoot === "string" && value.outputRoot.trim()
    ? expandPath(value.outputRoot.trim(), baseDir)
    : undefined;
  const layout = value.layout === "flat-file" || value.layout === "skill-dir" ? value.layout : undefined;
  const nameTemplate = typeof value.nameTemplate === "string" && value.nameTemplate.includes("{name}")
    ? value.nameTemplate.trim()
    : undefined;
  const memberPathRoot = typeof value.memberPathRoot === "string" && value.memberPathRoot.trim()
    ? expandPath(value.memberPathRoot.trim(), baseDir)
    : undefined;
  let memberPathAnchor: string | undefined;
  if (value.memberPathAnchor !== undefined) {
    if (typeof value.memberPathAnchor !== "string" || !value.memberPathAnchor.trim() || /[\r\n`]/.test(value.memberPathAnchor)) {
      throw new Error("exposeBundlesAsSkills.memberPathAnchor must be a non-empty single-line string without backticks");
    }
    if (!memberPathRoot) throw new Error("exposeBundlesAsSkills.memberPathAnchor requires memberPathRoot");
    memberPathAnchor = value.memberPathAnchor.trim();
  }
  return {
    include: normalizeStringList(value.include),
    ...(outputRoot ? { outputRoot } : {}),
    ...(layout ? { layout } : {}),
    ...(nameTemplate ? { nameTemplate } : {}),
    ...(memberPathRoot ? { memberPathRoot } : {}),
    ...(memberPathAnchor ? { memberPathAnchor } : {}),
    ...(typeof value.registerWithHost === "boolean" ? { registerWithHost: value.registerWithHost } : {}),
  };
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

function normalizeMainConfig(parsed: unknown, configPath?: string): ConfigFile {
  if (!isRecord(parsed)) return {};
  return {
    skillRoots: stringArray(parsed.skillRoots),
    extraSkillRoots: stringArray(parsed.extraSkillRoots),
    ruleRoots: stringArray(parsed.ruleRoots),
    discoveryCatalogs: stringArray(parsed.discoveryCatalogs),
    extraDiscoveryCatalogs: stringArray(parsed.extraDiscoveryCatalogs),
    requireAutoload: typeof parsed.requireAutoload === "boolean" ? parsed.requireAutoload : undefined,
    exposeBundlesAsSkills: normalizeBundleSkillExposure(parsed.exposeBundlesAsSkills, configPath ? dirname(configPath) : process.cwd()),
    pathMode: normalizePathMode(parsed.pathMode),
    logPaths: typeof parsed.logPaths === "boolean" ? parsed.logPaths : undefined,
    scan: normalizeScanConfig(parsed.scan),
    debug: parsed.debug === true || undefined,
  };
}

function readConfig(): ConfigFile {
  const configs: ConfigFile[] = [];
  for (const configPath of resolveConfigPaths()) {
    try {
      const parsed = parseConfigFile(configPath);
      const config = normalizeMainConfig(parsed, configPath);
      configs.push(config);
      configs.push(...readRuleConfigs(configPath, config));
    } catch {
      continue;
    }
  }
  if (configs.length === 0) return {};
  if (configs.length === 1) return configs[0];
  return mergeConfigs(configs);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function collectConfigDiagnostics(): string[] {
  const diagnostics: string[] = [];
  for (const configPath of resolveConfigPaths()) {
    try {
      const parsed = parseConfigFile(configPath);
      const config = normalizeMainConfig(parsed, configPath);
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

async function buildRegistry(config = readConfig()): Promise<SkillRecord[]> {
  return buildRegistryFromRoots(configuredRoots(config), shouldRequireAutoload(config), scanOptions(config));
}

function discoverUsableSkillRoots(config: ConfigFile = readConfig(), cwd = process.cwd()): string[] {
  return uniqueStrings(configuredRoots(config).map((root) => expandPath(root, cwd)));
}

async function buildDiscoveryRegistry(config: ConfigFile = readConfig(), cwd = process.cwd()): Promise<DiscoveryRecord[]> {
  const skills = await buildRegistryFromRoots(discoverUsableSkillRoots(config, cwd), false, scanOptions(config));
  return await buildDiscoveryRegistryFromParts(skills, configuredDiscoveryCatalogs(config, cwd), scanOptions(config));
}

async function buildDollarRegistry(config: ConfigFile = readConfig(), cwd = process.cwd()): Promise<DiscoveryRecord[]> {
  return await buildDiscoveryRegistry(config, cwd);
}

async function buildRawDollarRegistry(config: ConfigFile = readConfig(), cwd = process.cwd()): Promise<DiscoveryRecord[]> {
  const skills = await buildRegistryFromRoots(discoverUsableSkillRoots(config, cwd), false, scanOptions(config));
  return [
    ...skills.map((skill) => ({ ...skill, kind: "skill" as const })),
    ...configuredDiscoveryCatalogs(config, cwd).flatMap((catalog) => {
      try {
        return readDiscoveryCatalog(catalog, skills, scanOptions(config));
      } catch {
        return [] as DiscoveryRecord[];
      }
    }),
  ];
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
          const explicitBundle = rule.id !== "dollar-skill" && trimmedQuery.startsWith("bundle:");
          const query = explicitBundle ? trimmedQuery.slice("bundle:".length).trim() : trimmedQuery;
          if (!query) continue;
          requests.push({
            query,
            ruleId: rule.id,
            matchIndex: index,
            scope: explicitBundle ? "catalog" : rule.id === "dollar-skill" ? "global" : "configured",
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
  const normalized = normalizeKey(query);
  if (!normalized) return { decision: "skip", reason: "empty-query", query };
  const candidates = registry.filter((record) => (
    recordNormalizedName(record) === normalized ||
    recordNormalizedDescription(record) === normalized ||
    recordNormalizedAliases(record).includes(normalized)
  ));
  if (candidates.length === 1) {
    const record = candidates[0];
    return { decision: "inject", reason: "unique-name-or-alias", query, record };
  }
  if (candidates.length > 1) {
    return { decision: "skip", reason: "ambiguous", query, candidates };
  }

  if (allowFuzzy) {
    const fuzzy = registry
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
): ContextInjection[] {
  const injections: ContextInjection[] = [];
  const byRecordKey = new Map<string, ContextInjection>();
  for (const request of requests) {
    const decision = request.scope === "global"
      ? matchDiscoveryRecord(request.query, globalRegistry, true)
      : request.scope === "catalog"
        ? matchDiscoveryRecord(
          request.query,
          globalRegistry.filter((record) => recordKind(record) === "bundle"),
          false,
        )
        : matchSkill(request.query, registry, false);
    if (decision.decision !== "inject") {
      logDecision(decision, { ...logExtra, ruleId: request.ruleId, matchIndex: request.matchIndex }, config);
      continue;
    }
    const recordKey = `${recordKind(decision.record)}:${resolve(recordPath(decision.record))}:${recordNormalizedName(decision.record)}`;
    const existing = byRecordKey.get(recordKey);
    if (existing) {
      existing.ruleIds = uniqueStrings([...existing.ruleIds, request.ruleId]);
      continue;
    }
    const injection = { record: decision.record, query: request.query, ruleIds: [request.ruleId] };
    byRecordKey.set(recordKey, injection);
    injections.push(injection);
  }
  return injections;
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function messageTextIncludesRecordBlock(message: AgentMessage, record: DiscoveryRecord): boolean {
  const text = textFromContent(message.content);
  if (!text) return false;
  const kind = recordKind(record);
  const namePatterns = [recordName(record), ...recordAliases(record)]
    .map(escapedPattern)
    .filter(Boolean);
  if (namePatterns.length === 0) return false;
  return namePatterns.some((name) => (
    new RegExp(`<context-broker-record\\s+[^>]*name="${name}"`, "i").test(text)
    || new RegExp(`<!--\\s*context-broker:${kind}:${name}(?::[^>]*)?\\s*-->`, "i").test(text)
  ));
}

function messageTextIncludesSkillBlock(message: AgentMessage, skill: SkillRecord): boolean {
  return messageTextIncludesRecordBlock(message, skill);
}

function hasLoadedRecord(messages: AgentMessage[], record: DiscoveryRecord): boolean {
  const normalizedPath = resolve(recordPath(record));
  const normalizedName = recordNormalizedName(record);
  const kind = recordKind(record);
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
        return itemKind === kind && (itemName === normalizedName || itemPath === normalizedPath || itemSourcePath === normalizedPath);
      })) {
        return true;
      }
      if (detailKind === kind && (detailName === normalizedName || detailPath === normalizedPath || detailSourcePath === normalizedPath)) return true;
    }
    if (kind === "skill" && message.role === "custom" && message.customType === BUILTIN_SKILL_PROMPT_TYPE) {
      if (detailName === normalizedName || detailPath === normalizedPath) return true;
    }
    if (messageTextIncludesRecordBlock(message, record)) return true;
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
    name: recordName(injection.record),
    path: formatPathForPayload(recordPath(injection.record), config),
    query: injection.query,
    ruleIds: injection.ruleIds,
  };
}

function renderBundlePolicy(bundle: Extract<DiscoveryRecord, { kind: "bundle" }>): string[] {
  const policy = bundle.policy;
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

function commonFormattedMemberRoot(paths: string[]): string | undefined {
  if (paths.length === 0 || paths.some((path) => !path.includes("/"))) return undefined;
  const absolute = paths.every((path) => path.replaceAll("\\", "/").startsWith("/"));
  const directories = paths.map((path) => path.replaceAll("\\", "/").replace(/^\/+/, "").split("/").slice(0, -1));
  const first = directories[0] ?? [];
  let length = first.length;
  for (const directory of directories.slice(1)) {
    length = Math.min(length, directory.length);
    for (let index = 0; index < length; index += 1) {
      if (directory[index] !== first[index]) {
        length = index;
        break;
      }
    }
  }
  if (length === 0) return absolute ? "/" : ".";
  const root = first.slice(0, length).join("/");
  return absolute ? `/${root}` : root;
}

function defaultFormattedMemberPrefix(
  bundle: Extract<DiscoveryRecord, { kind: "bundle" }>,
  formatPath: (path: string) => string,
): string | undefined {
  const counts = new Map<string, number>();
  for (const member of bundle.members) {
    const path = formatPath(member.path).replaceAll("\\", "/");
    const expectedTail = `${member.name}/SKILL.md`;
    const prefix = path === expectedTail
      ? ""
      : path.endsWith(`/${expectedTail}`)
        ? path.slice(0, -(expectedTail.length + 1))
        : undefined;
    if (prefix !== undefined) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  const winner = [...counts.entries()].sort(([leftPrefix, leftCount], [rightPrefix, rightCount]) => (
    rightCount - leftCount || leftPrefix.localeCompare(rightPrefix)
  ))[0];
  return winner && winner[1] * 2 > bundle.members.length ? winner[0] : undefined;
}

function renderCompactBundleRouting(
  bundle: Extract<DiscoveryRecord, { kind: "bundle" }>,
  formatPath: (path: string) => string,
  memberPathAnchor?: string,
): string[] {
  const routing = bundle.routing!;
  const routeByMember = new Map(Object.entries(routing.members ?? {}).map(([name, route]) => [normalizeKey(name), route]));
  const formattedPaths = bundle.members.map((member) => formatPath(member.path).replaceAll("\\", "/"));
  const commonRoot = memberPathAnchor ? undefined : commonFormattedMemberRoot(formattedPaths);
  const defaultPrefix = memberPathAnchor ? defaultFormattedMemberPrefix(bundle, formatPath) : undefined;
  const groups = routing.groups ?? [];
  const grouped = new Map<string, typeof bundle.members>();
  const ungrouped: typeof bundle.members = [];

  for (const member of bundle.members) {
    const route = routeByMember.get(normalizeKey(member.name));
    const group = route?.group ? normalizeKey(route.group) : "";
    if (!group) {
      ungrouped.push(member);
      continue;
    }
    const members = grouped.get(group) ?? [];
    members.push(member);
    grouped.set(group, members);
  }

  const memberLine = (member: typeof bundle.members[number]): string => {
    const route = routeByMember.get(normalizeKey(member.name));
    const formattedPath = formatPath(member.path).replaceAll("\\", "/");
    if (memberPathAnchor) {
      const expectedPath = defaultPrefix === undefined
        ? undefined
        : `${defaultPrefix ? `${defaultPrefix}/` : ""}${member.name}/SKILL.md`;
      const pathSuffix = formattedPath === expectedPath ? "" : `（\`${formattedPath}\`）`;
      return `- \`${member.name}\`${pathSuffix}：${route?.hint ?? member.description ?? ""}`;
    }
    const relativePath = commonRoot && formattedPath.startsWith(`${commonRoot}/`)
      ? formattedPath.slice(commonRoot.length + 1)
      : formattedPath;
    const expectedPath = `${member.name}/SKILL.md`;
    const pathSuffix = relativePath === expectedPath ? "" : `（${relativePath}）`;
    return `- \`${member.name}\`${pathSuffix}：${route?.hint ?? member.description ?? ""}`;
  };

  const lines = [
    `<!-- context-broker:bundle:${bundle.normalizedName} -->`,
    `# ${bundle.name} 路由`,
    ...(routing.overview ? ["", routing.overview] : []),
    ...(routing.rules?.length ? ["", `规则：${routing.rules.join("；")}`] : []),
    ...(memberPathAnchor ? ["", `成员根：\`${memberPathAnchor}\``] : []),
    ...(memberPathAnchor && defaultPrefix !== undefined ? [
      `默认：\`${defaultPrefix ? `${defaultPrefix}/` : ""}<name>/SKILL.md\`；括号标例外。`,
    ] : []),
    ...(commonRoot ? ["", `路径根：\`${commonRoot}\`；默认 \`<name>/SKILL.md\`，括号标例外。`] : []),
  ];

  for (const group of groups) {
    const members = grouped.get(normalizeKey(group.id)) ?? [];
    if (members.length === 0) continue;
    lines.push("", `## ${group.label ?? group.id}${group.hint ? `：${group.hint}` : ""}`, ...members.map(memberLine));
  }
  if (ungrouped.length > 0) lines.push("", "## 成员", ...ungrouped.map(memberLine));

  const prerequisites = bundle.policy?.prerequisites ?? [];
  const fallback = bundle.policy?.fallback ?? [];
  if (prerequisites.length > 0) lines.push("", `前置：${prerequisites.map((name) => `\`${name}\``).join(" + ")}`);
  if (fallback.length > 0) lines.push("", `兜底：${fallback.map((name) => `\`${name}\``).join(" / ")}`);
  if (routing.combinations?.length) lines.push("", `组合：${routing.combinations.join("；")}`);
  return lines;
}

function renderBundleRecord(
  injection: ContextInjection,
  config: ConfigFile,
  formatPath: (path: string) => string = (path) => formatPathForPayload(path, config),
): string[] {
  const bundle = injection.record as Extract<DiscoveryRecord, { kind: "bundle" }>;
  if (bundle.routing) {
    const memberPathAnchor = bundleSkillExposureConfig(config)?.memberPathAnchor;
    if (memberPathAnchor) {
      const anchoredFormatter = generatedBundlePathFormatter(config);
      if (!anchoredFormatter) throw new Error("generated Bundle memberPathAnchor requires memberPathRoot");
      return renderCompactBundleRouting(bundle, anchoredFormatter, memberPathAnchor);
    }
    return renderCompactBundleRouting(bundle, formatPath);
  }
  const defaultRules = [
    "This is a context bundle index, not a concrete skill.",
    "Select the needed member by name/description before acting.",
    "Read the selected member SKILL.md before using that member capability.",
    "Member descriptions are routing metadata, not full operating instructions.",
  ];
  const rules = bundle.render?.rules && bundle.render.rules.length > 0 ? bundle.render.rules : defaultRules;
  return [
    `<!-- context-broker:${recordKind(bundle)}:${bundle.normalizedName}:${formatPath(bundle.path)} -->`,
    `<context-broker-record kind="bundle" name="${escapeAttribute(bundle.name)}" path="${escapeAttribute(formatPath(bundle.path))}">`,
    `<description>${escapeText(bundle.description)}</description>`,
    "<rules>",
    ...rules.map((rule) => `<rule>${escapeText(rule)}</rule>`),
    "</rules>",
    ...renderBundlePolicy(bundle),
    "<members>",
    ...bundle.members.map((member) => `<member name="${escapeAttribute(member.name)}" path="${escapeAttribute(formatPath(member.path))}">${escapeText(member.description ?? "")}</member>`),
    "</members>",
    "</context-broker-record>",
  ];
}

function bundleSkillExposureConfig(config: ConfigFile): BundleSkillExposureConfig | undefined {
  const exposure = config.exposeBundlesAsSkills;
  return typeof exposure === "object" && exposure !== null ? exposure : undefined;
}

function generatedBundleSkillRoot(config: ConfigFile = {}): string {
  const configured = bundleSkillExposureConfig(config)?.outputRoot;
  if (configured) return configured;
  const agentDir = defaultAgentDir();
  if (agentDir) return join(agentDir, CONFIG_DIR_BASENAME, GENERATED_SKILL_ROOT_BASENAME);
  const configPath = resolveConfigPath();
  if (configPath) return join(dirname(configPath), GENERATED_SKILL_ROOT_BASENAME);
  return join(homeDir(), ".cache", CONFIG_DIR_BASENAME, GENERATED_SKILL_ROOT_BASENAME);
}

function generatedBundleSkillName(bundle: Extract<DiscoveryRecord, { kind: "bundle" }>, config: ConfigFile): string {
  const template = bundleSkillExposureConfig(config)?.nameTemplate ?? "{name}";
  return template.replaceAll("{name}", bundle.name);
}

function generatedBundlePathFormatter(config: ConfigFile): ((path: string) => string) | undefined {
  const root = bundleSkillExposureConfig(config)?.memberPathRoot;
  if (!root) return undefined;
  return (path: string) => {
    const rel = relative(resolve(root), resolve(path));
    if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      throw new Error(`generated Bundle member path escapes memberPathRoot: ${path}`);
    }
    return rel.replaceAll("\\", "/");
  };
}

function renderGeneratedBundleSkill(
  bundle: Extract<DiscoveryRecord, { kind: "bundle" }>,
  config: ConfigFile = {},
  recordIdentity?: string,
  skillName = bundle.name,
): string {
  const description = bundle.description || `Context bundle index for ${bundle.name} with ${bundle.members.length} members.`;
  const memberPathFormatter = generatedBundlePathFormatter(config);
  const body = renderBundleRecord({
    record: bundle,
    query: bundle.name,
    ruleIds: ["host-skill-discovery"],
  }, config, memberPathFormatter).join("\n");
  const compactRouting = Boolean(bundle.routing);
  return [
    "---",
    `name: ${JSON.stringify(skillName)}`,
    `description: ${JSON.stringify(description)}`,
    "metadata:",
    "  context-broker-kind: bundle",
    `  context-broker-owner: ${GENERATED_BUNDLE_OWNER}`,
    `  context-broker-source-bundle: ${JSON.stringify(bundle.name)}`,
    ...(recordIdentity ? [`  context-broker-record-id: ${recordIdentity}`] : []),
    "---",
    "",
    ...(compactRouting ? [body] : [
      `# Context bundle: ${bundle.name}`,
      "",
      "This generated skill is a lightweight Context Broker bundle index. Select the relevant member before acting and load that member's instructions when its source is readable.",
      ...(memberPathFormatter ? ["Member paths are relative to the configured memberPathRoot and must be resolved against that source checkout."] : []),
      "",
      body,
    ]),
    "",
  ].join("\n");
}

function bundleSkillDiscoveryIncludes(config: ConfigFile): string[] | undefined {
  return bundleSkillExposureConfig(config)?.include;
}

function bundleSkillDiscoveryEnabled(config: ConfigFile): boolean {
  return config.exposeBundlesAsSkills === true || (bundleSkillDiscoveryIncludes(config)?.length ?? 0) > 0;
}

function bundleSkillHostRegistrationEnabled(config: ConfigFile): boolean {
  return bundleSkillExposureConfig(config)?.registerWithHost !== false;
}

function bundleSkillDiscoveryLabel(config: ConfigFile): string {
  if (config.exposeBundlesAsSkills === true) return "enabled (all, host registered)";
  const include = bundleSkillDiscoveryIncludes(config);
  if (!include || include.length === 0) return "disabled";
  const exposure = bundleSkillExposureConfig(config);
  return `enabled (${include.join(", ")}; ${exposure?.layout ?? "flat-file"}; ${bundleSkillHostRegistrationEnabled(config) ? "host registered" : "materialize only"})`;
}

function selectExposedBundles(
  bundles: Array<Extract<DiscoveryRecord, { kind: "bundle" }>>,
  config: ConfigFile,
): Array<Extract<DiscoveryRecord, { kind: "bundle" }>> {
  if (config.exposeBundlesAsSkills === true) return bundles;
  const include = bundleSkillDiscoveryIncludes(config);
  if (!include) return [];
  const included = new Set(include.map(normalizeKey));
  return bundles.filter((bundle) => (
    included.has(recordNormalizedName(bundle)) || recordNormalizedAliases(bundle).some((alias) => included.has(alias))
  ));
}

async function discoverBundles(config: ConfigFile, cwd: string): Promise<Array<Extract<DiscoveryRecord, { kind: "bundle" }>>> {
  const bundles = (await buildDiscoveryRegistry(config, cwd))
    .filter((record): record is Extract<DiscoveryRecord, { kind: "bundle" }> => recordKind(record) === "bundle")
    .sort((left, right) => left.name.localeCompare(right.name));
  const selected = selectExposedBundles(bundles, config).map((bundle) => {
    const generatedName = normalizeKey(generatedBundleSkillName(bundle, config));
    const members = bundle.members.filter((member) => normalizeKey(member.name) !== generatedName);
    return members.length === bundle.members.length ? bundle : { ...bundle, members };
  });
  const errors = validateDiscoveryRecords(selected);
  if (errors.length > 0) {
    throw new Error(`Cannot materialize invalid Bundle Skills:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  }
  return selected;
}

function materializeBundleRecords(
  bundles: Array<Extract<DiscoveryRecord, { kind: "bundle" }>>,
  config: ConfigFile,
): string[] {
  const exposure = bundleSkillExposureConfig(config);
  return materializeGeneratedBundleSkills({
    root: generatedBundleSkillRoot(config),
    bundles,
    layout: exposure?.layout ?? "flat-file",
    skillName: (bundle) => generatedBundleSkillName(bundle, config),
    render: (bundle, recordIdentity) => renderGeneratedBundleSkill(
      bundle,
      config,
      recordIdentity,
      generatedBundleSkillName(bundle, config),
    ),
  });
}

async function materializeDiscoveredBundleSkills(config: ConfigFile = readConfig(), cwd = process.cwd()): Promise<string[]> {
  if (!bundleSkillDiscoveryEnabled(config)) return [];
  return materializeBundleRecords(await discoverBundles(config, cwd), config);
}

async function buildBundleSkillDiscoverySection(config: ConfigFile, cwd: string): Promise<string | undefined> {
  if (!bundleSkillDiscoveryEnabled(config) || !bundleSkillHostRegistrationEnabled(config)) return undefined;
  const bundles = await discoverBundles(config, cwd);
  const paths = materializeBundleRecords(bundles, config);
  if (paths.length === 0) return undefined;
  return [
    "<available_skills>",
    ...bundles.flatMap((bundle, index) => [
      "<skill>",
      `<name>${escapeText(generatedBundleSkillName(bundle, config))}</name>`,
      `<description>${escapeText(bundle.description || `Context bundle index with ${bundle.members.length} members.`)}</description>`,
      `<location>${escapeText(formatPathForPayload(paths[index], config))}</location>`,
      "</skill>",
    ]),
    "</available_skills>",
  ].join("\n");
}

function renderSkillRecord(injection: ContextInjection, config: ConfigFile): string[] {
  const skill = injection.record as SkillRecord;
  return [
    `<!-- context-broker:skill:${skill.normalizedName}:${formatPathForPayload(skill.path, config)} -->`,
    `<context-broker-record kind="skill" name="${escapeAttribute(skill.name)}" path="${escapeAttribute(formatPathForPayload(skill.path, config))}">`,
    "<body>",
    escapeText(skill.body),
    "</body>",
    "</context-broker-record>",
  ];
}

function buildInjectedPayloadFromInjections(injections: ContextInjection[], config: ConfigFile = {}): Omit<AgentMessage, "role" | "timestamp"> {
  const records = injections.map((injection) => recordDetail(injection, config));
  return {
    customType: CUSTOM_TYPE,
    content: injections.flatMap((injection) => recordKind(injection.record) === "bundle" ? renderBundleRecord(injection, config) : renderSkillRecord(injection, config)).join("\n"),
    display: false,
    details: {
      ...(records.length === 1 ? records[0] : {}),
      records,
      injectedBy: CUSTOM_TYPE,
      version: 3,
    },
  };
}

function buildInjectedPayload(skill: SkillRecord, query: string, config: ConfigFile = {}): Omit<AgentMessage, "role" | "timestamp"> {
  return buildInjectedPayloadFromInjections([{ record: skill, query, ruleIds: [] }], config);
}

function buildInjectedContextMessageFromInjections(injections: ContextInjection[], config: ConfigFile = {}): AgentMessage {
  return {
    role: "custom",
    ...buildInjectedPayloadFromInjections(injections, config),
    timestamp: Date.now(),
  };
}

function buildInjectedContextMessage(skill: SkillRecord, query: string, config: ConfigFile = {}): AgentMessage {
  return buildInjectedContextMessageFromInjections([{ record: skill, query, ruleIds: [] }], config);
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
  const injections = resolveSkillRequests(requests, registry, {}, dollarRegistry, config);
  const unloaded = injections.filter((injection) => {
    if (!hasLoadedRecord(event.messages, injection.record)) return true;
    logDecision(
      { decision: "skip", reason: "already-loaded", query: injection.query, candidates: [injection.record] },
      { ruleIds: injection.ruleIds },
      config,
    );
    return false;
  });
  if (unloaded.length === 0) {
    return undefined;
  }
  const message = buildInjectedContextMessageFromInjections(unloaded, config);
  logInjection(unloaded, { action: "inject" }, config);
  return { messages: [...event.messages, message] };
}

async function invokeBeforeAgentStart(
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
  registryPromise: Promise<SkillRecord[]>,
  config: ConfigFile,
  dollarRegistryPromise: Promise<DiscoveryRecord[]> = Promise.resolve([]),
): Promise<BeforeAgentStartResult | undefined> {
  const requests = parseInvocations(event.prompt, configuredRules(config));
  if (requests.length === 0) return undefined;
  const registry = await registryPromise;
  const dollarRegistry = requests.some((request) => request.scope === "global" || request.scope === "catalog")
    ? await buildDollarRegistryForContext(ctx, dollarRegistryPromise)
    : [];
  const injections = resolveSkillRequests(requests, registry, { phase: "before_agent_start" }, dollarRegistry, config);
  const sessionMessages = messagesFromActiveSessionContext(ctx);
  const alreadyLoaded: ContextInjection[] = [];
  const unloaded = injections.filter((injection) => {
    if (!hasLoadedRecord(sessionMessages, injection.record)) return true;
    alreadyLoaded.push(injection);
    logDecision(
      { decision: "skip", reason: "already-loaded", query: injection.query, candidates: [injection.record] },
      { ruleIds: injection.ruleIds, phase: "before_agent_start" },
      config,
    );
    return false;
  });
  if (unloaded.length === 0) {
    notifyInjectedRecords(ctx, [], alreadyLoaded.map((injection) => injection.record));
    return undefined;
  }
  const message = buildInjectedPayloadFromInjections(unloaded, config);
  logInjection(unloaded, { phase: "before_agent_start", action: "inject" }, config);
  notifyInjectedRecords(
    ctx,
    unloaded.map((injection) => injection.record),
    alreadyLoaded.map((injection) => injection.record),
  );
  return { message };
}

function contextBrokerCommandCompletions(argumentPrefix: string) {
  const commands = [
    { value: "status", label: "status", description: "Show loaded discovery record summary" },
    { value: "doctor", label: "doctor", description: "Diagnose config, catalogs, names, aliases, and bundles" },
    { value: "roots", label: "roots", description: "Show skill roots" },
    { value: "catalogs", label: "catalogs", description: "Show discovery catalogs" },
    { value: "materialize", label: "materialize", description: "Render configured Bundle Skill entities" },
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

async function formatContextBrokerDoctor(config: ConfigFile, cwd = process.cwd()): Promise<string> {
  const roots = discoverUsableSkillRoots(config, cwd);
  const catalogs = configuredDiscoveryCatalogs(config, cwd);
  const rawRegistry = await buildRawDollarRegistry(config, cwd);
  const errors = validateDiscoveryRecords(rawRegistry);
  const diagnostics = collectConfigDiagnostics();
  const bundles = rawRegistry.filter((record) => recordKind(record) === "bundle");
  const skills = rawRegistry.filter((record) => recordKind(record) === "skill");
  const exposedIncludes = bundleSkillDiscoveryIncludes(config) ?? [];
  const bundleLookupKeys = new Set(bundles.flatMap((bundle) => [recordNormalizedName(bundle), ...recordNormalizedAliases(bundle)]));
  for (const included of exposedIncludes) {
    if (!bundleLookupKeys.has(normalizeKey(included))) diagnostics.push(`bundle skill discovery includes unknown bundle: ${included}`);
  }
  for (const catalog of catalogs) {
    try {
      readDiscoveryCatalog(catalog, skills as SkillRecord[], scanOptions(config));
    } catch (error) {
      diagnostics.push(`catalog read failed: ${catalog}: ${errorMessage(error)}`);
    }
  }
  return [
    "Context Broker Doctor",
    "",
    `Config: ${resolveConfigPath() ?? "none"}`,
    `Path mode: ${configuredPathMode(config)}`,
    `Log paths: ${config.logPaths === true ? "enabled" : "disabled"}`,
    `Bundle skill discovery: ${bundleSkillDiscoveryLabel(config)}`,
    `Scan: maxDepth=${config.scan?.maxDepth ?? 8}, maxSkillBytes=${config.scan?.maxSkillBytes ?? 65536}`,
    `Skill roots: ${roots.length}`,
    `Discovery catalogs: ${catalogs.length}`,
    ...catalogs.map((catalog) => `  ${existsSync(catalog) ? "ok" : "missing"} ${catalog}`),
    `Records: ${skills.length} skills, ${bundles.length} bundles`,
    diagnostics.length === 0 ? "Config diagnostics: ok" : "Config diagnostics: failed",
    ...diagnostics.map((diagnostic) => `  fail ${diagnostic}`),
    errors.length === 0 ? "Namespace: ok no discovery namespace collisions" : "Namespace: failed",
    ...errors.map((error) => `  fail ${error}`),
    "Bundles:",
    ...(bundles.length > 0 ? bundles.map((record) => `  ${recordName(record)}: ${(record as any).members?.length ?? 0} members`) : ["  none"]),
  ].join("\n");
}

function formatExplainRecord(record: DiscoveryRecord): string {
  if (recordKind(record) === "bundle") {
    const bundle = record as Extract<DiscoveryRecord, { kind: "bundle" }>;
    return [
      `record: ${bundle.name}`,
      "kind: bundle",
      "inject: member-index",
      `members: ${bundle.members.length}`,
      `path: ${bundle.path}`,
      bundle.description ? `description: ${bundle.description}` : undefined,
    ].filter(Boolean).join("\n");
  }
  return [
    `record: ${recordName(record)}`,
    "kind: skill",
    "inject: full-file",
    `path: ${recordPath(record)}`,
    recordDescription(record) ? `description: ${recordDescription(record)}` : undefined,
  ].filter(Boolean).join("\n");
}

async function dispatchContextBrokerCommand(args: string, ctx: ExtensionContext, config: ConfigFile, getDollarRegistry: (cwd?: string) => Promise<DiscoveryRecord[]>, registryPromise: Promise<SkillRecord[]>): Promise<void> {
  const [command = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
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
    ctx.ui?.notify?.(await formatContextBrokerDoctor(config, ctx.cwd), "info");
    return;
  }
  if (command === "materialize") {
    try {
      const paths = await materializeDiscoveredBundleSkills(config, ctx.cwd ?? process.cwd());
      ctx.ui?.notify?.(
        paths.length > 0
          ? `context-broker materialized ${paths.length} Bundle Skills\n${paths.join("\n")}`
          : "context-broker materialized 0 Bundle Skills; enable exposeBundlesAsSkills first",
        paths.length > 0 ? "info" : "warning",
      );
    } catch (error) {
      ctx.ui?.notify?.(`context-broker materialize failed: ${errorMessage(error)}`, "error");
    }
    return;
  }
  if (command === "find") {
    const query = rest.join(" ");
    const registry = await buildDollarRegistryForContext(ctx, getDollarRegistry(ctx.cwd));
    const rawRegistry = await buildRawDollarRegistry(config, ctx.cwd);
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
  const bundles = dollarRegistry.filter((record) => recordKind(record) === "bundle").length;
  ctx.ui?.notify?.(
    `context-broker status: ${registry.length} configured skills, ${dollarRegistry.length} $ records, ${bundles} bundles\ncommands: doctor, roots, catalogs, materialize, find <query>, explain <name>`,
    registry.length > 0 || dollarRegistry.length > 0 ? "info" : "warning",
  );
}

export default function contextBroker(pi: ExtensionAPI): void {
  const config = readConfig();
  const registryPromise = buildRegistry(config);
  const dollarRegistryByCwd = new Map<string, Promise<DiscoveryRecord[]>>();
  let hostResourceDiscoveryActive = false;
  const getDollarRegistry = (cwd = process.cwd()) => {
    const key = resolve(cwd);
    let promise = dollarRegistryByCwd.get(key);
    if (!promise) {
      promise = buildDollarRegistry(config, key);
      dollarRegistryByCwd.set(key, promise);
    }
    return promise;
  };
  pi.on("session_start", async (_event, ctx) => {
    await installPiDollarAutocompleteEditor(ctx);
    ctx.ui?.addAutocompleteProvider?.((current) => createDollarSkillAutocompleteProvider(
      current,
      buildDollarRegistryForContext(ctx, getDollarRegistry(ctx.cwd)),
    ));
  });
  pi.on("resources_discover", async (event, ctx) => {
    if (!bundleSkillDiscoveryEnabled(config)) return undefined;
    try {
      const skillPaths = await materializeDiscoveredBundleSkills(config, event.cwd);
      if (!bundleSkillHostRegistrationEnabled(config)) return undefined;
      hostResourceDiscoveryActive = true;
      return skillPaths.length > 0 ? { skillPaths } : undefined;
    } catch (error) {
      ctx.ui?.notify?.(`context-broker: bundle skill discovery failed: ${errorMessage(error)}`, "warning");
      return undefined;
    }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const injection = await invokeBeforeAgentStart(event, ctx, registryPromise, config, getDollarRegistry(ctx.cwd));
    if (
      hostResourceDiscoveryActive
      || !Array.isArray(event.systemPrompt)
      || !bundleSkillDiscoveryEnabled(config)
      || !bundleSkillHostRegistrationEnabled(config)
    ) return injection;
    try {
      const section = await buildBundleSkillDiscoverySection(config, ctx.cwd ?? process.cwd());
      if (!section) return injection;
      return { ...injection, systemPrompt: [...event.systemPrompt, section] };
    } catch (error) {
      ctx.ui?.notify?.(`context-broker: bundle skill discovery failed: ${errorMessage(error)}`, "warning");
      return injection;
    }
  });
  const command = {
    description: "Inspect context-broker discovery records, bundles, catalogs, and config health",
    getArgumentCompletions: contextBrokerCommandCompletions,
    handler: (args: string, ctx: ExtensionContext) => dispatchContextBrokerCommand(args, ctx, config, getDollarRegistry, registryPromise),
  };
  pi.registerCommand?.("context-broker", command);
}

export {
  CUSTOM_TYPE,
  BUILTIN_SKILL_PROMPT_TYPE,
  buildBundleSkillDiscoverySection,
  buildInjectedContextMessage,
  buildInjectedPayload,
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
  detectHost,
  discoveryAutocompleteItems,
  dollarAutocompleteItems,
  extractDollarAutocompletePrefix,
  hasLoadedSkill,
  homeDir,
  invokeBeforeAgentStart,
  invokeForContext,
  matchDiscoveryRecord,
  matchSkill,
  materializeDiscoveredBundleSkills,
  messagesFromSessionEntries,
  normalizeKey,
  normalizeRuleConfigFile,
  notifyInjectedSkill,
  parseConfigFile,
  readDiscoveryCatalog,
  parseInvocation,
  parseInvocations,
  readConfig,
  renderGeneratedBundleSkill,
  resolveConfigPath,
  resolveConfigPaths,
  configuredRules,
  ruleRootsForConfig,
  listRuleConfigFiles,
};
