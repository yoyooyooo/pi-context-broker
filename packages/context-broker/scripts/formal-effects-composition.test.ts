import { test, expect } from "bun:test";
import { combineConsumptionEffects, noConsumptionWrites, type ConsumptionEffects } from "../src/consumption-effects";

const first: ConsumptionEffects = Object.freeze({
  version: 1, remote_writes: "retained", author_content: "unchanged",
  retention: Object.freeze([Object.freeze({ skill_page_id: "root", file_id: "body", operation_id: "original-op", status: "confirmed" as const })]),
});
const later: ConsumptionEffects = {
  version: 1, remote_writes: "retained", author_content: "unchanged",
  retention: [{ skill_page_id: "dependency", file_id: "body", operation_id: "second-op", status: "confirmed" }],
};

test("two acquisitions preserve the first receipt through none, unknown and later retained effects", () => {
  const cases: { later: ConsumptionEffects | undefined; writes: string; author: string; retention: unknown[] }[] = [
    { later: noConsumptionWrites(), writes: "retained", author: "unchanged", retention: [...first.retention] },
    { later: undefined, writes: "unknown", author: "unknown", retention: [...first.retention] },
    { later: { version: 1, remote_writes: "unknown", author_content: "unchanged", retention: [] },
      writes: "unknown", author: "unchanged", retention: [...first.retention] },
    { later, writes: "retained", author: "unchanged", retention: [...first.retention, ...later.retention] },
  ];
  const original = JSON.stringify(first);
  for (const item of cases) expect(combineConsumptionEffects([first, item.later])).toEqual({
    version: 1, remote_writes: item.writes, author_content: item.author, retention: item.retention,
  });
  expect(JSON.stringify(first)).toBe(original);
});

test("retention identity includes source, file and original operation without losing unknown status", () => {
  const receipts: ConsumptionEffects[] = [
    first,
    { version: 1, remote_writes: "retained", author_content: "unchanged", retention: [
      { skill_page_id: "other-root", file_id: "body", operation_id: "original-op", status: "confirmed" },
      { skill_page_id: "root", file_id: "other-file", operation_id: "original-op", status: "confirmed" },
      { skill_page_id: "root", file_id: "body", operation_id: "independent-op", status: "confirmed" },
    ] },
    { version: 1, remote_writes: "unknown", author_content: "unchanged", retention: [
      { skill_page_id: "root", file_id: "body", operation_id: "original-op", status: "unknown" },
    ] },
    first,
  ];
  expect(combineConsumptionEffects(receipts)).toEqual({
    version: 1, remote_writes: "unknown", author_content: "unchanged", retention: [
      { skill_page_id: "root", file_id: "body", operation_id: "original-op", status: "unknown" },
      { skill_page_id: "other-root", file_id: "body", operation_id: "original-op", status: "confirmed" },
      { skill_page_id: "root", file_id: "other-file", operation_id: "original-op", status: "confirmed" },
      { skill_page_id: "root", file_id: "body", operation_id: "independent-op", status: "confirmed" },
    ],
  });
  expect(first.retention[0]?.status).toBe("confirmed");
});

