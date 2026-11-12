import { resolve } from "node:path";
import { homedir } from "node:os";
import type { NotionViewState, SkillRecord } from "./types";

const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const xmlText = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const xmlAttr = (value: string) => xml(value).replaceAll("\r", "&#13;").replaceAll("\n", "&#10;").replaceAll("\t", "&#9;");
const unescape = (value: string) => value.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
const hostName = (record: SkillRecord) => (record.token ?? record.name).replace(/[^a-z0-9-]/g, "-");

type CatalogCard = { kind: "skill" | "router"; name: string; description?: string; source?: string; location?: string; ref?: string };

function catalogCard(card: CatalogCard): string {
  const attrs = [`name="${xmlAttr(card.name)}"`];
  if (card.location !== undefined) attrs.push(`location="${xmlAttr(card.location)}"`);
  if (card.ref !== undefined) attrs.push(`ref="${xmlAttr(card.ref)}"`);
  const open = `<card ${attrs.join(" ")}`;
  // A self-closing card omits the description. An empty element is an empty author description.
  return card.description === undefined ? `${open}/>` : `${open}>${xmlText(card.description)}</card>`;
}

function catalogGroups(cards: readonly CatalogCard[]): string {
  const groups: string[] = [];
  for (let index = 0; index < cards.length;) {
    const kind = cards[index]?.kind, source = cards[index]?.source;
    let end = index + 1;
    while (end < cards.length && cards[end]?.kind === kind && cards[end]?.source === source) end += 1;
    const sourceAttr = source !== undefined ? ` source="${xmlAttr(source)}"` : "";
    groups.push(`<group kind="${kind}"${sourceAttr}>\n${cards.slice(index, end).map(catalogCard).join("\n")}\n</group>`);
    index = end;
  }
  return groups.join("\n");
}

/** Remove only broker-owned metadata, preserving native Skill entries and other instructions. */
export function withoutViewMetadata(input: string, ownedPaths: ReadonlySet<string>, cwd = process.cwd()): string {
  return input
    .replace(/\n*<ntn-skills-view-catalog>[\s\S]*?<\/ntn-skills-view-catalog>/g, "")
    .replace(/\n*<ntn-skills-discovery\b[^>]*>[\s\S]*?<\/ntn-skills-discovery>/g, "")
    .replace(/<available_skills>[\s\S]*?<\/available_skills>/g, block => block.replace(/<skill>[\s\S]*?<\/skill>/g, entry => {
      const raw = /<location>\s*([^<]+)\s*<\/location>/.exec(entry)?.[1];
      if (!raw) return entry;
      const path = unescape(raw.trim());
      const expanded = path.startsWith("~/") ? homedir() + path.slice(1) : path;
      return ownedPaths.has(resolve(cwd, expanded)) ? "" : entry;
    }));
}

/** Rebuild only broker-owned metadata for this request, never conversation bodies. */
export function viewSystemPrompt(input: string | string[] | undefined, skills: readonly SkillRecord[], routers: readonly SkillRecord[], ownedPaths: ReadonlySet<string>, views: readonly NotionViewState[], cwd = process.cwd(), renderRef?: (record: SkillRecord) => string | undefined, listTool = "skill_search", notionNames = false, omitDescription?: (record: SkillRecord) => boolean): string {
  const prompt = withoutViewMetadata(Array.isArray(input) ? input.join("\n\n") : input ?? "", ownedPaths, cwd);
  if (!skills.length && !routers.length && !views.length) return prompt;
  const states = views.map(state => state.status === "ready"
    ? `<view source="${xml(state.sourceId)}" id="${xml(state.view.id)}" database="${xml(state.view.database_id)}" origin="${state.origin}" count="${[...skills, ...routers].filter(record => record.sourceId === state.sourceId).length}" partial="${state.partial}">${xml(state.view.name)}</view>`
    : `<view source="${xml(state.sourceId)}" origin="${state.origin}" status="${state.status}"${state.status === "error" ? ` code="${xml(state.code)}"` : ""}/>`).join("\n");
  const guidance = `Default Notion candidates. Inspect with read; use a Skill through the available use tool. Discover other authorized entries with ${listTool}. Previously loaded bodies keep their selected versions.`;
  if (!notionNames) {
    const entries = skills.map(record => {
      const shortRef = record.source === "notion" ? renderRef?.(record) : undefined;
      const description = omitDescription?.(record) ? "" : `<description>${xml(record.description)}</description>`;
      return `<skill><name>${xml(hostName(record))}</name>${description}<location>${xml(shortRef || (record.metadataIndexPath ?? record.path))}</location>${!shortRef && record.ref ? `<ref>${xml(record.ref)}</ref>` : ""}</skill>`;
    }).join("\n");
    const routes = routers.map(record => {
      const shortRef = record.source === "notion" ? renderRef?.(record) : undefined;
      const description = omitDescription?.(record) ? "" : `<description>${xml(record.description)}</description>`;
      return `<router ref="${xml(shortRef || (record.ref ?? record.path))}"><name>${xml(record.name)}</name>${description}</router>`;
    }).join("\n");
    return `${prompt}\n\n<ntn-skills-view-catalog>\n${guidance}\n${states}${entries ? `\n<available_skills>\n${entries}\n</available_skills>` : ""}${routes ? `\n<available_routers>\n${routes}\n</available_routers>` : ""}\n</ntn-skills-view-catalog>`;
  }
  const cards: CatalogCard[] = [
    ...skills.map((record): CatalogCard => {
      const shortRef = record.source === "notion" ? renderRef?.(record) : undefined;
      const namedSource = notionNames && record.source === "notion";
      const location = shortRef || (record.metadataIndexPath ?? record.path);
      return { kind: "skill", name: namedSource ? record.name : hostName(record),
        ...(omitDescription?.(record) ? {} : { description: record.description }),
        ...(namedSource && record.sourceId ? { source: record.sourceId } : {}),
        location, ...(!shortRef && record.ref ? { ref: record.ref } : {}) };
    }),
    ...routers.map((record): CatalogCard => {
      const shortRef = record.source === "notion" ? renderRef?.(record) : undefined;
      return { kind: "router", name: record.name, ...(omitDescription?.(record) ? {} : { description: record.description }),
        ref: shortRef || (record.ref ?? record.path) };
    }),
  ];
  const grouped = cards.length ? `\n<catalog-cards>\n${catalogGroups(cards)}\n</catalog-cards>` : "";
  return `${prompt}\n\n<ntn-skills-view-catalog>\n${guidance}\n${states}${grouped}\n</ntn-skills-view-catalog>`;
}
