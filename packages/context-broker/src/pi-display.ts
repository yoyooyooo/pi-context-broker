import { stripVTControlCharacters } from "node:util";

/** Labels are untrusted source text, never terminal instructions. */
export function singleLine(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/gu, " ").trim();
}
