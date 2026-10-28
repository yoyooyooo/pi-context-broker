import { Effect, Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Command } from "effect/cli";

// These imports resolve to the selected source checkout while compiling this fixture.
import { listCommand } from "naming-cli-content";
import { Notion } from "naming-cli-notion";
import { Store } from "naming-cli-store";
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "naming-cli-fixtures";

const database = "12345678-1234-1234-1234-123456789abc";
const dataSource = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const names = ["Tty7", "n8n-workflow", "React19", "中文", "  Two   Words  ", "name@scope/ref", "name%40scope%2Fref", "Same Alias", "Same Alias", "--option", "A_B", "Café", "Café", "dot.name"];
const rows = names.map((name, index) => ({
  id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
  properties: {
    Name: { type: "title", title: [{ plain_text: name }] },
    Description: { rich_text: [{ plain_text: `Naming producer row ${index}` }] },
  },
}));
const api = Layer.succeed(Notion, {
  version: Effect.succeed("fixture"),
  credentialIdentity: Effect.succeed("naming-contract-fixture"),
  request: (path: string) => {
    if (path === "v1/users/me") return Effect.succeed({ id: "naming-user", object: "user" });
    if (path === "v1/search") return Effect.succeed({ results: [{ id: dataSource, parent: { database_id: database }, title: [{ plain_text: "Naming" }], database_type: "skills" }], has_more: false, next_cursor: null });
    if (path === `v1/data_sources/${dataSource}/query`) return Effect.succeed({ results: rows, has_more: false, next_cursor: null });
    return Effect.die(new Error(`Unexpected naming producer request: ${path}`));
  },
});
const memory = Layer.succeed(Store, {
  integrity: integrityRepositoryFixture(), upstream: upstreamRepositoryFixture(),
  registerBindingWithBase: () => Effect.die(new Error("Unused binding transaction")),
  advanceBaseAndReceipt: () => Effect.die(new Error("Unused baseline transaction")),
  backup: () => Effect.die(new Error("Unused backup")),
  root: "/unused", configRoot: "/unused", cacheRoot: "/unused",
  reserveCacheGeneration: () => Effect.succeed(1),
  listKeys: () => Effect.succeed([]), retireKeys: () => Effect.succeed([]),
  readJson: () => Effect.succeed(undefined), writeJson: () => Effect.void,
  readBytes: () => Effect.die(new Error("Unused bytes")), writeBytes: () => Effect.void,
  output: () => Effect.die(new Error("Unused output")),
});
await Effect.runPromise(Command.runWith(listCommand, { version: "naming-contract" })(process.argv.slice(2).filter(argument => argument !== "list").concat("--refresh")).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, api, memory))));
