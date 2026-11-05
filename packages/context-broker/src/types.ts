export type TextContent = { type: "text"; text: string };
export type ImageContent = { type: "image"; [key: string]: unknown };
export type MessageContent = string | Array<TextContent | ImageContent>;

export type AgentMessage = {
  role: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
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

export type InputEvent = {
  source?: "interactive" | "rpc" | "extension";
  text?: string;
  images?: ImageContent[];
};
export type InputResult =
  | { handled: true }
  | { text: string; images?: ImageContent[] }
  | { action: "handled" | "continue" }
  | { action: "transform"; text: string; images?: ImageContent[] };
export type ToolCallEvent = { toolName: string; toolCallId?: string; input: Record<string, unknown> };
export type ToolCallResult = { block: true; reason: string } | { input: Record<string, unknown> };
export type ToolResultEvent = { toolName: string; toolCallId?: string; parentToolCallId?: string; input: Record<string, unknown>; content?: MessageContent; isError?: boolean; details?: unknown };
/** Opaque native tool output: the adapter forwards every field without rewriting it. */
export type NativeReadResult = { content: Array<TextContent | ImageContent>; details?: unknown; isError?: boolean; [key: string]: unknown };
export type NativeReadUpdate = (result: NativeReadResult) => void;
export type NativeReadDelegate = (input: Record<string, unknown>, signal?: AbortSignal) => Promise<NativeReadResult>;
export type NativeReadExecutor = (input: Record<string, unknown>, ctx: ExtensionContext, signal: AbortSignal | undefined, read: NativeReadDelegate, toolCallId: string) => Promise<NativeReadResult>;
export type NativeReadMetadata = {
  label: string;
  description: string;
  parameters: unknown;
  strict: boolean;
  readsSkillUris: boolean;
  loadMode: "essential" | "discoverable";
  exposure?: "direct" | "model-only" | "codemode" | "deferred" | "hidden";
  defaultActive?: boolean;
  approval(args: unknown): "read" | "write" | "exec";
  approvalCacheTargets(args: unknown): readonly string[] | undefined;
};
export type NativeReadDefinition = NativeReadMetadata & {
  name: "read";
  sourcePath: string;
  defaultInactive: boolean;
  execute(id: string, input: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: NativeReadUpdate | undefined, ctx: ExtensionContext): Promise<NativeReadResult>;
};
/** Pi exposes its built-in definition through createReadToolDefinition. Keep its
 * renderers, output schema and native executor when extending the read surface. */
export type PiReadDefinition = {
  name: "read"; label: string; description: string; parameters: Record<string, unknown>;
  outputSchema?: unknown; promptSnippet?: string; promptGuidelines?: string[];
  defaultActive?: boolean; constrainedSampling?: unknown;
  execute(id: string, input: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: NativeReadUpdate | undefined, ctx: ExtensionContext): Promise<NativeReadResult>;
  renderCall?: (args: Record<string, unknown>, theme: unknown, context: unknown) => unknown;
  renderResult?: (result: NativeReadResult, options: unknown, theme: unknown, context: unknown) => unknown;
};
export type NativeSkillSearchDefinition = Omit<NativeReadDefinition, "name"> & { name: "skill_search" | "notion_list" };
export type NativeSkillPrepareDefinition = Omit<NativeReadDefinition, "name"> & { name: "skill_prepare" | "notion_use" };
export type NativeSkillGraphDefinition = Omit<NativeReadDefinition, "name"> & { name: "skill_graph" | "notion_ctl" };
type SessionBoundary = "session_before_switch" | "session_before_branch" | "session_before_tree"
  | "session_switch" | "session_tree" | "session_branch" | "session_shutdown" | "agent_start" | "agent_end";
type ExtensionEvents = {
  session_start: { event: { type: "session_start"; reason?: string }; result: void };
  context: { event: ContextEvent; result: ContextResult };
  context_with_system: { event: ContextEvent; result: ContextResult };
  before_agent_start: { event: BeforeAgentStartEvent; result: BeforeAgentStartResult };
  before_provider_request: { event: { type: "before_provider_request"; payload: unknown }; result: void };
  after_provider_response: { event: { type: "after_provider_response"; status: number; headers: Record<string, string> }; result: void };
  input: { event: InputEvent; result: InputResult };
  tool_call: { event: ToolCallEvent; result: ToolCallResult };
  tool_result: { event: ToolResultEvent; result: void | { details: unknown } };
  resources_discover: { event: { type: "resources_discover" }; result: { skillPaths: string[] } };
} & { [K in SessionBoundary]: { event: { type: K }; result: void } };

export type HostPathOptions = {
  host?: "pi" | "omp";
  agentDir?: string;
  configPath?: string;
};

export type AutocompleteItem = {
  value: string;
  label: string;
  description?: string;
  identity?: string;
  kind?: ContentKind;
  source?: "local" | "notion";
  ref?: string;
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
    options?: AbortSignal | { signal: AbortSignal; force?: boolean },
    onPartial?: (suggestions: AutocompleteSuggestions) => void,
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
    onApplied?: () => void;
  };
  shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
  getInlineHint?(lines: string[], cursorLine: number, cursorCol: number): string | null;
  trySyncSlashCompletion?(textBeforeCursor: string): AutocompleteSuggestions | null;
  trySyncInlineReplace?(textBeforeCursor: string): { replaceLen: number; insert: string } | null;
  getForceFileSuggestions?(lines: string[], cursorLine: number, cursorCol: number, signal?: AbortSignal): Promise<AutocompleteSuggestions | null>;
};

