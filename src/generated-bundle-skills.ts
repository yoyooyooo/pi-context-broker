import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const GENERATED_BUNDLE_OWNER = "pi-context-broker";
export const GENERATED_BUNDLE_MANIFEST = "manifest.json";
export const GENERATED_BUNDLE_QUARANTINE = "generated-skills-quarantine";

const MANIFEST_VERSION = 1;
const LEGACY_OWNER_MARKER = "metadata:\n  context-broker-kind: bundle";
const EXPLICIT_OWNER_MARKER = `context-broker-owner: ${GENERATED_BUNDLE_OWNER}`;
const RECORD_MARKER = '<context-broker-record kind="bundle"';

type BundleIdentity = {
  name: string;
  normalizedName: string;
  path: string;
};

type ManifestEntry = {
  recordIdentity: string;
  bundleName: string;
  catalogPathDigest: string;
  path: string;
  contentDigest: string;
};

type GeneratedBundleManifest = {
  version: 1;
  owner: typeof GENERATED_BUNDLE_OWNER;
  entries: ManifestEntry[];
};

type MaterializeOptions<T extends BundleIdentity> = {
  root: string;
  bundles: T[];
  render: (bundle: T, recordIdentity: string) => string;
  now?: Date;
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function generatedBundleRecordIdentity(root: string, bundle: BundleIdentity): string {
  return createHash("sha256")
    .update(resolve(dirname(root)))
    .update("\0")
    .update(resolve(bundle.path))
    .update("\0")
    .update(bundle.normalizedName)
    .digest("hex");
}

export function generatedBundleSkillPath(root: string, bundle: BundleIdentity): string {
  return join(root, `bundle-${generatedBundleRecordIdentity(root, bundle).slice(0, 24)}.md`);
}

function atomicWrite(path: string, content: string, mode: number): void {
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(tempPath, content, { encoding: "utf8", mode });
  renameSync(tempPath, path);
}

function isOwnedGeneratedBundle(content: string): boolean {
  const owned = content.includes(EXPLICIT_OWNER_MARKER) || content.includes(LEGACY_OWNER_MARKER);
  return owned && content.includes(RECORD_MARKER);
}

function readManifest(path: string): GeneratedBundleManifest | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<GeneratedBundleManifest>;
    if (parsed.version !== MANIFEST_VERSION || parsed.owner !== GENERATED_BUNDLE_OWNER || !Array.isArray(parsed.entries)) {
      return undefined;
    }
    if (!parsed.entries.every((entry) => (
      entry
      && typeof entry.recordIdentity === "string"
      && typeof entry.bundleName === "string"
      && typeof entry.catalogPathDigest === "string"
      && typeof entry.path === "string"
      && basename(entry.path) === entry.path
      && typeof entry.contentDigest === "string"
    ))) return undefined;
    return parsed as GeneratedBundleManifest;
  } catch {
    return undefined;
  }
}

function quarantineStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function quarantinePath(root: string, fileName: string, now: Date): string {
  const directory = join(dirname(root), GENERATED_BUNDLE_QUARANTINE, `${quarantineStamp(now)}-${process.pid}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return join(directory, fileName);
}

function quarantineOwnedFile(root: string, path: string, now: Date): void {
  const fileName = basename(path);
  if (dirname(resolve(path)) !== resolve(root) || fileName !== basename(path)) return;
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return;
  }
  if (!isOwnedGeneratedBundle(content)) return;
  renameSync(path, quarantinePath(root, fileName, now));
}

function quarantineInvalidManifest(root: string, manifestPath: string, now: Date): void {
  if (!existsSync(manifestPath) || readManifest(manifestPath)) return;
  renameSync(manifestPath, quarantinePath(root, GENERATED_BUNDLE_MANIFEST, now));
}

export function materializeGeneratedBundleSkills<T extends BundleIdentity>(options: MaterializeOptions<T>): string[] {
  const root = resolve(options.root);
  const now = options.now ?? new Date();
  mkdirSync(root, { recursive: true, mode: 0o700 });

  const entries: ManifestEntry[] = [];
  const activePaths = new Set<string>();
  for (const bundle of options.bundles) {
    const recordIdentity = generatedBundleRecordIdentity(root, bundle);
    const path = generatedBundleSkillPath(root, bundle);
    const content = options.render(bundle, recordIdentity);
    let current: string | undefined;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      current = undefined;
    }
    if (current !== content) atomicWrite(path, content, 0o600);
    activePaths.add(resolve(path));
    entries.push({
      recordIdentity,
      bundleName: bundle.name,
      catalogPathDigest: digest(resolve(bundle.path)),
      path: basename(path),
      contentDigest: digest(content),
    });
  }

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !/^bundle-[a-f0-9]{24}\.md$/.test(entry.name)) continue;
    const path = resolve(root, entry.name);
    if (!activePaths.has(path)) quarantineOwnedFile(root, path, now);
  }

  const manifestPath = join(root, GENERATED_BUNDLE_MANIFEST);
  quarantineInvalidManifest(root, manifestPath, now);
  const manifest: GeneratedBundleManifest = {
    version: MANIFEST_VERSION,
    owner: GENERATED_BUNDLE_OWNER,
    entries: entries.sort((left, right) => left.bundleName.localeCompare(right.bundleName)),
  };
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  const currentManifest = readManifest(manifestPath);
  if (!currentManifest || readFileSync(manifestPath, "utf8") !== manifestContent) {
    atomicWrite(manifestPath, manifestContent, 0o600);
  }

  return entries.map((entry) => join(root, entry.path));
}
