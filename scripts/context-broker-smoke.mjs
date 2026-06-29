import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import YAML from "yaml";

const mod = await import("../src/index.ts");
const editorMod = await import("../src/pi-dollar-editor.ts");
const diagnosticsMod = await import("../src/diagnostics.ts");

async function listTextFiles(root) {
  const result = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /\.(ts|md|mjs|json|ya?ml)$/.test(entry.name)) result.push(path);
    }
  }
  await walk(root);
  return result.sort();
}

async function assertStandalonePluginSources() {
  const packageRoot = join(import.meta.dirname, "..");
  const oldName = ["skill", "invoker"].join("-");
  const forbidden = [
    ["agent", "kit"].join("-"),
    ["/Users", "yoyo"].join("/"),
    ["SKILL", "INVOKER"].join("_"),
    oldName,
    `<${oldName}`,
    `customType: "${oldName}"`,
  ];
  for (const file of await listTextFiles(packageRoot)) {
    const rel = file.slice(packageRoot.length + 1);
    const text = await readFile(file, "utf8");
    for (const marker of forbidden) {
      assert.equal(text.includes(marker), false, `standalone context-broker source must not contain ${marker}: ${rel}`);
    }
  }
}

async function writeSkill(root, dir, frontmatter, body = "Skill body") {
  const skillDir = join(root, dir);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
  return join(skillDir, "SKILL.md");
}

