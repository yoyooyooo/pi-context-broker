import type { EditorLike, ExtensionContext, HostPathOptions, ImageContent, InputResult, SkillRecord, ToolCallResult } from "./types";

export type SkillPresentation = {
  query: string;
  directory: string;
  directoryRedacted: boolean;
};
type SubmissionProtocol =
  | { mode: "command"; receipt: "handoff" }
  | { mode: "transform"; receipt: "input-digest" };

/** Host protocols selected once by the extension entry; path overrides are separate. */
export type HostCapabilities = {
  paths: HostPathOptions;
  submission: SubmissionProtocol;
  headlessActivationTimeoutMs?: number;
  metadataDiscovery?: "deferred";
  registerCatalog(records: SkillRecord[], signal?: AbortSignal): Promise<boolean>;
  catalogPaths?(record: SkillRecord): string[];
  handledInput: InputResult;
  continuedInput: InputResult | undefined;
  transformInput(text: string, images?: ImageContent[]): InputResult;
  buildPrompt(snapshot: SkillRecord, args: string, prompt: string, metadata?: SkillRecord): Promise<string>;
  skillInstructions?(record: SkillRecord, presentation: SkillPresentation): string[];
  systemPrompt?(prompt: string | string[]): string | string[];
  installEditor(ctx: ExtensionContext, bind: (editor: EditorLike) => EditorLike): Promise<void>;
  updatedRead(input: Record<string, unknown>): ToolCallResult | undefined;
  reload(ctx?: ExtensionContext): Promise<void>;
};
