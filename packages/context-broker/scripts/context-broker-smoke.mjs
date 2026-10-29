import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import YAML from "yaml";

const mod = await import("../src/index.ts");
const editorMod = await import("../src/pi-dollar-editor.ts");
const diagnosticsMod = await import("../src/diagnostics.ts");
const discoveryMod = await import("../src/discovery-records.ts");
const dollarMod = await import("../src/dollar.ts");
const builtinMod = await import("../src/bundled-builtins.ts");
const configuredOnly = records => records.filter(record => !builtinMod.isBundledBuiltin(record));
const hostSkillsMod = await import("../src/host-skills.ts");
const ompAdapterMod = await import("../src/omp-host-adapter.ts");
const piAdapterMod = await import("../src/pi-host-adapter.ts");


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
  NTN_SKILLS_DATA_HOME: process.env.NTN_SKILLS_DATA_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
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
  process.env.HOME = join(temp, "isolated-home");
  process.env.XDG_DATA_HOME = join(temp, "isolated-data");
  delete process.env.NTN_SKILLS_DATA_HOME;
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
    "Docs context full body must not be injected by router",
  );
  const collabImPath = await writeSkill(
    temp,
    "chat-context",
    [
      "name: chat-context",
      "description: collab即时通讯：收发消息和管理群聊",
    ].join("\n"),
    "Chat context full body must not be injected by router",
  );
  const discoveryCatalogPath = join(temp, "context-broker-catalog.yaml");
  await writeFile(discoveryCatalogPath, YAML.stringify({
    version: 1,
    records: [
      {
        kind: "router",
        name: "collab-router",
        description: "collab协作上下文包",
        aliases: ["collab", "teamwork"],
        render: { type: "member-index" },
        policy: { memberBody: "read-before-use", scope: "members-only", prerequisites: ["docs-context"], fallback: ["chat-context"] },
        members: { include: ["docs-context", "chat-context"] },
      },
      {
        kind: "router",
        name: "docs-context",
        description: "Router retains a distinct identity beside a same-name Skill",
        members: { include: ["docs-context", "chat-context"] },
      },
    ],
  }));

  process.env.CONTEXT_BROKER_ROOTS = temp;
  const registry = await mod.buildRegistry({ skillRoots: [temp] });
  const registryBySkillRoots = await mod.buildRegistry({ skillRoots: [temp] });
  assert.equal(configuredOnly(registry).length, 2);
  assert.equal(configuredOnly(registryBySkillRoots).length, 2);
  assert.ok(registry.some((skill) => skill.name === "design-context"));
  assert.ok(registry.some((skill) => skill.name === "review-context"));
  const designContextSkill = registry.find((skill) => skill.name === "design-context");
  assert.ok(designContextSkill);
  const hashedPayload = mod.buildInjectedPayload(designContextSkill, "design-context", { pathMode: "hash", logPaths: false }, ompAdapterMod.createOmpHostAdapter({ pi: {} }));
  assert.match(String(hashedPayload.content), /path="sha256:[a-f0-9]{16}"/, "hash path mode must redact concrete file paths in payload XML");
  assert.match(String(hashedPayload.details.path), /^sha256:[a-f0-9]{16}$/, "hash path mode must redact concrete file paths in metadata");
  assert.doesNotMatch(String(hashedPayload.content), new RegExp(temp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "redacted payload must not leak the fixture root");
  const registryWithoutAutoloadGate = await mod.buildRegistry({ skillRoots: [temp], requireAutoload: false });
  assert.equal(configuredOnly(registryWithoutAutoloadGate).length, 7);
  assert.ok(registryWithoutAutoloadGate.some((skill) => skill.name === "plain"));
  assert.equal(
    registryWithoutAutoloadGate.find((skill) => skill.name === "folded")?.description,
    "Folded description spans multiple lines",
  );
  const { records: dollarRegistry } = await mod.buildDollarRegistry({ skillRoots: [temp] });
  assert.ok(
    dollarRegistry.some((skill) => skill.name === "plain"),
    "$ lookup registry must include configured skills even without autoload frontmatter",
  );
  const invalidCatalogPath = join(temp, "invalid-context-broker-catalog.yaml");
  await writeFile(invalidCatalogPath, YAML.stringify({
    version: 1,
    records: [{ kind: "router", name: "invalid", members: { nope: ["docs-context"] } }],
  }));
  assert.throws(
    () => mod.readDiscoveryCatalog(invalidCatalogPath),
    /members must be an array or \{ include: string\[\] \}/,
    "catalog reader must reject invalid member shortcut objects",
  );

  const { records: discoveryRegistry } = await mod.buildDiscoveryRegistry({ skillRoots: [temp], discoveryCatalogs: [discoveryCatalogPath] });
  const collabRouter = discoveryRegistry.find((record) => record.kind === "router" && record.name === "collab-router");
  assert.ok(collabRouter, "discovery registry must include router records from configured catalogs");
  assert.equal(collabRouter.members.length, 2);
  assert.ok(discoveryRegistry.some((record) => record.kind === "skill" && record.name === "design-context"));
  const collabItems = mod.discoveryAutocompleteItems(discoveryRegistry, "collab");
  assert.equal(collabItems[0].label, "$collab-router [router]", "$ autocomplete must distinguish routers from skills");
  assert.match(collabItems[0].description, /2 members/);
  const docsDollarRegistry = await dollarMod.buildDollarRegistryForContext(
    { getSystemPrompt: () => "" },
    Promise.resolve(discoveryRegistry),
  );
  assert.deepEqual(
    docsDollarRegistry.filter((record) => record.name === "docs-context").map((record) => record.kind),
    ["skill", "router"],
    "same-name Router and Skill retain distinct selectable identities",
  );
  assert.equal(
    discoveryMod.validateDiscoveryRecords(discoveryRegistry).some((error) => error.includes('name collision: skill "docs-context"')),
    false,
    "Identity-qualified candidates remain independently selectable",
  );
  const opencliRouter = { ...collabRouter, name: "opencli", normalizedName: "opencli" };
  const openclawSkill = {
    ...registryWithoutAutoloadGate.find((record) => record.name === "plain"),
    kind: "skill",
    name: "openclaw-docs-search",
    normalizedName: "openclaw-docs-search",
  };
  assert.equal(
    mod.discoveryAutocompleteItems([openclawSkill, opencliRouter], "opencl")[0].label,
    "$opencli [router]",
    "matching router must win score ties over skills",
  );
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

  await writeFile(join(configDir, "rules", "scene-routers.yml"), [
    "version: 1",
    "rules:",
    "  - id: scene-coding",
    "    inject:",
    "      - router:scene-coding",
    "    match:",
    "      - contains:",
    "          - 编码场景",
    "  - id: scene-research",
    "    inject:",
    "      - router:scene-research",
    "    match:",
    "      - exact:",
    "          - 加载研究上下文",
  ].join("\n"));
  const configWithMultiRuleFile = mod.readConfig();
  assert.deepEqual(
    configWithMultiRuleFile.rules.filter((rule) => rule.id.startsWith("scene-")).map((rule) => rule.id),
    ["scene-coding", "scene-research"],
    "one generated rule file must load every declared scene rule",
  );

  const routerRule = {
    id: "collab-keywords",
    inject: ["router:collab-router"],
    match: [{ exact: ["打开协作上下文"] }],
  };
  assert.deepEqual(mod.parseInvocations("打开协作上下文", [routerRule]), [{
    query: "collab-router",
    ruleId: "collab-keywords",
    matchIndex: 0,
    scope: "catalog",
  }]);

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

  const loadedDesign = registry.find(record => record.name === "design-context");
  assert.ok(loadedDesign);
  const alreadyRecordLoaded = await mod.invokeForContext(
    {
      messages: [
        { role: "custom", customType: mod.CUSTOM_TYPE, content: "Design context fixture skill body", details: { records: [{ identity: discoveryMod.recordIdentity(loadedDesign), kind: "skill", loaded: true }] } },
        { role: "user", content: "skill:design-context" },
      ],
    },
    Promise.resolve(registry),
    {},
  );
  assert.equal(alreadyRecordLoaded, undefined, "current stable Skill identity receipt must prevent reinjection");
  assert.equal(mod.hasLoadedSkill([{ role: "custom", customType: mod.CUSTOM_TYPE, content: "Router index", details: { records: [{ identity: discoveryMod.recordIdentity(collabRouter), kind: "router", loaded: true }] } }], collabRouter), true, "current stable Router identity receipt must prevent reinjection");
  const loadedPrompt = { ...loadedDesign, kind: "prompt" };
  assert.equal(mod.hasLoadedSkill([{ role: "custom", customType: mod.CUSTOM_TYPE, content: "previous Prompt task", details: { records: [{ identity: discoveryMod.recordIdentity(loadedPrompt), kind: "prompt", loaded: true }] } }], loadedPrompt), false, "Prompt history must never suppress the next explicit invocation");
  const historicalXml = await mod.invokeForContext(
    { messages: [{ role: "custom", customType: mod.CUSTOM_TYPE, content: '<context-broker-record kind="skill" name="design-context" path="/tmp/design-context/SKILL.md">body</context-broker-record>' }, { role: "user", content: "skill:design-context" }] },
    Promise.resolve(registry), {},
  );
  assert.match(String(historicalXml?.messages?.at(-1)?.content), /Design context fixture skill body/, "historical XML without exact identity or path requires explicit conversion and cannot suppress current loading");

  for (const role of ["user", "assistant", "toolResult", "custom"]) {
    const example = {
      role,
      customType: role === "custom" ? "other-extension" : undefined,
      content: '<context-broker-record kind="skill" name="design-context">example only</context-broker-record>',
    };
    const requested = await mod.invokeForContext(
      { messages: [example, { role: "user", content: "$design-context" }] },
      Promise.resolve(registry),
      {},
      Promise.resolve(registry),
    );
    assert.match(String(requested?.messages?.at(-1)?.content), /Design context fixture skill body/, `${role} XML examples must not suppress actual skill loading`);
    const beforeStart = await mod.invokeBeforeAgentStart(
      { prompt: "$design-context" },
      { sessionManager: { buildSessionContext: () => ({ messages: [example] }) } },
      Promise.resolve(registry),
      {},
      Promise.resolve(registry),
    );
    assert.match(String(beforeStart?.message?.content), /Design context fixture skill body/, `${role} XML examples must not suppress submit-time skill loading`);
  }

  const sameNameRouterMarker = await mod.invokeForContext(
    { messages: [
      { role: "custom", customType: mod.CUSTOM_TYPE, content: '<context-broker-record kind="router" name="design-context">router index</context-broker-record>' },
      { role: "user", content: "$design-context" },
    ] },
    Promise.resolve(registry),
    {},
    Promise.resolve(registry),
  );
  assert.match(String(sameNameRouterMarker?.messages?.at(-1)?.content), /Design context fixture skill body/, "a same-name router must not suppress skill loading");

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

  const routerDollarInjected = await mod.invokeForContext(
    { messages: [{ role: "user", content: "$collab-router 查明天会议并发消息" }] },
    Promise.resolve(registry),
    { discoveryCatalogs: [discoveryCatalogPath] },
    Promise.resolve(discoveryRegistry),
  );
  assert.ok(routerDollarInjected?.messages, "router dollar trigger must inject member index");
  const routerMessage = routerDollarInjected.messages.at(-1);
  assert.match(String(routerMessage.content), /<context-broker-record kind="router" name="collab-router"/);
  assert.match(String(routerMessage.content), /<policy memberBody="read-before-use" scope="members-only">/);
  assert.match(String(routerMessage.content), /<prerequisites>\n<member>docs-context<\/member>\n<\/prerequisites>/);
  assert.match(String(routerMessage.content), /<member name="docs-context"/);
  assert.match(String(routerMessage.content), /<member name="chat-context"/);
  assert.doesNotMatch(String(routerMessage.content), /Docs context full body must not be injected by router/);
  assert.deepEqual(routerMessage.details.records.map((record) => [record.kind, record.name]), [["router", "collab-router"]]);

  const routerRuleInjected = await mod.invokeForContext(
    { messages: [{ role: "user", content: "打开协作上下文" }] },
    Promise.resolve(registry),
    { rules: [routerRule], discoveryCatalogs: [discoveryCatalogPath] },
    Promise.resolve(discoveryRegistry),
  );
  assert.ok(routerRuleInjected?.messages, "router:<name> rule target must inject a catalog router index");
  assert.match(String(routerRuleInjected.messages.at(-1).content), /<context-broker-record kind="router" name="collab-router"/);
  assert.doesNotMatch(String(routerRuleInjected.messages.at(-1).content), /Docs context full body must not be injected by router/);

  const sameNameRouterRuleInjected = await mod.invokeForContext(
    { messages: [{ role: "user", content: "打开同名协作上下文" }] },
    Promise.resolve(registryWithoutAutoloadGate),
    {
      rules: [{ id: "same-name-router", inject: ["router:docs-context"], match: [{ exact: ["打开同名协作上下文"] }] }],
      discoveryCatalogs: [discoveryCatalogPath],
    },
    Promise.resolve(discoveryRegistry),
  );
  assert.deepEqual(
    sameNameRouterRuleInjected?.messages?.at(-1)?.details?.records?.map((record) => [record.kind, record.name]),
    [["router", "docs-context"]],
    "router:<name> must select the router when a skill has the same name",
  );

  const duplicateRouterRulesInjected = await mod.invokeForContext(
    { messages: [{ role: "user", content: "打开重复协作上下文" }] },
    Promise.resolve(registry),
    {
      rules: [
        { id: "router-one", inject: ["router:collab-router"], match: [{ contains: ["重复协作"] }] },
        { id: "router-two", inject: ["router:collab-router"], match: [{ contains: ["重复协作"] }] },
      ],
    },
    Promise.resolve(discoveryRegistry),
  );
  assert.equal(duplicateRouterRulesInjected?.messages?.at(-1)?.details?.records?.length, 1, "duplicate router matches must dedupe to one injection");
  assert.deepEqual(duplicateRouterRulesInjected?.messages?.at(-1)?.details?.records?.[0]?.ruleIds, ["router-one", "router-two"]);

  const unknownRouterRuleInjected = await mod.invokeForContext(
    { messages: [{ role: "user", content: "打开未知上下文" }] },
    Promise.resolve(registry),
    { rules: [{ id: "unknown-router", inject: ["router:missing-router"], match: [{ exact: ["打开未知上下文"] }] }] },
    Promise.resolve(discoveryRegistry),
  );
  assert.equal(unknownRouterRuleInjected, undefined, "unknown router rule target must fail closed");

  const alreadyRouterLoaded = await mod.invokeForContext(
    { messages: [...routerRuleInjected.messages, { role: "user", content: "打开协作上下文" }] },
    Promise.resolve(registry),
    { rules: [routerRule] },
    Promise.resolve(discoveryRegistry),
  );
  assert.equal(alreadyRouterLoaded, undefined, "loaded router marker must prevent rule reinjection");

  const hashedRouterRuleInjected = await mod.invokeForContext(
    { messages: [{ role: "user", content: "打开协作上下文" }] },
    Promise.resolve(registry),
    { rules: [routerRule], pathMode: "hash" },
    Promise.resolve(discoveryRegistry),
  );
  assert.match(String(hashedRouterRuleInjected?.messages?.at(-1)?.content), /path="sha256:[a-f0-9]{16}"/);
  assert.doesNotMatch(String(hashedRouterRuleInjected?.messages?.at(-1)?.content), new RegExp(temp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "router rule injection must preserve path privacy");

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
  await mod.default({
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
  assert.match(commandNotifications.at(-1).message, /collab-router/);
  assert.match(commandNotifications.at(-1).message, /Namespace: failed/);
  assert.match(commandNotifications.at(-1).message, /name collision: skill "docs-context" conflicts with router "docs-context"/, "doctor must expose the raw same-name collision instead of hiding either record");
  const doctorCandidates = mod.discoveryAutocompleteItems(discoveryRegistry, "docs-context").filter(item => item.label.includes("docs-context"));
  assert.equal(doctorCandidates.length, 2, "both same-name Skill and Router remain selectable");
  assert.deepEqual(new Set(doctorCandidates.map(item => item.kind)), new Set(["skill", "router"]));
  assert.equal(new Set(doctorCandidates.map(item => item.identity)).size, 2);
  assert.equal(new Set(doctorCandidates.map(item => item.value)).size, 2, "Same-name Skill and Router offer distinct exact identities");
  for (const candidate of doctorCandidates) {
    const match = mod.matchDiscoveryRecord(candidate.value.slice(1), discoveryRegistry);
    assert.equal(match.decision, "inject");
    assert.equal(discoveryMod.recordIdentity(match.record), candidate.identity);
  }
  assert.equal(mod.matchDiscoveryRecord("docs-context", discoveryRegistry).reason, "ambiguous");
  assert.equal(mod.matchDiscoveryRecord("docs-context@local", discoveryRegistry).reason, "ambiguous");
  commandNotifications.length = 0;
  await registeredCommands.get("context-broker").handler("explain collab-router", {
    cwd: temp,
    hasUI: true,
    ui: { notify: (message, type) => commandNotifications.push({ message, type }) },
  });
  assert.match(commandNotifications.at(-1).message, /kind: router/);
  assert.match(commandNotifications.at(-1).message, /members: 2/);

  assert.equal(editorMod.isDollarAutocompleteContext("$"), true);
  assert.equal(editorMod.isDollarAutocompleteContext("use $cr"), true);
  assert.equal(editorMod.isDollarAutocompleteContext("use $plain "), false);

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
  }, editor => editor);
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

  delete process.env.CONTEXT_BROKER_ROOTS;
  const linkFixtures = join(temp, "link-fixtures");
  const sourceRoot = join(linkFixtures, "source");
  const globalRoot = join(linkFixtures, "global");
  const sourceSkill = await writeSkill(sourceRoot, "group/linked", "name: linked\ndescription: Linked skill\nautoload:\n  enabled: true");
  await mkdir(globalRoot, { recursive: true });
  await symlink(join(sourceRoot, "group/linked"), join(globalRoot, "linked"), "dir");
  await symlink(globalRoot, join(sourceRoot, "group/linked", "cycle"), "dir");
  await symlink(join(linkFixtures, "absent"), join(globalRoot, "dangling"), "dir");
  await mkdir(join(globalRoot, "file-link"));
  await writeFile(join(linkFixtures, "file-skill.md"), "---\nname: file-linked\n---\nFile linked body\n");
  await symlink(join(linkFixtures, "file-skill.md"), join(globalRoot, "file-link/SKILL.md"), "file");

  const { records: linkedRegistry } = await mod.buildDollarRegistry({ skillRoots: [globalRoot, sourceRoot] });
  assert.equal(linkedRegistry.filter((skill) => skill.name === "linked").length, 1);
  assert.equal(linkedRegistry.find((skill) => skill.name === "linked")?.path, join(globalRoot, "linked/SKILL.md"));
  assert.equal(linkedRegistry.find((skill) => skill.name === "file-linked")?.path, join(globalRoot, "file-link/SKILL.md"));
  const { records: sourceFirst } = await mod.buildDollarRegistry({ skillRoots: [sourceRoot, globalRoot] });
  assert.equal(sourceFirst.find((skill) => skill.name === "linked")?.path, sourceSkill);
  const boundedLinks = await mod.buildRegistry({ skillRoots: [globalRoot], requireAutoload: false, scan: { maxDepth: 20 } });
  assert.equal(configuredOnly(boundedLinks).length, 2, "cycle must not re-scan ancestor directories");
  assert.equal(configuredOnly((await mod.buildDollarRegistry({ skillRoots: [globalRoot], scan: { maxDepth: 0 } })).records).length, 0);
  assert.equal(configuredOnly((await mod.buildDollarRegistry({ skillRoots: [globalRoot], scan: { ignore: ["linked", "file-link"] } })).records).length, 0);
  assert.equal(configuredOnly((await mod.buildDollarRegistry({ skillRoots: [globalRoot], scan: { maxSkillBytes: 1 } })).records).length, 0);
  assert.deepEqual(configuredOnly(await mod.buildRegistry({ skillRoots: [globalRoot], requireAutoload: true })).map((skill) => skill.name), ["linked"]);
  const linkInjection = await mod.invokeForContext(
    { messages: [{ role: "user", content: "$linked" }] },
    Promise.resolve([]), { pathMode: "absolute" }, Promise.resolve(linkedRegistry),
  );
  assert.equal(linkInjection?.messages.at(-1)?.details.path, join(globalRoot, "linked/SKILL.md"));
  assert.equal(dollarMod.dollarAutocompleteItems(linkedRegistry, "linked").filter((item) => item.value === "$linked").length, 1);
  const configuredLinks = await mod.buildRegistry({ skillRoots: [globalRoot, sourceRoot], requireAutoload: false });
  assert.equal(configuredLinks.filter((skill) => skill.name === "linked").length, 1);
  const configuredInjection = await mod.invokeForContext(
    { messages: [{ role: "user", content: "skill: linked" }] },
    Promise.resolve(configuredLinks), { pathMode: "absolute" },
  );
  assert.equal(configuredInjection?.messages.at(-1)?.details.path, join(globalRoot, "linked/SKILL.md"));

  // Exercise the external process boundary, not source-text wiring.
  const sourcesMod = await import("../src/sources.ts");
  assert.throws(() => sourcesMod.normalizeSources([{ type: "notion", id: "bad", command: [] }]), { code: "SOURCE_CONFIG_INVALID" });
  assert.throws(() => sourcesMod.normalizeSources([{ type: "notion", id: "bad", discovery: { maxAge: "1.5h" } }]), { code: "SOURCE_CONFIG_INVALID" });
  assert.throws(() => sourcesMod.normalizeSources([{ type: "notion", id: "bad" }, { type: "notion", id: "bad" }]), { code: "SOURCE_CONFIG_INVALID" });
  assert.deepEqual(await sourcesMod.discoverSources({ sources: [{ type: "notion", id: "disabled", enabled: false, command: "/missing-disabled-executable" }] }), []);
  await assert.rejects(sourcesMod.discoverSources({ sources: [{ type: "notion", id: "missing", command: join(temp, "absent-command") }] }), { code: "SOURCE_COMMAND_UNAVAILABLE" });
  const adapterFixture = join(temp, "source-negative-fixture.mjs");
  await writeFile(adapterFixture, `
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
const [mode, log, ...args] = process.argv.slice(2);
await appendFile(log, JSON.stringify(args) + '\\n');
const scope = 'a'.repeat(64), snapshot = 's_' + (mode === 'renamed' ? 'e' : 'b').repeat(64);
const db = '00000000-0000-4000-8000-000000000010';
const ds = '00000000-0000-4000-8000-000000000020';
const makeSkill = id => ({id:'notion_page:'+id, kind:'skill', locator:{type:'notion_page',page_id:id,database_id:db,data_source_id:ds}, entrypoint:'SKILL.md', name:'Source Skill', alias:'source-skill', description:'source fixture', ref:'skill://' + id + '/SKILL.md', default_context:mode === 'flagged'});
const item = makeSkill('00000000-0000-4000-8000-000000000001');
if (mode === 'unknown-kind') item.kind = 'bundle';
if (mode === 'missing-kind') delete item.kind;
if (mode === 'bad-locator') item.locator.page_id = 'not-a-page';
if (mode === 'missing-default') delete item.default_context;
if (mode === 'renamed' && args[0] !== 'list') { item.name = 'Renamed Source Skill'; item.alias = 'renamed-source-skill'; item.description = 'Renamed description'; }
if (mode === 'page-drift' && args[0] === 'read') Object.assign(item, makeSkill('00000000-0000-4000-8000-000000000099'));
if (mode === 'read-locator' && args[0] === 'read') item.locator.data_source_id = '00000000-0000-4000-8000-000000000099';
const fresh = {policy:'default',validated_at:new Date(0).toISOString(),age_ms:0,max_age_ms:60000,stale:false};
if (mode === 'timeout') {
  await new Promise(resolve => setTimeout(resolve, Number(process.env.NTN_SKILLS_REQUEST_TIMEOUT_MS ?? 30000)));
  console.log(JSON.stringify({ok:false,error:{code:'NTN_UNAVAILABLE',details:{reason:'timeout'}}}));
  process.exitCode = 1;
} else if (mode === 'cancel') {
  const descendant = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
  await appendFile(log, JSON.stringify({child:descendant.pid}) + '\\n');
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (mode === 'malformed') console.log('{');
else if (mode === 'secret') {
  console.error('Bearer SUPER_SECRET_TOKEN https://private.example/?secret=SUPER_SECRET_TOKEN');
  console.log(JSON.stringify({ok:false,error:{code:'ACCESS_DENIED',message:'SUPER_SECRET_TOKEN',details:{token:'SUPER_SECRET_TOKEN'}}}));
  process.exitCode = 1;
} else if (args[0] === 'list') {
  const coverage = {method:'explicit_database',exhaustive:true,queried_data_sources:[ds],failed_sources:[],search_index_limited:false};
  if (mode === 'incomplete') { coverage.exhaustive=false; coverage.failed_sources.push({id:ds,code:'ACCESS_DENIED'}); }
  const skills = mode === 'duplicate' ? [item,makeSkill('00000000-0000-4000-8000-000000000002')] : [item];
  console.log(JSON.stringify({ok:true,scope,fetched_at:0,databases:[{database_id:db,title:'Fixture',alias:'fixture',data_source_ids:[ds]}],...(mode === 'legacy-catalog' ? {skills} : {records:skills}),count:skills.length,coverage,source:'notion',freshness:fresh}));
} else if (args[0] === 'read') {
  console.log(JSON.stringify({ok:true,scope:mode==='scope-drift'?'c'.repeat(64):scope,record:item,entrypoint:'SKILL.md',snapshot_id:snapshot,version_id:'v1',path:'SKILL.md',ref:item.ref+'?snapshot='+snapshot,source:'notion',freshness:fresh,content:'portable body',range:{start:1,end:1,total_lines:1},has_more:mode==='partial-read'}));
} else if (args[0] === 'export') {
  if (mode === 'export-kind') item.kind = 'router';
  if (mode === 'export-locator') item.locator.database_id = '00000000-0000-4000-8000-000000000099';
  const output = args[args.indexOf('--output')+1];
  const main = mode === 'traversal' ? '../escape.md' : 'SKILL.md';
  const files = mode === 'entry-conflict' ? {'SKILL.md':'different body'} : {'SKILL.md':'portable body','references/guide.md':'resource guide'};
  files['.ntn-skills.json'] = JSON.stringify({format:'ntn-skills',version:mode === 'manifest-version' ? 1 : 2,kind:'skill',name:item.name,description:item.description,main});
  for (const [path,body] of Object.entries(files)) { await mkdir(join(output,path,'..'),{recursive:true}); await writeFile(join(output,path),body); }
  if (mode === 'missing-resource') await writeFile(join(output,'references/guide.md'), '');
  console.log(JSON.stringify({ok:true,scope:mode === 'export-scope' ? 'f'.repeat(64) : scope,record:item,entrypoint:mode === 'export-entry' ? 'OTHER.md' : 'SKILL.md',snapshot_id:snapshot,version_id:mode === 'export-version' ? 'v2' : 'v1',ref:item.ref+'?snapshot='+snapshot,source:'local_snapshot',freshness:{policy:'pinned'},operation:'export',projection:mode === 'source-projection' ? 'source' : args[args.indexOf('--projection')+1],format:'directory',output,reused:false,content_id:'d'.repeat(64),main_path:main,files:Object.entries(files).map(([path,body])=>({path,bytes:Buffer.byteLength(body),hash:mode === 'hash-bad' ? '0'.repeat(64) : createHash('sha256').update(body).digest('hex'),role:path === main ? 'entrypoint' : path === '.ntn-skills.json' ? 'manifest' : 'resource'}))}));
}
`);
  function adapterConfig(mode, requestTimeoutMs = 5000) {
    return { sources: [{ type: "notion", id: "fixture", command: [process.execPath, adapterFixture, mode, join(temp, `source-${mode}.jsonl`)], cacheDir: join(temp, "source-cache"), database: "fixture", requestTimeoutMs }] };
  }
  const partialDirectory = await sourcesMod.discoverSources(adapterConfig("incomplete"));
  assert.ok(partialDirectory.length > 0, "Valid exact records survive unrelated partial discovery");
  assert.equal(partialDirectory.failures[0].code, "CATALOG_INCOMPLETE");
  assert.equal(partialDirectory.failures[0].blocking, false);
  for (const [mode, code] of [["malformed", "SOURCE_RESPONSE_INVALID"], ["unknown-kind", "SOURCE_RESPONSE_INVALID"], ["missing-kind", "SOURCE_RESPONSE_INVALID"], ["bad-locator", "SOURCE_RESPONSE_INVALID"], ["missing-default", "SOURCE_RESPONSE_INVALID"], ["legacy-catalog", "SOURCE_RESPONSE_INVALID"], ["secret", "ACCESS_DENIED"]]) {
    await assert.rejects(sourcesMod.discoverSources(adapterConfig(mode)), (error) => error.code === code && !JSON.stringify(error).includes("SUPER_SECRET_TOKEN") && !error.message.includes("SUPER_SECRET_TOKEN"));
  }
  const duplicateSources = await sourcesMod.discoverSources(adapterConfig("duplicate"));
  assert.equal(duplicateSources.length, 2);
  assert.equal(new Set(duplicateSources.map((record) => record.token)).size, 2);
  assert.equal(duplicateSources[0].body, undefined);
  assert.match(duplicateSources[0].token, /^fixture\/source-skill@/);
  assert.doesNotMatch(await readFile(duplicateSources[0].path, "utf8"), /portable body/);
  for (const [mode, code] of [["scope-drift", "SOURCE_IDENTITY_MISMATCH"], ["page-drift", "SOURCE_IDENTITY_MISMATCH"], ["read-locator", "SOURCE_IDENTITY_MISMATCH"], ["partial-read", "SOURCE_RESPONSE_INVALID"], ["traversal", "SOURCE_RESPONSE_INVALID"], ["entry-conflict", "SOURCE_EXPORT_INCOMPLETE"], ["missing-resource", "SOURCE_EXPORT_INCOMPLETE"], ["hash-bad", "SOURCE_EXPORT_INCOMPLETE"], ["manifest-version", "SOURCE_PORTABLE_FORMAT_UNSUPPORTED"], ["source-projection", "SOURCE_EXPORT_PROJECTION_INVALID"], ["export-kind", "SOURCE_RESPONSE_INVALID"], ["export-locator", "SOURCE_RESPONSE_INVALID"], ["export-scope", "SOURCE_RESPONSE_INVALID"], ["export-entry", "SOURCE_RESPONSE_INVALID"], ["export-version", "SOURCE_RESPONSE_INVALID"]]) {
    const config = adapterConfig(mode);
    const [record] = await sourcesMod.discoverSources(config);
    await assert.rejects(sourcesMod.loadSourceSkill(record, config), { code });
  }
  const sourceGoodConfig = adapterConfig("good");
  const [sourceMetadata] = await sourcesMod.discoverSources(sourceGoodConfig);
  assert.equal(sourceMetadata.defaultDiscovery, undefined, "Full catalog metadata does not decide the active View");
  assert.equal(sourceMetadata.default_context, false);
  assert.equal((await sourcesMod.discoverSources(adapterConfig("unchecked")))[0].default_context, false);
  assert.equal((await sourcesMod.discoverSources(adapterConfig("flagged")))[0].default_context, true);
  assert.equal((await sourcesMod.discoverSources(adapterConfig("flagged")))[0].defaultDiscovery, undefined);
  for (const kind of ["omp", "pi"]) {
    const nativeEvents = new Map();
    const api = {
      ...(kind === "omp" ? { pi: {} } : {}),
      on(name, handler) { nativeEvents.set(name, [...(nativeEvents.get(name) ?? []), handler]); },
      registerCommand() {},
    };
    const flagged = { ...sourceMetadata, defaultDiscovery: true };
    const explicit = { ...sourceMetadata, name: "explicit", token: "fixture/explicit", id: "explicit", defaultDiscovery: false, metadataIndexPath: join(temp, `native-${kind}`, "explicit", "SKILL.md"), path: join(temp, `native-${kind}`, "explicit", "SKILL.md") };
    let selected = [flagged, explicit];
    const adapter = kind === "omp" ? ompAdapterMod.createOmpHostAdapter(api) : piAdapterMod.createPiHostAdapter(api);
    let prepared;
    const native = await hostSkillsMod.installHostSkills(api, { config: sourceGoodConfig, getRecords: async () => ({ records: selected, failures: [] }), loadRecord: async record => ({ ...record, body: "Explicit complete body" }), onMetadata: records => { prepared = records; } }, adapter);
    const catalog = async () => {
      if (kind === "pi") return (await nativeEvents.get("resources_discover")[0]()).skillPaths.join("\n");
      let result;
      for (const handler of nativeEvents.get("before_agent_start")) result = await handler({ prompt: "hello", systemPrompt: "base" }, {});
      return result?.systemPrompt;
    };
    assert.match(await catalog(), /source-skill|SKILL\.md/);
    assert.equal(prepared.length, 2, "Host metadata path retains every explicit record");
    assert.doesNotMatch(await catalog(), /fixture-explicit|native-.*explicit/);
    selected = [{ ...flagged, defaultDiscovery: false }, explicit];
    await native.refresh();
    const afterUncheck = await catalog();
    assert.ok(!afterUncheck || !/source-skill|SKILL\.md/.test(afterUncheck), "Unchecking removes the native default catalog");
  }
  const sourceLoaded = await sourcesMod.loadSourceSkill(sourceMetadata, sourceGoodConfig);
  assert.equal(sourceLoaded.body, "portable body", "activation body equals the fixed read and portable entry");
  assert.equal(sourceLoaded.path.split("/").at(-1), "SKILL.md");
  assert.equal(sourceLoaded.metadataIndexPath, sourceMetadata.path);
  assert.equal(await readFile(join(sourceLoaded.path, "../references/guide.md"), "utf8"), "resource guide");
  const renamedConfig = adapterConfig("renamed");
  const [renameSelection] = await sourcesMod.discoverSources(renamedConfig);
  assert.equal(renameSelection.alias, "source-skill");
  const renamed = await sourcesMod.loadSourceSkill(renameSelection, renamedConfig);
  assert.equal(renamed.name, "Renamed Source Skill");
  assert.equal(renamed.alias, "renamed-source-skill");
  assert.equal(renamed.normalizedName, renamed.alias);
  assert.equal(renamed.description, "Renamed description");
  assert.equal(renamed.token, renameSelection.token, "The accepted invocation keeps its original token while loaded metadata follows the selected snapshot");
  assert.equal(discoveryMod.recordIdentity(renamed), discoveryMod.recordIdentity(renameSelection));
  assert.equal(renamed.body, "portable body");
  assert.equal(await readFile(join(renamed.path, "../references/guide.md"), "utf8"), "resource guide");
  const renamedAgain = await sourcesMod.loadSourceSkill(renameSelection, renamedConfig);
  assert.equal(renamedAgain.path, renamed.path, "The checked renamed snapshot is reusable");
  assert.equal(renamedAgain.alias, renamed.alias);
  assert.equal(sourceLoaded.alias, "source-skill", "A later renamed read cannot change an already selected snapshot");
  const priorReceipt = JSON.parse(await readFile(join(sourceLoaded.path, "../.broker-snapshot.json"), "utf8"));
  assert.equal(priorReceipt.record.alias, "source-skill");
  const nativeSourceMessages = [{ role: "custom", customType: mod.BUILTIN_SKILL_PROMPT_TYPE, content: sourceLoaded.body, details: { name: "fixture-source-skill", path: sourceMetadata.path } }];
  const nativeSourceContext = { sessionManager: { buildSessionContext: () => ({ messages: nativeSourceMessages }) } };
  const afterNativeSource = await mod.invokeBeforeAgentStart({ prompt: `$${discoveryMod.recordToken(sourceMetadata)} Use the selected source again.` }, nativeSourceContext, Promise.resolve([]), sourceGoodConfig, Promise.resolve([sourceMetadata]), async () => { throw new Error("Native source body must not be reloaded"); });
  assert.equal(afterNativeSource, undefined, "A dollar selection after native skill consumption must retain one body");
  const otherSourceContext = { sessionManager: { buildSessionContext: () => ({ messages: [{ ...nativeSourceMessages[0], details: { name: "fixture-source-skill", path: join(temp, "another-source", "SKILL.md") } }] }) } };
  const afterOtherSource = await mod.invokeBeforeAgentStart({ prompt: `$${discoveryMod.recordToken(sourceMetadata)} Use this source.` }, otherSourceContext, Promise.resolve([]), sourceGoodConfig, Promise.resolve([sourceMetadata]), async () => sourceLoaded);
  assert.match(String(afterOtherSource?.message?.content), /portable body/, "A same-name native skill from another source must not suppress activation");
  const piNativeText = `<skill name="fixture-source-skill" location="${sourceMetadata.path}">\n${sourceLoaded.body}\n</skill>`;
  const piNativeMarker = { role: "custom", customType: mod.CUSTOM_TYPE, content: [], details: { nativePromptSha256: createHash("sha256").update(piNativeText).digest("hex"), records: [{ identity: discoveryMod.recordIdentity(sourceMetadata), loaded: true }] } };
  assert.equal(mod.hasLoadedSkill([{ role: "user", content: piNativeText }, piNativeMarker], sourceMetadata), true, "Trusted native receipt must retain its matching body");
  assert.equal(mod.hasLoadedSkill([piNativeMarker], sourceMetadata), false, "A receipt retained after compaction removes the body must not suppress activation");
  assert.equal(mod.hasLoadedSkill([{ role: "user", content: piNativeText }], sourceMetadata), false, "User XML alone must not suppress source activation");
  const concurrentConfig = adapterConfig("concurrent");
  concurrentConfig.sources[0].cacheDir = join(temp, "source-concurrent-cache");
  const [concurrentRecord] = await sourcesMod.discoverSources(concurrentConfig);
  const concurrentLoads = await Promise.allSettled([
    sourcesMod.loadSourceSkill(concurrentRecord, concurrentConfig),
    sourcesMod.loadSourceSkill(concurrentRecord, concurrentConfig),
  ]);
  assert.ok(concurrentLoads.every(result => result.status === "fulfilled"), "Concurrent immutable publications converge without cache-busy errors");
  for (const result of concurrentLoads) assert.equal(await readFile(result.value.path, "utf8"), "portable body");
  const exportBeforeReuse = (await readFile(join(temp, "source-concurrent.jsonl"), "utf8")).trim().split("\n").filter(line => JSON.parse(line)[0] === "export").length;
  await sourcesMod.loadSourceSkill(concurrentRecord, concurrentConfig);
  const reuseOperations = (await readFile(join(temp, "source-concurrent.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(reuseOperations.filter(args => args[0] === "export").length, exportBeforeReuse, "Validated snapshot bytes avoid a repeat export");
  assert.equal(reuseOperations.at(-1)[0], "read", "Warm prepared bytes still enter CLI freshness validation");
  const localSourceRoot = join(temp, "local-source-root");
  const localSourcePath = await writeSkill(localSourceRoot, "local", "name: local-source\ndescription: local source\nautoload:\n  enabled: true", "Local source body");
  const localSourceConfig = { sources: [{ type: "filesystem", id: "local", roots: [localSourceRoot] }] };
  const [localMetadata] = await sourcesMod.discoverSources(localSourceConfig);
  assert.equal(localMetadata.body, undefined);
  assert.equal(localMetadata.token, "local/local-source");
  assert.match((await sourcesMod.loadSourceSkill(localMetadata, localSourceConfig)).body, /Local source body/);
  const outsideSourcePath = await writeSkill(temp, "outside-source", "name: outside-source\nautoload:\n  enabled: true", "Outside configured roots");
  await assert.rejects(sourcesMod.loadSourceSkill({ ...localMetadata, path: outsideSourcePath, id: outsideSourcePath }, localSourceConfig), { code: "SOURCE_IDENTITY_MISMATCH" });
  assert.equal(await readFile(localSourcePath, "utf8"), (await sourcesMod.loadSourceSkill(localMetadata, localSourceConfig)).body);
  const receiptPath = join(sourceLoaded.path, "../.broker-snapshot.json");
  const savedReceipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const reverseKeys = value => Object.fromEntries(Object.entries(value).reverse());
  savedReceipt.record = reverseKeys({ ...savedReceipt.record, locator: reverseKeys(savedReceipt.record.locator) });
  savedReceipt.files = savedReceipt.files.map(reverseKeys);
  await writeFile(receiptPath, JSON.stringify(reverseKeys(savedReceipt)));
  assert.equal((await sourcesMod.loadSourceSkill(sourceMetadata, sourceGoodConfig)).body, "portable body", "semantically identical receipt objects remain valid regardless of JSON property order");
  savedReceipt.version = 2;
  delete savedReceipt.projection;
  await writeFile(receiptPath, JSON.stringify(savedReceipt));
  assert.equal((await sourcesMod.loadSourceSkill(sourceMetadata, sourceGoodConfig)).body, "portable body");
  assert.equal(JSON.parse(await readFile(receiptPath, "utf8")).version, 3, "Old source-projection receipts are invalidated and rebuilt through pinned snapshot export");
  await writeFile(sourceLoaded.path, "tampered immutable cache");
  await assert.rejects(sourcesMod.loadSourceSkill(sourceMetadata, sourceGoodConfig), { code: "SOURCE_OUTPUT_CONFLICT" });
  assert.equal(await readFile(sourceLoaded.path, "utf8"), "tampered immutable cache", "a conflict never replaces existing snapshot bytes");
  await assert.rejects(sourcesMod.discoverSources(adapterConfig("timeout", 1000)), { code: "NTN_UNAVAILABLE" });
  const sourceAbort = new AbortController();
  const sourceCancelled = sourcesMod.discoverSources(adapterConfig("cancel"), process.cwd(), { signal: sourceAbort.signal });
  setTimeout(() => sourceAbort.abort(), 1000);
  await assert.rejects(sourceCancelled, { code: "SOURCE_CANCELLED" });
  for (const mode of ["cancel"]) {
    const lines = (await readFile(join(temp, `source-${mode}.jsonl`), "utf8")).trim().split("\n").map(JSON.parse);
    const descendant = lines.find((line) => line.child)?.child;
    assert.ok(descendant, "fixture descendant starts before cancellation");
    assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" }, "cancellation closes only the owned process group, including descendants");
  }

  const bundledDiscovery = await mod.buildDollarRegistry({ skillRoots: [], sources: [{ type: "notion", id: "offline-builtin", command: join(temp, "missing-notion-cli") }] });
  const bundledRecords = bundledDiscovery.records.filter(builtinMod.isBundledBuiltin);
  assert.deepEqual(bundledRecords.map(record => record.alias).sort(), [...builtinMod.BUNDLED_SKILL_NAMES].sort());
  const sharedRoot = join(temp, "builtin-shared");
  await mkdir(sharedRoot);
  const builtin = bundledRecords[0];
  await symlink(join(builtin.path, ".."), join(sharedRoot, builtin.alias), "dir");
  const configuredDiscovery = await mod.buildRawDollarRegistry({ skillRoots: [sharedRoot], sources: [{ type: "notion", id: "offline-builtin", command: join(temp, "missing-notion-cli") }] });
  assert.equal(configuredDiscovery.records.filter(record => record.name === builtin.name).length, 1, "A configured physical alias retains one official bundled identity");
  assert.ok(configuredDiscovery.records.some(record => record.id === builtin.id));
  const nativePrompt = `<skill><name>native-builtin-alias</name><description>Native alias</description><location>${join(sharedRoot, builtin.alias, "SKILL.md")}</location></skill>`;
  const merged = await dollarMod.buildDollarRegistryForContext({ getSystemPrompt: () => nativePrompt }, Promise.resolve(bundledRecords));
  assert.equal(merged.length, builtinMod.BUNDLED_SKILL_NAMES.length, "A native physical alias cannot duplicate packaged builtin content");
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  async function preparationHost(preflight, records = [], loadRecord = async record => record) {
    const listeners = new Map();
    const commands = new Map();
    const sends = [];
    const notices = [];
    let session = "original";
    let aborted = 0;
    const ctx = { mode: "tui", hasUI: false, cwd: temp,
      sessionManager: { getSessionId: () => session },
      ui: { notify: message => notices.push(message) }, abort: () => { aborted++; } };
    const api = {
      pi: {},
      on(name, handler) { listeners.set(name, [...(listeners.get(name) ?? []), handler]); },
      registerCommand(name, command) { commands.set(name, command); },
      sendUserMessage(content) { sends.push(content); },
    };
    let skills;
    skills = await hostSkillsMod.installHostSkills(api, {
      config: { sources: [] }, getRecords: async () => ({ records, failures: [] }), loadRecord,
      needsPreflightPrompt: text => text.includes("$"),
      preflightPrompt: (text, context, signal) => preflight(text, context, signal, skills),
    }, ompAdapterMod.createOmpHostAdapter(api));
    return { ctx, skills, sends, notices, get aborted() { return aborted; },
      switchSession() { session = "replacement"; },
      async emit(name, event = {}) {
        let result;
        for (const handler of listeners.get(name) ?? []) result = (await handler(event, ctx)) ?? result;
        return result;
      },
      submit(result) {
        assert.match(result.text, /^\/context-broker-submit \S+$/);
        return commands.get("context-broker-submit").handler(result.text.split(" ")[1], ctx);
      },
    };
  }

  {
    const pending = deferred();
    const started = deferred();
    const host = await preparationHost(async (text, _ctx, signal) => {
      if (text === "$slow original") { started.resolve(signal); await pending.promise; }
    });
    const accepted = await host.emit("input", { source: "interactive", text: "$slow original" });
    const command = host.submit(accepted);
    const signal = await started.promise;
    await host.emit("session_before_switch");
    host.switchSession();
    pending.resolve();
    await command;
    assert.equal(signal.aborted, true, "Switching sessions cancels the accepted preparation");
    assert.deepEqual(host.sends, [], "Late completion must not dispatch into the replacement session");
    const images = [{ type: "image", data: "replacement-image", mimeType: "image/png" }];
    const next = await host.emit("input", { source: "interactive", text: "$fresh original prompt", images });
    await host.submit(next);
    assert.deepEqual(host.sends, [[{ type: "text", text: "$fresh original prompt" }, ...images]],
      "The replacement session can submit its own original prompt and images");
    await host.emit("before_agent_start", { prompt: "$fresh original prompt" });
    await host.emit("agent_start");
  }

  {
    const record = { name: "boundary-source", token: "boundary-source", description: "Boundary fixture",
      sourceId: "boundary", id: "page", path: designContextPath, metadataIndexPath: designContextPath };
    const first = deferred();
    const firstStarted = deferred();
    const second = deferred();
    const secondStarted = deferred();
    let reads = 0;
    const host = await preparationHost(async () => {}, [record], async () => {
      reads++;
      if (reads === 1) { firstStarted.resolve(); return first.promise; }
      secondStarted.resolve();
      return second.promise;
    });
    const controller = new AbortController();
    const cancelled = host.skills.activate(record, host.ctx, controller.signal).then(
      value => ({ value }), error => ({ error }));
    await firstStarted.promise;
    controller.abort();
    // Start the independent consumer before the cancelled exporter settles.
    const independent = host.skills.activate(record, host.ctx);
    await secondStarted.promise;
    second.resolve({ ...record, body: "FRESH COMPLETE BODY with final section" });
    assert.equal((await independent).body, "FRESH COMPLETE BODY with final section",
      "A new read must load its own complete body instead of inheriting an aborted pending read");
    first.resolve({ ...record, body: "STALE CANCELLED BODY" });
    const outcome = await cancelled;
    assert.equal(outcome.error?.code, "SOURCE_ACTIVATION_CANCELLED",
      "The cancelled consumer must reject even when its exporter resolves successfully");
    assert.equal((await host.skills.activate(record, host.ctx)).body, "FRESH COMPLETE BODY with final section",
      "Late cancelled completion must not overwrite the independent read's published result");
  }

  {
    const indexPath = await writeSkill(join(temp, "resource-revision-index"), "skill", "name: resource-revision\ndescription: Resource revision fixture", "");
    const snapshots = [];
    for (const revision of ["first", "second"]) {
      const path = await writeSkill(join(temp, `resource-revision-${revision}`), "skill", "name: resource-revision\ndescription: Resource revision fixture", "Read references/guide.md.");
      await mkdir(join(path, "../references"));
      await writeFile(join(path, "../references/guide.md"), `${revision} resource contents`);
      snapshots.push(path);
    }
    const record = { name: "resource-revision", token: "resource-revision", description: "Resource revision fixture",
      sourceId: "resource-revision", id: "page", path: indexPath, metadataIndexPath: indexPath };
    let snapshot = snapshots[0];
    const host = await preparationHost(async () => {}, [record], async () => ({ ...record, path: snapshot, body: await readFile(snapshot, "utf8") }));
    await host.skills.activate(record, host.ctx);
    assert.equal(await readFile(join(indexPath, "../references/guide.md"), "utf8"), "first resource contents");
    snapshot = snapshots[1];
    await host.skills.activate(record, host.ctx);
    assert.equal(await readFile(join(indexPath, "../references/guide.md"), "utf8"), "second resource contents",
      "A validated resource-only snapshot change must update resources beside the advertised entry");
  }

  {
    const failure = deferred();
    const started = deferred();
    const sources = ["first", "second"].map(name => ({ name, token: name, description: "Referenced source",
      sourceId: "multiple", id: name, path: designContextPath, metadataIndexPath: designContextPath }));
    const host = await preparationHost(async (text, ctx, signal, skills) => {
      if (text === "$first $second") for (const record of sources) await skills.activate(record, ctx, signal);
    }, sources, async record => {
      if (record.name === "second") { started.resolve(); await failure.promise; }
      return { ...record, body: "FIRST SOURCE COMPLETE BODY" };
    });
    const accepted = await host.emit("input", { source: "interactive", text: "$first $second" });
    const command = host.submit(accepted);
    await started.promise;
    failure.reject(new Error("Second referenced source failed"));
    await command;
    assert.deepEqual(host.sends, [], "Failure preparing any referenced source prevents the whole submission");
    const retry = await host.emit("input", { source: "interactive", text: "$recovered" });
    await host.submit(retry);
    assert.deepEqual(host.sends, ["$recovered"], "A failed preparation releases the submission gate for retry");
    await host.emit("before_agent_start", { prompt: "$recovered" });
    await host.emit("agent_start");
  }
  {
    const host = await preparationHost(async () => {});
    const accepted = await host.emit("input", { source: "interactive", text: "$handoff original" });
    await host.submit(accepted);
    assert.deepEqual(host.sends, ["$handoff original"]);
    const blocked = await host.emit("input", { source: "interactive", text: "$second draft" });
    assert.deepEqual(blocked, { handled: true }, "Void dispatch keeps the gate until its matching agent handoff");
    await host.emit("session_before_switch");
    host.switchSession();
    assert.deepEqual(await host.emit("input", { source: "interactive", text: "$handoff original" }), { handled: true },
      "Cancellation must retain the receipt so a same-prompt retry cannot replace the pending consumer");
    assert.deepEqual(host.sends, ["$handoff original"], "Blocked retry cannot dispatch a second turn");
    const before = host.aborted;
    await host.emit("before_agent_start", { prompt: "$handoff original" });
    assert.equal(host.aborted, before + 1,
      "A cancelled void dispatch must abort its late provider consumer rather than prepare it again");
    await assert.rejects(host.skills.withPreparedPrompt("$handoff original", host.ctx, async () => {
      assert.fail("A cancelled consumer must never build provider context");
    }), { code: "SOURCE_ACTIVATION_CANCELLED" }, "The context consumer must acknowledge cancellation before retry");
    assert.equal(host.aborted, before + 2, "The context consumer must explicitly abort its provider turn before releasing retry");
    const retry = await host.emit("input", { source: "interactive", text: "$replacement" });
    await host.submit(retry);
    await host.emit("before_agent_start", { prompt: "$replacement" });
    assert.equal(await host.skills.withPreparedPrompt("$replacement", host.ctx, async () => "replacement-context"),
      "replacement-context", "The replacement consumer can build context after cancellation acknowledgment");
    await host.emit("agent_start");
    assert.deepEqual(host.sends, ["$handoff original", "$replacement"],
      "A matching replacement handoff remains usable after cancellation");
  }
  // A submission pins Prompt once across preflight/final consumption; a later turn reads anew.
  for (const mode of ["pi", "omp"]) {
    const events = new Map(), commands = new Map(), sends = [];
    const api = { on(name, handler) { events.set(name, [...(events.get(name) ?? []), handler]); }, registerCommand(name, command) { commands.set(name, command); }, sendUserMessage(value) { sends.push(value); } };
    const ctx = { mode: mode === "omp" ? "tui" : "rpc", sessionManager: { getSessionId: () => "prompt-session" } };
    const prompt = { kind: "prompt", id: "notion_page:prompt", locator: { type: "notion_page", page_id: "prompt", database_id: "db", data_source_id: "ds" }, sourceId: "notion", source: "notion", sourceScope: "scope", name: "task", token: "notion/task", path: "/metadata/PROMPT.md", entrypoint: "PROMPT.md", description: "Task", aliases: [], normalizedName: "task", normalizedAliases: [], normalizedDescription: "task", autoloadEnabled: false, defaultDiscovery: false };
    let reads = 0, upstream = 1, host;
    const adapter = { paths: {}, submission: mode === "omp" ? { mode: "command", receipt: "handoff" } : { mode: "transform", receipt: "input-digest" }, handledInput: { action: "handled" }, continuedInput: { action: "continue" }, transformInput: (text, images) => ({ action: "transform", text, images }), registerCatalog: async records => { assert.ok(records.every(record => record.kind !== "prompt")); return true; }, buildPrompt: async () => { throw Error("Prompt must not use native Skill prompt"); }, installEditor: async () => {}, reload: async () => {}, updatedRead: input => ({ input }) };
    host = await hostSkillsMod.installHostSkills(api, { config: {}, getRecords: async () => ({ records: [prompt], failures: [] }), loadRecord: async record => { reads++; return { ...record, path: `/snapshots/s${upstream}/PROMPT.md`, body: `TASK_REQUIREMENTS_s${upstream}`, snapshotId: `snapshot-${upstream}` }; }, needsPreflightPrompt: () => true, preflightPrompt: async (_text, context, signal) => { await host.activate(prompt, context, signal); }, taskPrompt: async (text, context, signal) => text + "\n" + (await host.activate(prompt, context, signal)).body }, adapter);
    const emit = async (name, event) => { let result; for (const handler of events.get(name) ?? []) result = await handler(event, ctx) ?? result; return result; };
    for (const material of ["FIRST_MATERIAL", "SECOND_MATERIAL"]) {
      const images = [{ type: "image", data: material }];
      const input = await emit("input", { source: "rpc", text: "$task " + material, images });
      let submitted = input.text;
      if (mode === "omp") { await commands.get("context-broker-submit").handler(input.text.split(" ")[1], ctx); const sent = sends.at(-1); submitted = sent[0].text; assert.deepEqual(sent[1], images[0]); }
      else assert.deepEqual(input.images, images);
      const submittedVersion = upstream;
      assert.ok(submitted.includes(material) && submitted.includes(`TASK_REQUIREMENTS_s${submittedVersion}`));
      await emit("before_agent_start", { prompt: submitted });
      await host.withPreparedPrompt(submitted, ctx, async signal => { assert.equal((await host.activate(prompt, ctx, signal)).snapshotId, "snapshot-" + reads); });
      await emit("agent_start", {});
      upstream++;
      const resource = await emit("tool_call", { toolName: "read", input: { path: `/metadata/reference.md?snapshot=snapshot-${submittedVersion}:2-4` } });
      assert.equal(resource.input.path, `/snapshots/s${submittedVersion}/reference.md:2-4`, "Current Prompt resources retain the submitted snapshot after agent_start releases preparation");
      const unqualified = await emit("tool_call", { toolName: "read", input: { path: "/metadata/reference.md" } });
      assert.equal(unqualified.input.path, `/snapshots/s${submittedVersion}/reference.md`, "Unqualified resource reads also use this turn's submitted snapshot");
      assert.equal(reads, submittedVersion, "Reading a submitted Prompt resource must not reactivate changed upstream content");
      const stale = await emit("tool_call", { toolName: "read", input: { path: `/metadata/reference.md?snapshot=snapshot-${upstream}` } });
      assert.equal(stale.block, true, "A different upstream snapshot cannot replace the current Prompt binding");
      await emit("agent_end", {});
      const ended = await emit("tool_call", { toolName: "read", input: { path: `/metadata/reference.md?snapshot=snapshot-${submittedVersion}` } });
      assert.equal(ended.block, true, "Turn completion clears Prompt snapshot authority without a loaded marker");
    }
    assert.equal(reads, 2, mode + " must pin once per submission and invoke again next turn");
  }
  console.log("context-broker smoke ok");
} finally {
  restoreEnv();
  console.log(`Test artifacts retained: ${temp}`);
}
