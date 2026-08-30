export type TextContent = { type: "text"; text: string };
export type ImageContent = { type: "image"; [key: string]: unknown };
export type MessageContent = string | Array<TextContent | ImageContent>;

export type AgentMessage = {
  role: string;
  content?: MessageContent;
  customType?: string;
  details?: unknown;
  display?: boolean;
  timestamp?: number;
};

export type ContextEvent = {
  messages: AgentMessage[];
};

export type ContextResult = {
  messages?: AgentMessage[];
};

export type BeforeAgentStartEvent = {
  prompt: string;
  systemPrompt?: string | string[];
};

export type BeforeAgentStartResult = {
  message?: Omit<AgentMessage, "role" | "timestamp">;
  systemPrompt?: string | string[];
};

export type ResourcesDiscoverEvent = {
  type: "resources_discover";
  cwd: string;
  reason: "startup" | "reload";
};

export type ResourcesDiscoverResult = {
  skillPaths?: string[];
};

export type AutocompleteItem = {
  value: string;
  label: string;
  description?: string;
};

export type AutocompleteSuggestions = {
  items: AutocompleteItem[];
  prefix: string;
};

export type AutocompleteProvider = {
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null>;
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): {
    lines: string[];
    cursorLine: number;
    cursorCol: number;
  };
  shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
};

export type SessionEntry = {
  type: string;
  message?: AgentMessage;
  customType?: string;
  content?: MessageContent;
  details?: unknown;
};

export type ExtensionContext = {
  hasUI?: boolean;
  ui?: {
    notify?(message: string, type?: "info" | "warning" | "error"): void;
    addAutocompleteProvider?(factory: (current: AutocompleteProvider) => AutocompleteProvider): void;
    getEditorComponent?(): EditorFactory | undefined;
    setEditorComponent?(factory: EditorFactory | undefined): void;
  };
  cwd?: string;
  getSystemPrompt?(): string | string[];
  sessionManager?: {
    getEntries?(): SessionEntry[];
    buildSessionContext?(): { messages?: AgentMessage[] };
  };
};

export type EditorLike = {
  handleInput?(data: string): void;
  state?: {
    lines?: string[];
    cursorLine?: number;
    cursorCol?: number;
  };
  isShowingAutocomplete?(): boolean;
  tryTriggerAutocomplete?(explicitTab?: boolean): void;
  [key: symbol]: unknown;
};

export type EditorFactory = (tui: unknown, theme: unknown, keybindings: unknown) => EditorLike;

export type ExtensionAPI = {
  on(
    event: "session_start",
    handler: (event: { type: "session_start"; reason?: string }, ctx: ExtensionContext) => void | Promise<void>,
  ): void;
  on(
    event: "resources_discover",
    handler: (
      event: ResourcesDiscoverEvent,
      ctx: ExtensionContext,
    ) => ResourcesDiscoverResult | Promise<ResourcesDiscoverResult | undefined> | undefined,
  ): void;
  on(
    event: "context",
    handler: (event: ContextEvent) => ContextResult | Promise<ContextResult | undefined> | undefined,
  ): void;
  on(
    event: "before_agent_start",
    handler: (
      event: BeforeAgentStartEvent,
      ctx: ExtensionContext,
    ) => BeforeAgentStartResult | Promise<BeforeAgentStartResult | undefined> | undefined,
  ): void;
  registerCommand?(name: string, command: {
    description: string;
    getArgumentCompletions?(argumentPrefix: string): AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
    handler(args: string, ctx: ExtensionContext): unknown;
  }): void;
};

export type RegexPattern = {
  pattern: string;
  flags?: string;
};

export type MatchPredicate = {
  exact?: string[];
  contains?: string[];
  regex?: RegexPattern[];
  not?: MatchPredicate[];
};

export type InvocationRule = {
  id: string;
  inject?: string[];
  match: MatchPredicate[];
};

export type PathMode = "absolute" | "home-relative" | "basename" | "hash";

export type ScanConfig = {
  maxDepth?: number;
  ignore?: string[];
  maxSkillBytes?: number;
};

export type BundleSkillExposureConfig = {
  include: string[];
  outputRoot?: string;
  layout?: "flat-file" | "skill-dir";
  nameTemplate?: string;
  memberPathRoot?: string;
  registerWithHost?: boolean;
};

export type ConfigFile = {
  skillRoots?: string[];
  extraSkillRoots?: string[];
  ruleRoots?: string[];
  discoveryCatalogs?: string[];
  extraDiscoveryCatalogs?: string[];
  rules?: InvocationRule[];
  requireAutoload?: boolean;
  exposeBundlesAsSkills?: boolean | BundleSkillExposureConfig;
  pathMode?: PathMode;
  logPaths?: boolean;
  scan?: ScanConfig;
  debug?: boolean;
};

export type SkillMetadata = {
  name: string;
  description: string;
  autoloadEnabled: boolean;
  aliases: string[];
};

export type SkillRecord = SkillMetadata & {
  kind?: "skill";
  path: string;
  normalizedName: string;
  normalizedAliases: string[];
  normalizedDescription: string;
  body: string;
};

export type DiscoveryMember = {
  name: string;
  description?: string;
  path: string;
  aliases?: string[];
};

export type BundleDiscoveryRecord = {
  kind: "bundle";
  name: string;
  description: string;
  aliases: string[];
  path: string;
  normalizedName: string;
  normalizedAliases: string[];
  normalizedDescription: string;
  render?: { type?: "member-index"; rules?: string[]; [key: string]: unknown };
  policy?: { memberBody?: "read-before-use"; scope?: "members-only" | "open"; prerequisites?: string[]; fallback?: string[]; [key: string]: unknown };
  members: DiscoveryMember[];
};

export type DiscoveryRecord = (SkillRecord & { kind?: "skill" }) | BundleDiscoveryRecord;

export type MatchDecision =
  | { decision: "inject"; reason: string; query: string; record: DiscoveryRecord }
  | { decision: "skip"; reason: string; query?: string; candidates?: DiscoveryRecord[] };

export type SkillRequest = {
  query: string;
  ruleId: string;
  matchIndex: number;
  scope?: "configured" | "catalog" | "global";
};

export type ContextInjection = {
  record: DiscoveryRecord;
  query: string;
  ruleIds: string[];
};
