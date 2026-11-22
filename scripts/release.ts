#!/usr/bin/env -S bun
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

type StableVersion = { major: number; minor: number; patch: number };
type PackageFile = { relPath: string; path: string; value: Record<string, unknown> & { version: string } };
type Config = {
  defaultBranch: string;
  remote: string;
  tagPrefix: string;
  versionFiles: string[];
  lockfiles: string[];
  lockfileCommand: string[] | null;
  checkCommand: string[];
  commitMessage: string;
  publishMode: "none" | "npm";
  publishPackage: string | null;
  publishRegistry: string;
  releaseBranchPrefix: string;
};
type Options = {
  dryRun: boolean;
  noPush: boolean;
  precheck: boolean;
  versionArg: string;
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const configPath = resolve(repoRoot, ".github/release.config.json");
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

main();

function main(): void {
  let originalBranch = "";
  let tempBranch = "";
  try {
    const options = parseArgs(process.argv.slice(2));
    const config = readConfig();
    ensureGitBase(config);
    run("git", ["fetch", config.remote, config.defaultBranch, "--tags"], { quiet: true });
    if (run("git", ["rev-parse", "HEAD"], { quiet: true }) !==
        run("git", ["rev-parse", `${config.remote}/${config.defaultBranch}`], { quiet: true })) {
      fail(`Release must start at the exact current ${config.remote}/${config.defaultBranch}.`);
    }

    const packages = readVersionFiles(config.versionFiles);
    const fileVersion = assertAlignedVersion(packages);
    const publishedVersions = readPublishedVersions(config);
    const tagVersions = readTagVersions(config.tagPrefix);
    const decision = chooseVersion(fileVersion, publishedVersions, tagVersions, options, config);
    const tag = `${config.tagPrefix}${decision.next}`;

    if (options.dryRun || options.precheck) {
      printPlan(fileVersion, decision, tag, config, options, tagVersions);
      return;
    }

    originalBranch = currentBranch();
    tempBranch = `${config.releaseBranchPrefix}${tag}-${shortSha()}-${Date.now()}`;
    run("git", ["switch", "-c", tempBranch]);

    for (const pkg of packages) {
      pkg.value.version = decision.next;
      writeJson(pkg.path, pkg.value);
    }
    if (Array.isArray(config.lockfileCommand) && config.lockfileCommand.length > 0) {
      run(config.lockfileCommand[0]!, config.lockfileCommand.slice(1));
    }
    run(config.checkCommand[0]!, config.checkCommand.slice(1));

    const addPaths = unique([...config.versionFiles, ...config.lockfiles]);
    run("git", ["add", ...addPaths]);
    run("git", ["commit", "-m", formatCommitMessage(config.commitMessage, tag)]);

    if (execCommand("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], false).exitCode === 0) {
      fail(`Tag already exists and is immutable: ${tag}. Repair its published version or choose a higher version.`);
    }
    run("git", ["tag", "-a", tag, "-m", tag]);

    if (!options.noPush) {
      run("git", ["push", config.remote, `refs/tags/${tag}`]);
    }

    run("git", ["switch", originalBranch], { quiet: true });
    run("git", ["branch", "-D", tempBranch], { quiet: true });
    console.log(options.noPush ? `${tag} created locally. No tag was pushed.` : `${tag} pushed. CI publish workflow should start.`);
  } catch (error) {
    if (originalBranch.length > 0) {
      execCommand("git", ["switch", originalBranch], false);
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function readConfig(): Config {
  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Partial<Config>;
  if (!Array.isArray(parsed.versionFiles) || parsed.versionFiles.length === 0) {
    fail("release config versionFiles must be a non-empty array");
  }
  if (!Array.isArray(parsed.checkCommand) || parsed.checkCommand.length === 0 ||
      parsed.checkCommand.some((part) => typeof part !== "string" || part.length === 0)) {
    fail("release config checkCommand must be a non-empty array of non-empty strings");
  }
  return {
    defaultBranch: "main",
    remote: "origin",
    tagPrefix: "v",
    lockfiles: [],
    lockfileCommand: null,
    commitMessage: "chore: release {tag}",
    publishMode: "npm",
    publishPackage: null,
    publishRegistry: "https://registry.npmjs.org",
    releaseBranchPrefix: "release/",
    ...parsed,
    versionFiles: parsed.versionFiles,
    checkCommand: parsed.checkCommand,
  };
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    dryRun: false,
    noPush: false,
    precheck: false,
    versionArg: "",
  };
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--no-push") options.noPush = true;
    else if (arg === "--precheck") options.precheck = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg.startsWith("-")) {
      fail(`Unknown option: ${arg}\n\n${usage()}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) {
    fail(`Expected exactly one version argument.\n\n${usage()}`);
  }
  options.versionArg = positional[0]!;
  return options;
}

function usage(): string {
  return `Usage:
  release <patch|minor|major|x.y.z> [--dry-run] [--precheck] [--no-push]

Default model:
  Creates a temporary local release branch, writes version files, runs the configured checkCommand,
  then commits, tags that commit, and pushes tag only. --no-push still runs the check.
  --dry-run and --precheck only print the plan; they do not run the check or create a release.
  Starts only from clean, current origin/main. Only stable x.y.z versions are supported.
  Every tag is immutable, including failed unpublished tags. A new release uses a higher version.
  Repair an already published version through Publish on its original tag; never delete or move it.`;
}

function ensureGitBase(config: Config): void {
  run("git", ["rev-parse", "--is-inside-work-tree"], { quiet: true });
  const status = run("git", ["status", "--porcelain"], { quiet: true });
  if (status.length > 0) fail("Working tree is not clean. Commit or stash changes before release.");
  const branch = currentBranch();
  if (branch.length === 0) fail("Detached HEAD. Check out a branch before release.");
  if (branch !== config.defaultBranch) {
    fail(`Release must run on ${config.defaultBranch}. Current branch: ${branch}.`);
  }
  const remote = execCommand("git", ["remote", "get-url", config.remote], false);
  if (remote.exitCode !== 0) fail(`Missing git remote: ${config.remote}. Every mode requires current ${config.remote}/${config.defaultBranch}.`);
}

function readVersionFiles(paths: string[]): PackageFile[] {
  return paths.map((relPath) => {
    const path = resolve(repoRoot, relPath);
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> & { version?: unknown };
    if (typeof value.version !== "string") fail(`${relPath} must contain a string version`);
    parseStableVersion(value.version);
    return { relPath, path, value: value as Record<string, unknown> & { version: string } };
  });
}

function assertAlignedVersion(packages: PackageFile[]): string {
  const [first, ...rest] = packages;
  if (!first) fail("No version files configured.");
  for (const pkg of rest) {
    if (pkg.value.version !== first.value.version) {
      fail(`Version mismatch: ${first.relPath} has ${first.value.version}, ${pkg.relPath} has ${pkg.value.version}`);
    }
  }
  return first.value.version;
}

function readPublishedVersions(config: Config): string[] {
  if (config.publishMode === "npm" && (config.publishPackage === null || config.publishPackage.length === 0)) {
    fail("release config publishPackage is required for npm publish mode.");
  }
  if (config.publishPackage === null || config.publishPackage.length === 0) return [];
  const result = execCommand("npm", ["view", config.publishPackage, "versions", "--json", "--registry", config.publishRegistry], false);
  if (result.exitCode !== 0) {
    let error: unknown;
    try { error = JSON.parse(result.stdout); } catch {}
    if (error && typeof error === "object" && "error" in error &&
        error.error && typeof error.error === "object" && "code" in error.error &&
        error.error.code === "E404") return [];
    fail(`Unable to read npm versions for ${config.publishPackage}.\n${result.stderr || result.stdout}`);
  }
  const parsed: unknown = JSON.parse(result.stdout);
  const values: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  if (values.some((value) => typeof value !== "string" ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value))) {
    fail(`Malformed npm version response for ${config.publishPackage}; registry state is unknown.`);
  }
  return values.filter((value): value is string => typeof value === "string" && isStableVersion(value));
}

function readTagVersions(prefix: string): string[] {
  const output = run("git", ["tag", "--list", `${prefix}[0-9]*.[0-9]*.[0-9]*`], { quiet: true });
  return output
    .split(/\r?\n/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => tag.startsWith(prefix) ? tag.slice(prefix.length) : tag)
    .filter(isStableVersion);
}

function chooseVersion(
  fileVersion: string,
  publishedVersions: string[],
  tagVersions: string[],
  options: Options,
  config: Config,
): { next: string; base: string; reason: string } {
  const latestPublished = maxVersion(publishedVersions);
  const latestTag = maxVersion(tagVersions);
  const latestKnown = maxVersion([fileVersion, latestPublished, latestTag].filter(Boolean));
  const requested = isBumpKind(options.versionArg)
    ? formatVersion(bumpVersion(parseStableVersion(latestKnown ?? fileVersion), options.versionArg))
    : formatVersion(parseStableVersion(options.versionArg));

  if (publishedVersions.includes(requested)) {
    fail(`${config.publishPackage ?? "package"}@${requested} already exists on npm. Choose a higher version.`);
  }
  if (tagVersions.includes(requested)) {
    fail(`Tag already exists and is immutable: ${config.tagPrefix}${requested}. Choose a higher version.`);
  }
  if (latestKnown && compareVersions(requested, latestKnown) <= 0) {
    fail(`Release version must exceed every known file, registry and tag version: ${requested} <= ${latestKnown}.`);
  }
  return {
    next: requested,
    base: latestKnown ?? fileVersion,
    reason: `new release above every known version, including unpublished tags`,
  };
}

function printPlan(
  fileVersion: string,
  decision: { next: string; base: string; reason: string },
  tag: string,
  config: Config,
  options: Options,
  tagVersions: string[],
): void {
  console.log(`Release ${options.precheck ? "precheck" : "dry-run"}:
  package: ${config.publishPackage ?? "unknown"}
  file version: ${fileVersion}
  next: ${decision.next}
  tag: ${tag}
  reason: ${decision.reason}
  existing tags: immutable; unpublished failures require a higher version
  local branch: temporary ${config.releaseBranchPrefix}${tag}-<sha>
  pushes: ${options.noPush ? "none" : "tag only"}
  check: ${formatCommand(config.checkCommand)} (not executed in this plan)
  main commit: no
  known tags: ${tagVersions.length}
`);
}

function currentBranch(): string {
  return run("git", ["branch", "--show-current"], { quiet: true });
}

function shortSha(): string {
  return run("git", ["rev-parse", "--short", "HEAD"], { quiet: true });
}

function writeJson(path: string, value: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command: string, args: string[], options: { quiet?: boolean } = {}): string {
  const result = execCommand(command, args, options.quiet !== true);
  if (result.exitCode !== 0) {
    const output = [result.stderr, result.stdout].filter(Boolean).join("\n");
    fail(`Command failed: ${formatCommand([command, ...args])}${output.length > 0 ? `\n${output}` : ""}`);
  }
  return result.stdout.trim();
}

function execCommand(command: string, args: string[], logCommand: boolean): { exitCode: number; stdout: string; stderr: string } {
  if (logCommand) console.log(`$ ${formatCommand([command, ...args])}`);
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8" });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function isBumpKind(value: string): value is "major" | "minor" | "patch" {
  return value === "major" || value === "minor" || value === "patch";
}

function isStableVersion(value: string): boolean {
  return versionPattern.test(value);
}

function parseStableVersion(value: string): StableVersion {
  const match = value.match(versionPattern);
  if (match === null) fail(`Only stable semver x.y.z is supported. Got ${value}.`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function bumpVersion(version: StableVersion, bump: "major" | "minor" | "patch"): StableVersion {
  if (bump === "major") return { major: version.major + 1, minor: 0, patch: 0 };
  if (bump === "minor") return { major: version.major, minor: version.minor + 1, patch: 0 };
  return { major: version.major, minor: version.minor, patch: version.patch + 1 };
}

function compareVersions(left: string, right: string): number {
  const l = parseStableVersion(left);
  const r = parseStableVersion(right);
  return l.major - r.major || l.minor - r.minor || l.patch - r.patch;
}

function maxVersion(values: (string | null)[]): string | null {
  const stable = values.filter((value): value is string => typeof value === "string" && isStableVersion(value));
  return stable.sort(compareVersions).at(-1) ?? null;
}

function formatVersion(version: StableVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function formatCommitMessage(template: string, tag: string): string {
  return template.replaceAll("{tag}", tag);
}

function formatCommand(parts: string[]): string {
  return parts.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_/:=.,@+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function fail(message: string): never {
  throw new Error(message);
}