export type SessionEntry = {
  type: string;
  message?: AgentMessage;
  customType?: string;
  content?: MessageContent;
  details?: unknown;
  data?: unknown;
};

export type ExtensionWidgetNode = {
  k: string;
  p?: Record<string, unknown>;
  c?: ExtensionWidgetNode[];
};

export type ExtensionWidgetComponent = {
  render(width: number): string[];
  invalidate(): void;
  describe?(context: { supports(kind: string): boolean }): ExtensionWidgetNode | null;
  handleNativeEvent?(event: { type: string; collapsed?: boolean }): void;
  dispose?(): void;
};

export type ExtensionWidgetFactory = (tui: { requestRender(): void }, theme: unknown) => ExtensionWidgetComponent;

export type ExtensionContext = {
  hasUI?: boolean;
  ui?: {
    notify?(message: string, type?: "info" | "warning" | "error"): void;
    setWidget?(key: string, content: string[] | ExtensionWidgetFactory | undefined): void;
    custom?<T>(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => { render(width: number): string[]; invalidate(): void }, options?: { overlay?: boolean; overlayOptions?: { visible?: (width: number, height: number) => boolean } }): Promise<T>;
    addAutocompleteProvider?(factory: (current: AutocompleteProvider) => AutocompleteProvider): void;
    setEditorText?(text: string): void;
    getEditorComponent?(): EditorFactory | undefined;
    setEditorComponent?(factory: EditorFactory | undefined): void;
  };
  cwd?: string;
  mode?: "tui" | "rpc" | "print" | "json";
  /** Pi's current agent-operation signal, exposed in event and tool contexts. */
  signal?: AbortSignal;
  abort?(): void;
  reload?(): Promise<void>;
  getSystemPrompt?(): string | string[];
  sessionManager?: {
    getCwd?(): string;
    getSessionFile?(): string | undefined;
    getSessionId?(): string;
    getBranch?(): SessionEntry[];
    getEntries?(): SessionEntry[];
    buildSessionContext?(): { messages?: AgentMessage[] };
  };
  /** OMP's same-name native delegation, supplied only during a registered tool's execute. */
  invokeTool?(input: Record<string, unknown>, options?: { signal?: AbortSignal; onUpdate?: NativeReadUpdate }): Promise<NativeReadResult>;
};