const temp = await mkdtemp(join(tmpdir(), "context-broker-"));
const originalEnv = {
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  PI_CONFIG_DIR: process.env.PI_CONFIG_DIR,
  CONTEXT_BROKER_CONFIG: process.env.CONTEXT_BROKER_CONFIG,
  CONTEXT_BROKER_HOST: process.env.CONTEXT_BROKER_HOST,
  CONTEXT_BROKER_ROOTS: process.env.CONTEXT_BROKER_ROOTS,
  HOME: process.env.HOME,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

try {
  await assertStandalonePluginSources();

  const designContextPath = await writeSkill(
    temp,
    "design-context",
    [
      "name: design-context",
      "description: High-level direction judgment",
      "autoload:",
      "  enabled: true",
      "  aliases:",
      "    - 设计上下文",
      "    - high level",
    ].join("\n"),
    "Design context fixture skill body",
  );

  const reviewPath = await writeSkill(
    temp,
    "review-context",
    [
      "name: review-context",
      "description: Review context",
      "autoload:",
      "  enabled: true",
      "  aliases:",
      "    - 设计评审",
    ].join("\n"),
    "Review context fixture skill body",
  );

  await writeSkill(
    temp,
    "plain",
    [
      "name: plain",
      "description: Plain skill not enabled",
    ].join("\n"),
    "Plain fixture skill body",
  );

  await writeSkill(
    temp,
    "folded",
    [
      "name: folded",
      "description: >-",
      "  Folded description",
      "  spans multiple lines",
    ].join("\n"),
    "Folded skill body",
  );

  await writeSkill(
    temp,
    "writing-great-skills",
    [
      "name: writing-great-skills",
      "description: Skill authoring reference",
    ].join("\n"),
    "Writing great skills body",
  );

  const collabDocPath = await writeSkill(
    temp,
    "docs-context",
    [
      "name: docs-context",
      "description: collab云文档：读取和编辑collab文档内容",
    ].join("\n"),
    "Docs context full body must not be injected by bundle",
  );
  const collabImPath = await writeSkill(
    temp,
    "chat-context",
    [
      "name: chat-context",
      "description: collab即时通讯：收发消息和管理群聊",
    ].join("\n"),
    "Chat context full body must not be injected by bundle",
  );
  const discoveryCatalogPath = join(temp, "context-broker-catalog.yaml");
  await writeFile(discoveryCatalogPath, YAML.stringify({
    version: 1,
    records: [
      {
        kind: "bundle",
        name: "collab-bundle",
        description: "collab协作上下文包",
        aliases: ["collab", "teamwork"],
        render: { type: "member-index" },
        policy: { memberBody: "read-before-use", scope: "members-only", prerequisites: ["docs-context"], fallback: ["chat-context"] },
        members: { include: ["docs-context", "chat-context"] },
      },
    ],
  }));

  process.env.CONTEXT_BROKER_ROOTS = temp;
  const registry = await mod.buildRegistry({ skillRoots: [temp] });
  const registryBySkillRoots = await mod.buildRegistry({ skillRoots: [temp] });
  assert.equal(registry.length, 2);
  assert.equal(registryBySkillRoots.length, 2);
  assert.ok(registry.some((skill) => skill.name === "design-context"));
  assert.ok(registry.some((skill) => skill.name === "review-context"));
  const designContextSkill = registry.find((skill) => skill.name === "design-context");
  assert.ok(designContextSkill);
  const hashedPayload = mod.buildInjectedPayload(designContextSkill, "design-context", { pathMode: "hash", logPaths: false });
  assert.match(String(hashedPayload.content), /path="sha256:[a-f0-9]{16}"/, "hash path mode must redact concrete file paths in payload XML");
  assert.match(String(hashedPayload.details.path), /^sha256:[a-f0-9]{16}$/, "hash path mode must redact concrete file paths in metadata");
  assert.doesNotMatch(String(hashedPayload.content), new RegExp(temp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "redacted payload must not leak the fixture root");
  const registryWithoutAutoloadGate = await mod.buildRegistry({ skillRoots: [temp], requireAutoload: false });
  assert.equal(registryWithoutAutoloadGate.length, 7);
  assert.ok(registryWithoutAutoloadGate.some((skill) => skill.name === "plain"));
  assert.equal(
    registryWithoutAutoloadGate.find((skill) => skill.name === "folded")?.description,
    "Folded description spans multiple lines",
  );
  const dollarRegistry = await mod.buildDollarRegistry({ skillRoots: [temp] });
  assert.ok(
    dollarRegistry.some((skill) => skill.name === "plain"),
    "$ lookup registry must include configured skills even without autoload frontmatter",
  );
  const invalidCatalogPath = join(temp, "invalid-context-broker-catalog.yaml");
  await writeFile(invalidCatalogPath, YAML.stringify({
    version: 1,
    records: [{ kind: "bundle", name: "invalid", members: { nope: ["docs-context"] } }],
  }));
  assert.throws(
    () => mod.readDiscoveryCatalog(invalidCatalogPath),
    /members must be an array or \{ include: string\[\] \}/,
    "catalog reader must reject invalid member shortcut objects",
  );

  const discoveryRegistry = await mod.buildDiscoveryRegistry({ skillRoots: [temp], discoveryCatalogs: [discoveryCatalogPath] });
  const collabBundle = discoveryRegistry.find((record) => record.kind === "bundle" && record.name === "collab-bundle");
  assert.ok(collabBundle, "discovery registry must include bundle records from configured catalogs");
  assert.equal(collabBundle.members.length, 2);
  assert.ok(discoveryRegistry.some((record) => record.kind === "skill" && record.name === "design-context"));
  const collabItems = mod.discoveryAutocompleteItems(discoveryRegistry, "collab");
  assert.equal(collabItems[0].label, "$collab-bundle [bundle]", "$ autocomplete must distinguish bundles from skills");
  assert.match(collabItems[0].description, /2 members/);
  const rootDiagnostics = await diagnosticsMod.collectRootDiagnostics([temp, join(temp, "missing-root")]);
  const rootText = diagnosticsMod.formatRootDiagnostics(rootDiagnostics);
  assert.match(rootText, /context-broker roots:/);
  assert.match(rootText, /ok\s+\d+\s+custom/);
  assert.match(rootText, /missing\s+0\s+custom/);
  const findText = diagnosticsMod.formatFindDiagnostics("fold", registryWithoutAutoloadGate, registryWithoutAutoloadGate);
  assert.match(findText, /\$folded/);
  assert.match(findText, /Folded description spans multiple lines/);

  const configAgentDir = join(temp, "agent-dir");
  const configDir = join(configAgentDir, "context-broker");
  await mkdir(join(configDir, "rules"), { recursive: true });
  await writeFile(join(configDir, "config.yml"), `skillRoots:\n  - ${JSON.stringify(temp)}\nrequireAutoload: false\n`);
  await writeFile(join(configDir, "rules", "design-context.yml"), [
    "id: design-context",
    "inject: design-context",
    "match:",
    "  - exact:",
    "      - 打开设计上下文",
    "  - regex:",
    "      - '^\\s*从设计上下文视角看.+$'",
    "  - contains:",
    "      - 设计上下文",
    "    regex:",
    "      - '评审'",
    "    not:",
    "      - contains:",
    "          - 不要注入",
  ].join("\n"));
  delete process.env.CONTEXT_BROKER_CONFIG;
  delete process.env.CONTEXT_BROKER_CONFIG;
  delete process.env.CONTEXT_BROKER_HOST;
  process.env.PI_CODING_AGENT_DIR = configAgentDir;
  assert.equal(mod.defaultAgentDir(), configAgentDir);
  assert.deepEqual(mod.defaultAgentDirs(), [configAgentDir]);
  assert.equal(mod.defaultConfigPath(), join(configDir, "config.yml"));
  assert.deepEqual(mod.resolveConfigPaths(), [join(configDir, "config.yml")]);
  assert.equal(mod.resolveConfigPath(), join(configDir, "config.yml"));
  assert.deepEqual(mod.readConfig().skillRoots, [temp]);
  assert.equal(mod.readConfig().requireAutoload, false);
  assert.deepEqual(mod.ruleRootsForConfig(join(configDir, "config.yml"), {}), [join(configDir, "rules")]);
  assert.deepEqual(mod.listRuleConfigFiles([join(configDir, "rules")]), [
    join(configDir, "rules", "design-context.yml"),
  ]);
  const configWithRuleDir = mod.readConfig();
  assert.deepEqual(configWithRuleDir.rules.find((rule) => rule.id === "design-context")?.inject, ["design-context"]);
  assert.equal(configWithRuleDir.rules.find((rule) => rule.id === "design-context")?.match.length, 3);

  const jsonOnlyAgentDir = join(temp, "json-agent-dir");
  await mkdir(join(jsonOnlyAgentDir, "context-broker"), { recursive: true });
  await writeFile(join(jsonOnlyAgentDir, "context-broker", "config.json"), JSON.stringify({ skillRoots: [join(temp, "json-only-root")] }));
  process.env.PI_CODING_AGENT_DIR = jsonOnlyAgentDir;
  assert.equal(mod.defaultConfigPath(), join(jsonOnlyAgentDir, "context-broker", "config.json"));
  assert.deepEqual(mod.readConfig().skillRoots, [join(temp, "json-only-root")]);

  const explicitConfigPath = join(temp, "explicit-context-broker.yaml");
  await mkdir(join(temp, "rules"), { recursive: true });
  await writeFile(join(temp, "rules", "design-context-explicit.yml"), [
    "id: design-context-explicit",
    "inject: design-context",
    "match:",
    "  - regex:",
    "      - '^\\s*显式设计上下文\\s*$'",
  ].join("\n"));
  await writeFile(explicitConfigPath, `skillRoots:\n  - ${JSON.stringify(join(temp, "explicit-root"))}\nruleRoots:\n  - ${JSON.stringify(join(temp, "rules"))}\n`);
  process.env.CONTEXT_BROKER_CONFIG = explicitConfigPath;
  assert.equal(mod.resolveConfigPath(), explicitConfigPath);
  assert.deepEqual(mod.resolveConfigPaths(), [explicitConfigPath]);
  assert.deepEqual(mod.readConfig().skillRoots, [join(temp, "explicit-root")]);
  assert.ok(mod.readConfig().rules.some((rule) => rule.id === "design-context-explicit"));
  delete process.env.CONTEXT_BROKER_CONFIG;
  delete process.env.CONTEXT_BROKER_CONFIG;
  delete process.env.PI_CODING_AGENT_DIR;

  const fakeHome = join(temp, "fake-home");
  const fakePiAgentDir = join(fakeHome, ".pi", "agent");
  const fakeOmpAgentDir = join(fakeHome, ".omp", "agent");
  await mkdir(join(fakePiAgentDir, "context-broker"), { recursive: true });
  await mkdir(join(fakeOmpAgentDir, "context-broker"), { recursive: true });
  await writeFile(join(fakePiAgentDir, "context-broker", "config.yml"), [
    "skillRoots:",
    `  - ${JSON.stringify(join(temp, "pi-root"))}`,
  ].join("\n"));
  await writeFile(join(fakeOmpAgentDir, "context-broker", "config.yml"), [
    "skillRoots:",
    `  - ${JSON.stringify(join(temp, "omp-root"))}`,
  ].join("\n"));
  process.env.HOME = fakeHome;
  delete process.env.PI_CONFIG_DIR;
  assert.deepEqual(mod.defaultAgentDirs(), [fakePiAgentDir, fakeOmpAgentDir]);
  assert.deepEqual(mod.resolveConfigPaths(), [
    join(fakePiAgentDir, "context-broker", "config.yml"),
    join(fakeOmpAgentDir, "context-broker", "config.yml"),
  ]);
  const mergedConfig = mod.readConfig();
  assert.deepEqual(mergedConfig.skillRoots, [join(temp, "pi-root"), join(temp, "omp-root")]);
  process.env.CONTEXT_BROKER_HOST = "omp";
  assert.deepEqual(mod.defaultAgentDirs(), [fakeOmpAgentDir]);
  assert.deepEqual(mod.readConfig().skillRoots, [join(temp, "omp-root")]);
  delete process.env.CONTEXT_BROKER_HOST;
  process.env.PI_CODING_AGENT_DIR = configAgentDir;

  assert.deepEqual(mod.parseInvocation("skill:design-context", [{
    id: "x",
    match: [{ regex: [{ pattern: "^\\s*skill[:：]\\s*(?<query>.+?)\\s*$" }] }],
  }]), {
    query: "design-context",
    ruleId: "x",
  });
  assert.deepEqual(mod.parseInvocation("打开设计上下文", configWithRuleDir.rules), {
    query: "design-context",
    ruleId: "design-context",
  });
  assert.deepEqual(mod.parseInvocation("从设计上下文视角看这个方案", configWithRuleDir.rules), {
    query: "design-context",
    ruleId: "design-context",
  });
  assert.deepEqual(mod.parseInvocation("请用设计上下文评审这个方案", configWithRuleDir.rules), {
    query: "design-context",
    ruleId: "design-context",
  });
  assert.equal(
    mod.parseInvocation("请用设计上下文评审这个方案，不要注入", configWithRuleDir.rules),
    undefined,
    "not predicate must suppress a positive match",
  );
  assert.deepEqual(mod.parseInvocation("$plain please use this", mod.configuredRules({})), {
    query: "plain",
    ruleId: "dollar-skill",
  });
  assert.deepEqual(
    mod.parseInvocations("$plain $design-context", mod.configuredRules({})).map((request) => request.query),
    ["plain", "design-context"],
    "dollar trigger must collect all skill tokens in one message",
  );
  assert.deepEqual(
    mod.parseInvocations("$plain，$design-context。请一起使用", mod.configuredRules({})).map((request) => request.query),
    ["plain", "design-context"],
    "dollar trigger must collect pasted skill tokens separated by punctuation",
  );
  assert.deepEqual(
    mod.parseInvocations("请用（$plain）和【$design-context】一起看", mod.configuredRules({})).map((request) => request.query),
    ["plain", "design-context"],
    "dollar trigger must support bracket-delimited independent tokens",
  );

  const notifications = [];
  const injectedTurn = await mod.invokeBeforeAgentStart(
    { prompt: "skill:design-context" },
    {
      hasUI: true,
      ui: { notify: (message, type) => notifications.push({ message, type }) },
      sessionManager: { getEntries: () => [] },
    },
    Promise.resolve(registry),
    {},
  );
  assert.ok(injectedTurn?.message);
  assert.equal(injectedTurn.message.customType, mod.CUSTOM_TYPE);
  assert.match(String(injectedTurn.message.content), /Design context fixture skill body/);
  assert.deepEqual(notifications, [{ message: "context-broker: injected design-context", type: "info" }]);

  const injected = await mod.invokeForContext(
    { messages: [{ role: "user", content: "skill:design-context" }] },
    Promise.resolve(registry),
    {},
  );
  assert.ok(injected?.messages);
  assert.equal(injected.messages.length, 2);
  assert.equal(injected.messages[1].role, "custom");
  assert.equal(injected.messages[1].customType, mod.CUSTOM_TYPE);

  const reinjected = await mod.invokeForContext(
    { messages: injected.messages },
    Promise.resolve(registry),
    {},
  );
  assert.equal(reinjected, undefined, "same context must not receive duplicate injected marker");

  const alreadyPluginLoaded = await mod.invokeForContext(
    {
      messages: [
        { role: "user", content: "skill:design-context" },
        {
          role: "custom",
          customType: mod.CUSTOM_TYPE,
          content: "already loaded",
          details: { name: "design-context", path: designContextPath },
        },
      ],
    },
    Promise.resolve(registry),
    {},
  );
  assert.equal(alreadyPluginLoaded, undefined, "plugin marker must prevent reinjection");

  notifications.length = 0;
  const alreadyInSessionHistory = await mod.invokeBeforeAgentStart(
    { prompt: "skill:design-context" },
    {
      hasUI: true,
      ui: { notify: (message, type) => notifications.push({ message, type }) },
      sessionManager: {
        getEntries: () => [
          {
            type: "custom_message",
            customType: mod.CUSTOM_TYPE,
            content: "already loaded",
            details: { name: "design-context", path: designContextPath },
          },
        ],
      },
    },
    Promise.resolve(registry),
    {},
  );
  assert.equal(alreadyInSessionHistory, undefined, "session history marker must prevent next-turn reinjection");
  assert.deepEqual(
    notifications,
    [{ message: "context-broker: already loaded design-context", type: "info" }],
    "already-loaded skip must show a UI-only notice",
  );

  notifications.length = 0;
  const siblingBranchMarker = await mod.invokeBeforeAgentStart(
    { prompt: "skill:design-context" },
    {
      hasUI: true,
      ui: { notify: (message, type) => notifications.push({ message, type }) },
      sessionManager: {
        buildSessionContext: () => ({ messages: [] }),
        getEntries: () => [
          {
            type: "custom_message",
            customType: mod.CUSTOM_TYPE,
            content: "loaded on another branch",
            details: { name: "design-context", path: designContextPath },
          },
        ],
      },
    },
    Promise.resolve(registry),
    {},
  );
  assert.ok(siblingBranchMarker?.message, "markers outside the active branch must not prevent injection");
  assert.match(String(siblingBranchMarker.message.content), /Design context fixture skill body/);
  assert.deepEqual(notifications, [{ message: "context-broker: injected design-context", type: "info" }]);

  const alreadyBuiltinLoaded = await mod.invokeForContext(
    {
      messages: [
        { role: "user", content: "skill:design-context" },
        {
          role: "custom",
          customType: mod.BUILTIN_SKILL_PROMPT_TYPE,
          content: "already loaded",
          details: { name: "design-context", path: designContextPath },
        },
      ],
    },
    Promise.resolve(registry),
    {},
  );
  assert.equal(alreadyBuiltinLoaded, undefined, "built-in skill-prompt marker must prevent reinjection");

  const alreadyRecordLoaded = await mod.invokeForContext(
    {
      messages: [
        { role: "custom", customType: mod.CUSTOM_TYPE, content: '<context-broker-record kind="skill" name="design-context" path="/tmp/design-context/SKILL.md">body</context-broker-record>' },
        { role: "user", content: "skill:design-context" },
      ],
    },
    Promise.resolve(registry),
    {},
  );
  assert.equal(alreadyRecordLoaded, undefined, "context-broker XML block must prevent reinjection");

  const aliasInjected = await mod.invokeForContext(
    { messages: [{ role: "user", content: "使用 设计上下文 skill" }] },
    Promise.resolve(registry),
    {},
  );
  assert.ok(aliasInjected?.messages);

  const descriptionInjected = await mod.invokeForContext(
    { messages: [{ role: "user", content: "skill:High-level direction judgment" }] },
    Promise.resolve(registry),
    {},
  );
  assert.ok(descriptionInjected?.messages);

  const dollarInjected = await mod.invokeForContext(
    { messages: [{ role: "user", content: "$plain please use this" }] },
    Promise.resolve(registry),
    {},
    Promise.resolve(registryWithoutAutoloadGate),
  );
  assert.ok(dollarInjected?.messages);
  assert.match(String(dollarInjected.messages.at(-1).content), /Plain fixture skill body/);

  const multiDollarInjected = await mod.invokeForContext(
    { messages: [{ role: "user", content: "$plain $design-context" }] },
    Promise.resolve(registry),
    {},
    Promise.resolve(registryWithoutAutoloadGate),
  );
  assert.ok(multiDollarInjected?.messages);
  const multiDollarMessage = multiDollarInjected.messages.at(-1);
  assert.match(String(multiDollarMessage.content), /Plain fixture skill body/);
  assert.match(String(multiDollarMessage.content), /Design context fixture skill body/);
  assert.deepEqual(multiDollarMessage.details.records.map((skill) => skill.name), ["plain", "design-context"]);

  const bundleDollarInjected = await mod.invokeForContext(
    { messages: [{ role: "user", content: "$collab-bundle 查明天会议并发消息" }] },
    Promise.resolve(registry),
    { discoveryCatalogs: [discoveryCatalogPath] },
    Promise.resolve(discoveryRegistry),
  );
  assert.ok(bundleDollarInjected?.messages, "bundle dollar trigger must inject member index");
  const bundleMessage = bundleDollarInjected.messages.at(-1);
  assert.match(String(bundleMessage.content), /<context-broker-record kind="bundle" name="collab-bundle"/);
  assert.match(String(bundleMessage.content), /<policy memberBody="read-before-use" scope="members-only">/);
  assert.match(String(bundleMessage.content), /<prerequisites>\n<member>docs-context<\/member>\n<\/prerequisites>/);
  assert.match(String(bundleMessage.content), /<member name="docs-context"/);
  assert.match(String(bundleMessage.content), /<member name="chat-context"/);
  assert.doesNotMatch(String(bundleMessage.content), /Docs context full body must not be injected by bundle/);
  assert.deepEqual(bundleMessage.details.records.map((record) => [record.kind, record.name]), [["bundle", "collab-bundle"]]);

  const pastedDollarInjected = await mod.invokeForContext(
    { messages: [{ role: "user", content: "$plain，$design-context。请一起使用" }] },
    Promise.resolve(registry),
    {},
    Promise.resolve(registryWithoutAutoloadGate),
  );
  assert.ok(pastedDollarInjected?.messages);
  assert.deepEqual(
    pastedDollarInjected.messages.at(-1).details.records.map((skill) => skill.name),
    ["plain", "design-context"],
    "pasted punctuation-delimited dollar triggers must inject all skills",
  );

  const fuzzyNamedInvocation = await mod.invokeForContext(
    { messages: [{ role: "user", content: "skill:wriskill" }] },
    Promise.resolve(registryWithoutAutoloadGate),
    {},
    Promise.resolve(registryWithoutAutoloadGate),
  );
  assert.equal(fuzzyNamedInvocation, undefined, "non-dollar named triggers must not fuzzy inject");

  const fuzzyDollarInjected = await mod.invokeForContext(
    { messages: [{ role: "user", content: "$wriskill" }] },
    Promise.resolve(registry),
    {},
    Promise.resolve(registryWithoutAutoloadGate),
  );
  assert.ok(fuzzyDollarInjected?.messages, "fuzzy dollar trigger must inject a unique high-confidence match");
  assert.match(String(fuzzyDollarInjected.messages.at(-1).content), /Writing great skills body/);
  assert.deepEqual(fuzzyDollarInjected.messages.at(-1).details.records.map((skill) => skill.name), ["writing-great-skills"]);

  const dollarMissing = await mod.invokeForContext(
    { messages: [{ role: "user", content: "$missing-skill" }] },
    Promise.resolve(registry),
    {},
    Promise.resolve(registryWithoutAutoloadGate),
  );
  assert.equal(dollarMissing, undefined, "unknown dollar skill must fail closed");

  const duplicateGlobal = {
    ...registryWithoutAutoloadGate.find((skill) => skill.name === "plain"),
    path: join(temp, "plain-copy", "SKILL.md"),
    normalizedName: "plain",
  };
  const dollarAmbiguous = await mod.invokeForContext(
    { messages: [{ role: "user", content: "$plain" }] },
    Promise.resolve(registry),
    {},
    Promise.resolve([...registryWithoutAutoloadGate, duplicateGlobal]),
  );
  assert.equal(dollarAmbiguous, undefined, "ambiguous dollar skill must fail closed");

  const baseAutocompleteProvider = {
    async getSuggestions() {
      return {
        items: [{ value: "fallback", label: "fallback" }],
        prefix: "",
      };
    },
    applyCompletion(lines, cursorLine, cursorCol) {
      return { lines, cursorLine, cursorCol };
    },
    shouldTriggerFileCompletion() {
      return true;
    },
  };
  const autocompleteProvider = mod.createDollarSkillAutocompleteProvider(
    baseAutocompleteProvider,
    Promise.resolve(dollarRegistry),
  );
  const autocompleteSignal = new AbortController().signal;
  const dollarSuggestions = await autocompleteProvider.getSuggestions(["use $pl"], 0, "use $pl".length, {
    signal: autocompleteSignal,
  });
  assert.equal(dollarSuggestions.prefix, "$pl");
  assert.ok(
    dollarSuggestions.items.some((item) => item.value === "$plain" && item.label === "$plain [skill]"),
    "dollar autocomplete must suggest matching skills",
  );
  const foldedSuggestions = await autocompleteProvider.getSuggestions(["$fold"], 0, "$fold".length, {
    signal: autocompleteSignal,
  });
  const foldedItem = foldedSuggestions.items.find((item) => item.value === "$folded");
  assert.match(foldedItem?.description ?? "", /Folded description spans multiple lines/);
  const typoDollarSuggestions = await autocompleteProvider.getSuggestions(["$wriskill"], 0, "$wriskill".length, {
    signal: autocompleteSignal,
  });
  assert.equal(
    typoDollarSuggestions.items[0]?.value,
    "$writing-great-skills",
    "dollar autocomplete must fuzzy-rank compressed typo queries such as wriskill",
  );
  const allDollarSuggestions = await autocompleteProvider.getSuggestions(["$"], 0, 1, {
    signal: autocompleteSignal,
  });
  assert.ok(allDollarSuggestions.items.length >= 3, "bare dollar must list available skills");
  assert.equal(
    await autocompleteProvider.getSuggestions(["use $plain "], 0, "use $plain ".length, {
      signal: autocompleteSignal,
    }),
    null,
    "dollar autocomplete must close instead of delegating after the token is followed by space",
  );
  assert.equal(
    await autocompleteProvider.getSuggestions(["use foo$pl"], 0, "use foo$pl".length, {
      signal: autocompleteSignal,
    }),
    null,
    "dollar autocomplete must only trigger for an independent token",
  );
  const dollarCompletion = autocompleteProvider.applyCompletion(
    ["use $pl"],
    0,
    "use $pl".length,
    { value: "$plain", label: "$plain", description: "Plain skill not enabled" },
    "$pl",
  );
  assert.equal(dollarCompletion.lines[0], "use $plain ");
  assert.equal(dollarCompletion.cursorCol, "use $plain ".length);

  const commandConfigPath = join(temp, "context-broker-config.yml");
  await writeFile(commandConfigPath, [
    "skillRoots:",
    `  - ${JSON.stringify(temp)}`,
    "discoveryCatalogs:",
    `  - ${JSON.stringify(discoveryCatalogPath)}`,
    "requireAutoload: false",
  ].join("\n"));
  process.env.CONTEXT_BROKER_CONFIG = commandConfigPath;
  const registeredCommands = new Map();
  mod.default({
    on() {},
    registerCommand(name, command) {
      registeredCommands.set(name, command);
    },
  });
  assert.ok(registeredCommands.has("context-broker"), "/context-broker command must be registered");
  const commandNotifications = [];
  await registeredCommands.get("context-broker").handler("doctor", {
    cwd: temp,
    hasUI: true,
    ui: { notify: (message, type) => commandNotifications.push({ message, type }) },
  });
  assert.match(commandNotifications.at(-1).message, /Context Broker Doctor/);
  assert.match(commandNotifications.at(-1).message, /collab-bundle/);
  assert.match(commandNotifications.at(-1).message, /no discovery namespace collisions/);
  commandNotifications.length = 0;
  await registeredCommands.get("context-broker").handler("explain collab-bundle", {
    cwd: temp,
    hasUI: true,
    ui: { notify: (message, type) => commandNotifications.push({ message, type }) },
  });
  assert.match(commandNotifications.at(-1).message, /kind: bundle/);
  assert.match(commandNotifications.at(-1).message, /members: 2/);

  assert.equal(editorMod.isDollarAutocompleteContext("$"), true);
  assert.equal(editorMod.isDollarAutocompleteContext("use $cr"), true);
  assert.equal(editorMod.isDollarAutocompleteContext("use $plain "), false);
  assert.equal(editorMod.isDollarAutocompleteContext("foo$pl"), false);

  class FakeEditor {
    state = { lines: [""], cursorLine: 0, cursorCol: 0 };
    triggerCount = 0;
    showing = false;
    handleInput(data) {
      if (data === "\x1b" || data === "\x7f") return;
      const line = this.state.lines[0];
      this.state.lines[0] = line.slice(0, this.state.cursorCol) + data + line.slice(this.state.cursorCol);
      this.state.cursorCol += data.length;
    }
    isShowingAutocomplete() {
      return this.showing;
    }
    tryTriggerAutocomplete() {
      this.triggerCount += 1;
    }
  }
  const fakeEditor = editorMod.wrapDollarAutocompleteEditor(new FakeEditor());
  fakeEditor.handleInput("$");
  assert.equal(fakeEditor.triggerCount, 1, "typing bare dollar must trigger autocomplete");
  fakeEditor.showing = true;
  fakeEditor.handleInput("c");
  assert.equal(fakeEditor.triggerCount, 1, "active autocomplete should update through base editor, not retrigger wrapper");
  fakeEditor.showing = false;
  fakeEditor.handleInput("r");
  assert.equal(fakeEditor.triggerCount, 2, "typing in an independent dollar token should retrigger after cancelled autocomplete");

  const fakeEditorAfterSpace = editorMod.wrapDollarAutocompleteEditor(new FakeEditor());
  fakeEditorAfterSpace.state.lines[0] = "$plain";
  fakeEditorAfterSpace.state.cursorCol = "$plain".length;
  fakeEditorAfterSpace.handleInput(" ");
  assert.equal(fakeEditorAfterSpace.triggerCount, 0, "space after dollar skill token must close autocomplete");

  const fakeEditorEmbedded = editorMod.wrapDollarAutocompleteEditor(new FakeEditor());
  fakeEditorEmbedded.state.lines[0] = "foo";
  fakeEditorEmbedded.state.cursorCol = "foo".length;
  fakeEditorEmbedded.handleInput("$");
  assert.equal(fakeEditorEmbedded.triggerCount, 0, "embedded foo$ token must not trigger autocomplete");

  const fakeEditorEscape = editorMod.wrapDollarAutocompleteEditor(new FakeEditor());
  fakeEditorEscape.state.lines[0] = "$";
  fakeEditorEscape.state.cursorCol = 1;
  fakeEditorEscape.handleInput("\x1b");
  assert.equal(fakeEditorEscape.triggerCount, 0, "escape must be able to cancel dollar autocomplete");

  let installedFactory;
  const installed = await editorMod.installPiDollarAutocompleteEditor({
    ui: {
      getEditorComponent: () => () => new FakeEditor(),
      setEditorComponent: (factory) => {
        installedFactory = factory;
      },
    },
  });
  assert.equal(installed, true);
  assert.equal(typeof installedFactory, "function");
  const installedEditor = installedFactory({}, {}, {});
  installedEditor.handleInput("$");
  assert.equal(installedEditor.triggerCount, 1, "installed editor factory must wrap dollar autocomplete");

  const multiConfig = {
    rules: [{
      id: "big-review",
      inject: ["design-context", "review-context", "design-context"],
      match: [{ exact: ["设计上下文架构评审"] }],
    }, {
      id: "design-review-alias",
      inject: ["review-context"],
      match: [{ exact: ["设计上下文架构评审"] }],
    }],
  };
  assert.deepEqual(mod.parseInvocations("设计上下文架构评审", mod.configuredRules(multiConfig)).map((request) => request.query), [
    "design-context",
    "review-context",
    "design-context",
    "review-context",
  ]);
  const multiInjected = await mod.invokeForContext(
    { messages: [{ role: "user", content: "设计上下文架构评审" }] },
    Promise.resolve(registry),
    multiConfig,
  );
  assert.ok(multiInjected?.messages);
  const multiMessage = multiInjected.messages.at(-1);
  assert.equal(multiMessage.customType, mod.CUSTOM_TYPE);
  assert.match(String(multiMessage.content), /Design context fixture skill body/);
  assert.match(String(multiMessage.content), /Review context fixture skill body/);
  assert.equal(multiMessage.details.records.length, 2, "same-turn duplicate inject entries must collapse by skill");
  assert.deepEqual(multiMessage.details.records.map((skill) => skill.name), ["design-context", "review-context"]);

  const multiReinjected = await mod.invokeForContext(
    { messages: multiInjected.messages },
    Promise.resolve(registry),
    multiConfig,
  );
  assert.equal(multiReinjected, undefined, "multi-skill message details must prevent duplicate reinjection");

  const partialMultiInjected = await mod.invokeForContext(
    {
      messages: [
        { role: "user", content: "设计上下文架构评审" },
        {
          role: "custom",
          customType: mod.CUSTOM_TYPE,
          content: "already loaded design-context",
          details: {
            records: [{ kind: "skill", name: "design-context", path: designContextPath, sourcePath: designContextPath }],
            injectedBy: mod.CUSTOM_TYPE,
          },
        },
      ],
    },
    Promise.resolve(registry),
    multiConfig,
  );
  assert.ok(partialMultiInjected?.messages);
  const partialMessage = partialMultiInjected.messages.at(-1);
  assert.doesNotMatch(String(partialMessage.content), /Design context fixture skill body/);
  assert.match(String(partialMessage.content), /Review context fixture skill body/);
  assert.deepEqual(partialMessage.details.records.map((skill) => skill.name), ["review-context"]);

  const multiTurnNotifications = [];
  const alreadyMultiInSessionHistory = await mod.invokeBeforeAgentStart(
    { prompt: "设计上下文架构评审" },
    {
      hasUI: true,
      ui: { notify: (message, type) => multiTurnNotifications.push({ message, type }) },
      sessionManager: {
        getEntries: () => [
          {
            type: "custom_message",
            customType: mod.CUSTOM_TYPE,
            content: "already loaded",
            details: {
              records: [
                { kind: "skill", name: "design-context", path: designContextPath, sourcePath: designContextPath },
                { kind: "skill", name: "review-context", path: reviewPath, sourcePath: reviewPath },
              ],
              injectedBy: mod.CUSTOM_TYPE,
            },
          },
        ],
      },
    },
    Promise.resolve(registry),
    multiConfig,
  );
  assert.equal(alreadyMultiInSessionHistory, undefined, "session history multi-skill marker must prevent reinjection");
  assert.deepEqual(multiTurnNotifications, [{
    message: "context-broker: already loaded design-context, review-context",
    type: "info",
  }]);

  const partialMultiTurnNotifications = [];
  const partialMultiBeforeAgentStart = await mod.invokeBeforeAgentStart(
    { prompt: "设计上下文架构评审" },
    {
      hasUI: true,
      ui: { notify: (message, type) => partialMultiTurnNotifications.push({ message, type }) },
      sessionManager: {
        getEntries: () => [
          {
            type: "custom_message",
            customType: mod.CUSTOM_TYPE,
            content: "already loaded design-context",
            details: {
              records: [{ kind: "skill", name: "design-context", path: designContextPath, sourcePath: designContextPath }],
              injectedBy: mod.CUSTOM_TYPE,
            },
          },
        ],
      },
    },
    Promise.resolve(registry),
    multiConfig,
  );
  assert.ok(partialMultiBeforeAgentStart?.message);
  assert.deepEqual(partialMultiTurnNotifications, [{
    message: "context-broker: injected review-context; already loaded design-context",
    type: "info",
  }]);

  const noInvocation = await mod.invokeForContext(
    { messages: [{ role: "user", content: "我可能需要 design-context 吗？" }] },
    Promise.resolve(registry),
    {},
  );
  assert.equal(noInvocation, undefined);

  const duplicate = {
    ...designContextSkill,
    name: "design-context-copy",
    path: join(temp, "copy", "SKILL.md"),
    normalizedName: "design-context",
  };
  const ambiguous = mod.matchSkill("design-context", [designContextSkill, duplicate]);
  assert.equal(ambiguous.decision, "skip");
  assert.equal(ambiguous.reason, "ambiguous");

  console.log("context-broker smoke ok");
} finally {
  restoreEnv();
  await rm(temp, { recursive: true, force: true });
}
