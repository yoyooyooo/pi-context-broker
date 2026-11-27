export const DOLLAR_SKILL_PATTERN = "(?:^|[^\\w\\\\$])\\$(?<query>[^\\s$]+?)(?=$|[\\s,，。!！？?；;、:：)）\\]】}]|\\.+(?=$|[\\s,，。!！？?；;、:：)）\\]】}]))";

// Invocation syntax belongs to prose, not Markdown code or escaped examples.
// Preserve newlines so anchored configurable rules keep their original boundaries.
export function invocationText(text: string): string {
  const lines = text.split(/(?<=\n)/);
  let fence: { marker: string; length: number } | undefined;
  const prose = lines.map(line => {
    const delimiter = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(line);
    if (fence) {
      if (delimiter && delimiter[1]![0] === fence.marker && delimiter[1]!.length >= fence.length && !delimiter[2]!.trim()) fence = undefined;
      return line.replace(/[^\r\n]/g, " ");
    }
    if (delimiter && (delimiter[1]![0] === "~" || !delimiter[2]!.includes("`"))) {
      fence = { marker: delimiter[1]![0]!, length: delimiter[1]!.length };
      return line.replace(/[^\r\n]/g, " ");
    }
    return line;
  }).join("");
  return prose.replace(/\\[\s\S]|(`+)([\s\S]*?)\1(?!`)/g, (match, ticks: string | undefined) => {
    // An escaped backslash leaves the following dollar available for invocation.
    return ticks || match === "\\$" || match === "\\`" ? match.replace(/[^\r\n]/g, " ") : match;
  });
}

/** Only literal invocation syntax in this accepted input grants management intent.
 * Configurable rule injections and quoted examples remain ordinary consumers. */
export function explicitDollarQueries(text: string): ReadonlySet<string> {
  const prose = invocationText(text).replace(/^(?: {0,3}>| {4}|\t).*$/gm, "");
  return new Set([...prose.matchAll(new RegExp(DOLLAR_SKILL_PATTERN, "g"))]
    .flatMap(match => {
      const query = match.groups?.query;
      if (!query) return [];
      // Unmatched shell variables and amounts remain ordinary text. A user can
      // disambiguate a same-named Skill through its explicit source or UI token.
      const qualified = query.includes("@") || query.includes("/");
      return !qualified && (/^[A-Z_][A-Z0-9_]*$/.test(query) || /^\d+(?:\.\d+)*$/.test(query) || query.startsWith("{")) ? [] : [query];
    }));
}
