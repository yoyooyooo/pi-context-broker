import { materializeGeneratedBundleSkills, GENERATED_BUNDLE_OWNER } from "../src/generated-bundle-skills.ts";

const [root, catalogA, catalogB] = process.argv.slice(2);
if (!root || !catalogA || !catalogB) throw new Error("usage: generated-bundle-lifecycle-worker <root> <catalog-a> <catalog-b>");
const bundles = [
  { name: "suite-a", normalizedName: "suite-a", path: catalogA },
  { name: "suite-b", normalizedName: "suite-b", path: catalogB },
];
const paths = materializeGeneratedBundleSkills({
  root,
  bundles,
  render: (record, identity) => [
    "---",
    `name: ${JSON.stringify(record.name)}`,
    "metadata:",
    "  context-broker-kind: bundle",
    `  context-broker-owner: ${GENERATED_BUNDLE_OWNER}`,
    `  context-broker-record-id: ${identity}`,
    "---",
    `<context-broker-record kind=\"bundle\" name=\"${record.name}\">v1</context-broker-record>`,
    "",
  ].join("\n"),
});
console.log(JSON.stringify(paths));
