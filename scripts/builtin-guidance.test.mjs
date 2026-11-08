import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCurrentBuiltinGuidance } from "./builtin-guidance.mjs";

test("ordinary bundled instructions select the current model rather than retained workflows", () => {
  for (const value of ["Keep legacy bindings", "Review a migration", "已迁移 Skill", "ctl sync upstream connect", "ctl sync local run", "ctl library migration review", "ctl operation resume ID", "JSON compatibility default"])
    assert.throws(() => assertCurrentBuiltinGuidance(value, "fixture"), /current library workflow/);
});

test("requirements, exact operations and honest failures are retained", () => {
  for (const value of ["compatibility: Node.js 22+", "Use ctl library sources prepare", "Preserve the original operation and reconcile", "Pinned historical content stays fixed", "Permission failure remains an error"])
    assert.doesNotThrow(() => assertCurrentBuiltinGuidance(value, "fixture"));
});
