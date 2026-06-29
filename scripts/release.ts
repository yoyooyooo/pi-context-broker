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
  checkCommand: string[] | null;
  localCheckCommand?: string[] | null;
  commitMessage: string;
  publishMode: "none" | "npm";
  publishPackage: string | null;
  publishRegistry: string;
  reuseFailedVersion: boolean;
  releaseBranchPrefix: string;
};
type Options = {
  allowBranch: boolean;
  dryRun: boolean;
  noPush: boolean;
  precheck: boolean;
  replaceFailedTag: boolean;
  skipLocalCheck: boolean;
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
    const config = readConfig();
    const options = parseArgs(process.argv.slice(2));
    ensureGitBase(config, options);
    if (options.noPush) {
      execCommand("git", ["fetch", config.remote, "--tags", "--prune-tags"], false);
    } else {
      run("git", ["fetch", config.remote, "--tags", "--prune-tags"], { quiet: true });
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
    if (!options.skipLocalCheck && Array.isArray(config.localCheckCommand) && config.localCheckCommand.length > 0) {
      run(config.localCheckCommand[0]!, config.localCheckCommand.slice(1));
    }

    const addPaths = unique([...config.versionFiles, ...config.lockfiles]);
    run("git", ["add", ...addPaths]);
    run("git", ["commit", "-m", formatCommitMessage(config.commitMessage, tag)]);

    replaceLocalTagIfNeeded(tag, decision.reusingFailedTag);
    run("git", ["tag", "-a", tag, "-m", tag]);

    if (!options.noPush) {
      if (decision.reusingFailedTag) {
        deleteRemoteTag(config.remote, tag);
      }
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
  return {
    defaultBranch: "main",
    remote: "origin",
    tagPrefix: "v",
    lockfiles: [],
    lockfileCommand: null,
    checkCommand: null,
    localCheckCommand: null,
    commitMessage: "chore: release {tag}",
    publishMode: "npm",
    publishPackage: null,
    publishRegistry: "https://registry.npmjs.org",
    reuseFailedVersion: true,
    releaseBranchPrefix: "release/",
    ...parsed,
    versionFiles: parsed.versionFiles,
  };
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    allowBranch: false,
    dryRun: false,
    noPush: false,
    precheck: false,
    replaceFailedTag: true,
    skipLocalCheck: false,
    versionArg: "",
  };
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === "--allow-branch") options.allowBranch = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--no-push") options.noPush = true;
    else if (arg === "--precheck") options.precheck = true;
    else if (arg === "--no-replace-failed-tag") options.replaceFailedTag = false;
    else if (arg === "--skip-local-check") options.skipLocalCheck = true;
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
  release <patch|minor|major|x.y.z> [--dry-run] [--precheck] [--no-push] [--allow-branch]

Default model:
  Creates a temporary local release branch, writes version files, commits, tags that commit, pushes tag only.
  If latest git tag is absent from npm, it is treated as a failed release and reused.`;
}

function ensureGitBase(config: Config, options: Options): void {
  run("git", ["rev-parse", "--is-inside-work-tree"], { quiet: true });
  const status = run("git", ["status", "--porcelain"], { quiet: true });
  if (status.length > 0) fail("Working tree is not clean. Commit or stash changes before release.");
  const branch = currentBranch();
  if (branch.length === 0) fail("Detached HEAD. Check out a branch before release.");
  if (branch !== config.defaultBranch && !options.allowBranch) {
    fail(`Release must run on ${config.defaultBranch}. Current branch: ${branch}. Use --allow-branch to override.`);
  }
  if (!options.noPush) {
    const remote = execCommand("git", ["remote", "get-url", config.remote], false);
    if (remote.exitCode !== 0) fail(`Missing git remote: ${config.remote}. Add it or run with --no-push.`);
  }
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
    if (result.stderr.includes("E404") || result.stdout.includes("E404")) return [];
    fail(`Unable to read npm versions for ${config.publishPackage}.\n${result.stderr || result.stdout}`);
  }
  const parsed = JSON.parse(result.stdout || "[]") as unknown;
  if (Array.isArray(parsed)) return parsed.filter((value): value is string => typeof value === "string" && isStableVersion(value));
  return typeof parsed === "string" && isStableVersion(parsed) ? [parsed] : [];
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
): { next: string; base: string; reason: string; reusingFailedTag: boolean } {
  const latestPublished = maxVersion(publishedVersions);
  const latestTag = maxVersion(tagVersions);
  const latestKnown = maxVersion([fileVersion, latestPublished, latestTag].filter(Boolean));
  const tagIsUnpublished = latestTag !== null && !publishedVersions.includes(latestTag);

  if (tagIsUnpublished && config.reuseFailedVersion && options.replaceFailedTag && isBumpKind(options.versionArg)) {
    return {
      next: latestTag,
      base: latestPublished ?? fileVersion,
      reason: `reuse failed release tag ${config.tagPrefix}${latestTag} because npm does not contain ${latestTag}`,
      reusingFailedTag: true,
    };
  }

  const requested = isBumpKind(options.versionArg)
    ? formatVersion(bumpVersion(parseStableVersion(latestPublished ?? latestKnown ?? fileVersion), options.versionArg))
    : formatVersion(parseStableVersion(options.versionArg));

  if (publishedVersions.includes(requested)) {
    fail(`${config.publishPackage ?? "package"}@${requested} already exists on npm. Choose a higher version.`);
  }
  if (tagVersions.includes(requested)) {
    if (!config.reuseFailedVersion || !options.replaceFailedTag) {
      fail(`Tag already exists: ${config.tagPrefix}${requested}. Use a higher version or allow failed tag replacement.`);
    }
    return {
      next: requested,
      base: latestPublished ?? fileVersion,
      reason: `replace unpublished tag ${config.tagPrefix}${requested}`,
      reusingFailedTag: true,
    };
  }
  return {
    next: requested,
    base: latestPublished ?? fileVersion,
    reason: `new release from base ${latestPublished ?? fileVersion}`,
    reusingFailedTag: false,
  };
}

function replaceLocalTagIfNeeded(tag: string, replace: boolean): void {
  const exists = execCommand("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], false).exitCode === 0;
  if (exists && replace) run("git", ["tag", "-d", tag]);
  if (exists && !replace) fail(`Local tag already exists: ${tag}`);
}

function deleteRemoteTag(remote: string, tag: string): void {
  execCommand("git", ["push", remote, `:refs/tags/${tag}`], true);
}

function printPlan(
  fileVersion: string,
  decision: { next: string; base: string; reason: string; reusingFailedTag: boolean },
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
  replace failed tag: ${decision.reusingFailedTag ? "yes" : "no"}
  local branch: temporary ${config.releaseBranchPrefix}${tag}-<sha>
  pushes: ${options.noPush ? "none" : "tag only"}
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
