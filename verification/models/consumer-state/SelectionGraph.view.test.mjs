import assert from "node:assert/strict";
import test from "node:test";
import { state } from "./SelectionGraph.view.mjs";

test("statechart's 1-based TLA sequence does not turn a valid selected graph into a broken label", () => {
  const input = { violations: new Set(), committed: true, done: true, scenario: "valid", selected: { 1: 2, 2: 1 } };
  assert.match(state(input), /已提交新固定组合/);
  assert.doesNotMatch(state(input), /违例|BROKEN/);
  assert.match(state({ ...input, selected: { 1: 2, 2: 2 } }), /违例：根 pin 覆盖了依赖 pin/);
});