export type EditorLike = {
  handleInput?(data: string): void;
  disableSubmit?: boolean;
  tui?: { requestRender(): void };
  composerState?: () => Record<string, unknown>;
  describeLayout?(...args: unknown[]): unknown;
  handleNativeEvent?(event: { type: string; act?: string }): void;
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
  pi?: {
    getAgentDir?(): string;
    settings?: unknown;
    buildSkillPromptMessage?(skill: { name: string; filePath: string; baseDir: string }, input: { args: string; prompt: string }): Promise<{ message: string }>;
    Text?: new (text: string, paddingX: number, paddingY: number) => { render(width: number): string[]; invalidate(): void };
    /** Only metadata is exposed here; actual execution uses ctx.invokeTool with the host's session. */
    ReadTool?: new (session: { cwd: string; hasUI: boolean; hasEditTool?: boolean; settings: unknown; getSessionFile(): string | null; getSessionSpawns(): string | null }) => NativeReadMetadata;
  };
  on<K extends keyof ExtensionEvents>(
    event: K,
    handler: (event: ExtensionEvents[K]["event"], ctx: ExtensionContext) => ExtensionEvents[K]["result"] | undefined | Promise<ExtensionEvents[K]["result"] | undefined>,
  ): void;
  sendUserMessage?(content: MessageContent): void;
  getAllTools?(): Array<{ name: string; description: string; parameters: unknown; sourceInfo: { source: string; path: string } }>;
  getActiveTools?(): string[];
  getSettings?(): { images?: { autoResize?: boolean } };
  registerTool?(tool: NativeReadDefinition | PiReadDefinition | NativeSkillSearchDefinition | NativeSkillPrepareDefinition | NativeSkillGraphDefinition): void;
  registerMessageRenderer?(customType: string, renderer: (message: AgentMessage, options: { expanded: boolean }, theme: unknown) => ExtensionWidgetComponent | undefined): void;
  sendMessage?(message: { customType: string; content: MessageContent; details: unknown; display: boolean }, options: { triggerTurn: boolean }): void;
  appendEntry?(customType: string, data?: unknown): void;
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

export type SourcePolicy = { maxAge?: string; offline?: boolean };

export type SourceConfig = {
  id: string;
  enabled?: boolean;
  namespace?: string;
} & (
  | { type: "filesystem"; roots: string[]; scan?: ScanConfig; requireAutoload?: boolean }
  | {
      type: "notion";
      command?: string | string[];
      database?: string;
      default_view_id?: string;
      profile_id?: string;
      cacheDir?: string;
      discovery?: SourcePolicy;
      activation?: SourcePolicy;
      preparation?: import("./prepare-protocol").PreparationBudget;
      /** Missing/boolean values keep a zero budget. Body prefetch requires an explicit bounded object. */
      prefetch?: boolean | import("./prefetch-policy").PrefetchBudget;
      requestTimeoutMs?: number;
    }
);

export type SourceFailure = {
  sourceId: string;
  namespace: string;
  type: SourceConfig["type"];
  code: string;
  message: string;
  /** Partial metadata and default-View failures do not revoke exact-record access. */
  blocking?: boolean;
};
export type NotionView = { id: string; name: string; type: string; database_id: string; data_source_id: string; url: string };
export type NotionViewState =
  | { sourceId: string; origin: "session" | "configured" | "profile" | "first"; status: "ready"; view: NotionView; count: number; partial: boolean }
  | { sourceId: string; origin: "session" | "configured" | "profile" | "first"; status: "empty" }
  | { sourceId: string; origin: "session" | "configured" | "profile" | "first"; status: "error"; code: string };
export type NotionListObservation = {
  sourceId: string;
  exhaustive?: boolean;
  policy: "default" | "max_age" | "refresh" | "offline" | "pinned";
  validatedAt?: string;
  ageMs?: number;
  maxAgeMs?: number;
  stale?: boolean;
};
export type DiscoveryResult<T = DiscoveryRecord> = { records: T[]; failures: SourceFailure[]; lists?: NotionListObservation[]; views?: NotionViewState[] };

export type ConfigFile = {
  sources?: SourceConfig[];
  skillRoots?: string[];
  extraSkillRoots?: string[];
  ruleRoots?: string[];
  discoveryCatalogs?: string[];
  extraDiscoveryCatalogs?: string[];
  rules?: InvocationRule[];
  requireAutoload?: boolean;
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

export type ContentKind = "skill" | "router" | "prompt";
export type ContentLocator =
  | { type: "shared_skill"; page_id: string; database_id: string; data_source_id: string; library_id: string; skill_id: string }
  | { type: "notion_page"; page_id: string; database_id: string; data_source_id: string }
  | { type: "notion_subscription"; subscription_id: string; database_id: string; data_source_id: string; target_database_id: string }
  | { type: "local"; id: string; entry: string };

/** Public CLI wire. Display names and materialized paths never identify content. */
export type ContentRecord = {
  id: string;
  kind: ContentKind;
  locator: ContentLocator;
  name: string;
  alias: string;
  description: string;
  default_context: boolean;
  enabled?: boolean;
  entrypoint: string;
  ref: string;
  upstream?: { repo: string };
};

export type CatalogRemoteReference = {
  type: "remote";
  source: { namespace: string };
  id: string;
  locator: Exclude<ContentLocator, { type: "local" }>;
  ref: string;
};

export type RawCatalogMember =
  | { type: "local"; path: string; name?: string; description?: string; aliases?: string[] }
  | CatalogRemoteReference;

export type CatalogResolutionContext = {
  sources?: SourceConfig[];
  records?: SkillRecord[];
  failures?: SourceFailure[];
};

export type DiscoveryMember = {
  id?: string;
  kind?: "skill";
  ref?: string;
  name: string;
  description?: string;
  aliases?: string[];
} & (
  | { type: "local"; path: string; unavailable?: { code: string; message: string; candidates: string[] } }
  | { type: "remote"; path?: never; source: { namespace: string }; sourceId?: string; sourceScope?: string; locator: CatalogRemoteReference["locator"]; unavailable?: { code: string; message: string; candidates: string[] } }
);

/** Host projection of the shared record, also used for prepared immutable snapshots. */
export type SkillRecord = SkillMetadata & {
  kind?: ContentKind;
  id?: string;
  alias?: string;
  locator?: ContentLocator;
  entrypoint?: string;
  ref?: string;
  default_context?: boolean;
  enabled?: boolean;
  upstream?: ContentRecord["upstream"];
  source?: "local" | "notion";
  path: string;
  normalizedName: string;
  normalizedAliases: string[];
  normalizedDescription: string;
  body?: string;
  sourceId?: string;
  token?: string;
  selectionToken?: string;
  snapshotId?: string;
  defaultDiscovery?: boolean;
  versionId?: string;
  freshness?: unknown;
  coverage?: unknown;
  sourceScope?: string;
  metadataIndexPath?: string;
  fileBindings?: readonly { file_id: string; page_id: string; path: string }[];
  preparationBinding?: import("./prepare-protocol").PreparationBinding;
  preparationDirectory?: import("./prepare-protocol").PreparationDirectory;
  entryManifest?: import("./notion-entry").EntryManifest;
  render?: { type?: "member-index"; rules?: string[]; [key: string]: unknown };
  policy?: { memberBody?: "read-before-use"; scope?: "members-only" | "open"; prerequisites?: string[]; fallback?: string[]; [key: string]: unknown };
  members?: DiscoveryMember[];
};

export type RouterDiscoveryRecord = SkillRecord & { kind: "router"; members: DiscoveryMember[] };
export type DiscoveryRecord = SkillRecord;

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
