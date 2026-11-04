import { resolve } from "node:path";
import { homedir } from "node:os";
import type { NotionViewState, SkillRecord } from "./types";

const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const unescape = (value: string) => value.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
const hostName = (record: SkillRecord) => (record.token ?? record.name).replace(/[^a-z0-9-]/g, "-");

/** Rebuild only broker-owned metadata for this request, never conversation bodies. */
export function viewSystemPrompt(input: string | string[] | undefined, skills: readonly SkillRecord[], routers: readonly SkillRecord[], ownedPaths: ReadonlySet<string>, views: readonly NotionViewState[], cwd = process.cwd(), renderRef?: (record: SkillRecord) => string | undefined): string {
  const prompt = (Array.isArray(input) ? input.join("\n\n") : input ?? "")
    .replace(/\n*<ntn-skills-view-catalog>[\s\S]*?<\/ntn-skills-view-catalog>/g, "")
    .replace(/<available_skills>[\s\S]*?<\/available_skills>/g, block => block.replace(/<skill>[\s\S]*?<\/skill>/g, entry => {
      const raw = /<location>\s*([^<]+)\s*<\/location>/.exec(entry)?.[1];
      if (!raw) return entry;
      const path = unescape(raw.trim());
      const expanded = path.startsWith("~/") ? homedir() + path.slice(1) : path;
      return ownedPaths.has(resolve(cwd, expanded)) ? "" : entry;
    }));
  if (!skills.length && !routers.length && !views.length) return prompt;
  const states = views.map(state => state.status === "ready"
    ? `<view source="${xml(state.sourceId)}" id="${xml(state.view.id)}" database="${xml(state.view.database_id)}" origin="${state.origin}" partial="${state.partial}">${xml(state.view.name)}</view>`
    : `<view source="${xml(state.sourceId)}" origin="${state.origin}" status="${state.status}"${state.status === "error" ? ` code="${xml(state.code)}"` : ""}/>`).join("\n");
  const entries = skills.map(record => {
    const shortRef = record.source === "notion" ? renderRef?.(record) : undefined;
    return `<skill><name>${xml(hostName(record))}</name><description>${xml(record.description)}</description><location>${xml(shortRef || (record.metadataIndexPath ?? record.path))}</location>${!shortRef && record.ref ? `<ref>${xml(record.ref)}</ref>` : ""}</skill>`;
  }).join("\n");
  const routes = routers.map(record => {
    const shortRef = record.source === "notion" ? renderRef?.(record) : undefined;
    return `<router ref="${xml(shortRef || (record.ref ?? record.path))}"><name>${xml(record.name)}</name><description>${xml(record.description)}</description></router>`;
  }).join("\n");
  return `${prompt}\n\n<ntn-skills-view-catalog>\nThese are the current default discovery entries, not loaded Skill bodies. Read a selected entry by copying its exact location path or ref into the native read tool. Use skill_search for other metadata when that tool is available; a View is not an access restriction. Previously loaded bodies keep their selected snapshots.\n${states}${entries ? `\n<available_skills>\n${entries}\n</available_skills>` : ""}${routes ? `\n<available_routers>\n${routes}\n</available_routers>` : ""}\n</ntn-skills-view-catalog>`;
}
