/**
 * Git worktree isolation and non-destructive patch integration.
 *
 * Every isolated agent owns a random detached worktree. Captured patches stay
 * byte-exact, are applied from the canonical repository root, and never modify
 * the user's index.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ensurePrivateArtifactDirectory,
  readContainedArtifactBytes,
  writeArtifactFile,
} from "./run-artifacts.ts";
import { hermeticGitEnvironment, stripOneLineEnding } from "./hermetic-git.ts";
import { resolveRepositoryContext } from "./repository-context.ts";

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_GIT_TIMEOUT_MS = 25_000;
const MAX_ROLLBACK_SNAPSHOT_BYTES = 256 * 1024 * 1024;
/** Ownership cookie inside the private object store; survives path reuse, not directory replacement. */
const RAW_OBJECT_OWNER_MARKER = ".ultracode-owned";

type PatchInput = string | Uint8Array;

type PathSnapshot =
  | { path: Buffer; relative: Buffer; kind: "missing" }
  | { path: Buffer; relative: Buffer; kind: "directory"; mode: number }
  | { path: Buffer; relative: Buffer; kind: "file"; data: Buffer; mode: number }
  | { path: Buffer; relative: Buffer; kind: "symlink"; target: Buffer };

interface ApplySnapshot {
  roots: Array<{ path: Buffer; relative: Buffer }>;
  paths: PathSnapshot[];
  directories: Array<{ path: Buffer; existed: boolean; mode?: number }>;
}

export interface Worktree {
  /** Canonical root of the repository that owns this worktree. */
  repoRoot: string;
  path: string;
  /** cwd the subagent should use inside the worktree. */
  agentCwd: string;
  baseCommit: string;
  /** Immutable ownership evidence for the linked worktree. */
  gitDir: string;
  gitDirDevice: number;
  gitDirInode: number;
  gitCommonDir: string;
  device: number;
  inode: number;
  /** Private raw-object store used to bypass filters and the real index. */
  rawObjectDirectory: string;
  rawObjectDevice: number;
  rawObjectInode: number;
  /** Secret written into the raw-object store; required before deleting that path. */
  rawObjectToken: string;
  repositoryObjectDirectory: string;
  rawBaseTree: string;
  /** Synthetic checkout files absent from baseCommit, used to distinguish hook setup from agent changes. */
  rawBaselineExtras: RawBaselineExtra[];
}

export interface WorktreeDiff {
  filesChanged: number;
  insertions: number;
  deletions: number;
  diffStat: string;
  patch: Buffer;
  /** Raw repository-relative path bytes, safe for non-UTF8 filenames. */
  paths: Buffer[];
}

interface GitRunOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  input?: Uint8Array;
  maxBuffer?: number;
}

function gitBuffer(cwd: string, args: string[], options: GitRunOptions = {}): Buffer {
  return execFileSync("git", args, {
    cwd,
    encoding: "buffer",
    stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
    input: options.input,
    env: hermeticGitEnvironment(options.env),
    maxBuffer: options.maxBuffer ?? MAX_GIT_OUTPUT_BYTES,
    timeout: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  }) as Buffer;
}

function gitLine(cwd: string, args: string[], options: GitRunOptions = {}): string {
  return stripOneLineEnding(gitBuffer(cwd, args, options).toString("utf8"));
}

function tryGit(cwd: string, args: string[], options: GitRunOptions = {}): string | undefined {
  try {
    return gitLine(cwd, args, options);
  } catch {
    return undefined;
  }
}

export function isGitRepo(cwd: string): boolean {
  return tryGit(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

/** Create a uniquely-owned detached worktree. Never removes an existing path. */
export function createWorktree(cwd: string, runId: string, index: number): Worktree {
  const context = resolveRepositoryContext(cwd);
  if (!context.repoRoot || context.relativeCwd === undefined || !context.gitCommonDir) {
    throw new Error("isolation: 'worktree' requires a Git working tree");
  }
  const repoRoot = context.repoRoot;
  const baseCommit = gitLine(repoRoot, ["rev-parse", "HEAD"]);
  if (!baseCommit) {
    throw new Error("isolation: 'worktree' requires at least one commit in the repository");
  }

  const diagnostic = runId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12) || "run";
  const nonce = randomBytes(12).toString("hex");
  const worktreePath = path.join(os.tmpdir(), `ultracode-wt-${diagnostic}-${index}-${nonce}`);
  const rawObjectDirectory = `${worktreePath}.ultracode-objects`;
  let rootIdentity: DirectoryIdentity | undefined;
  let registrationIdentity: RegistrationIdentity | undefined;
  let rawIdentity: DirectoryIdentity | undefined;
  let rawCreated = false;

  try {
    gitBuffer(repoRoot, ["worktree", "add", "--detach", worktreePath, baseCommit]);
    const rootStat = fs.lstatSync(worktreePath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("created worktree root is not an owned directory");
    }
    rootIdentity = { device: rootStat.dev, inode: rootStat.ino };
    registrationIdentity = discoverRegistrationAtPath(worktreePath, context.gitCommonDir);
    if (!registrationIdentity) {
      throw new Error("created worktree Git metadata is not a verified linked-worktree registration");
    }
    const gitDir = registrationIdentity.gitDir;
    const gitCommonDir = context.gitCommonDir;
    const repositoryObjectDirectory = fs.realpathSync(
      gitLine(repoRoot, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]),
    );
    fs.mkdirSync(rawObjectDirectory, { mode: 0o700 });
    rawCreated = true;
    const rawObjectToken = randomBytes(16).toString("hex");
    writeRawObjectOwnerMarker(rawObjectDirectory, rawObjectToken);
    const rawObjectStat = fs.lstatSync(rawObjectDirectory);
    if (!rawObjectStat.isDirectory() || rawObjectStat.isSymbolicLink()) {
      throw new Error("raw object store is not an owned directory");
    }
    rawIdentity = { device: rawObjectStat.dev, inode: rawObjectStat.ino };
    const rawBase = buildRawTree({
      cwd: worktreePath,
      baseCommit,
      objectDirectory: rawObjectDirectory,
      repositoryObjectDirectory,
      includeUntracked: true,
      allowTrackedDeletion: false,
      timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
    });
    const rawBaselineExtras = [...rawBase.entries]
      .filter(([key, entry]) => !rawBase.basePathKeys.has(key) && entry.type === "blob")
      .map(([key, entry]) => ({
        key,
        mode: entry.mode,
        type: "blob" as const,
        oid: entry.oid,
        tracked: rawBase.trackedPathKeys.has(key),
      }));
    const agentCwd = context.relativeCwd
      ? path.join(worktreePath, context.relativeCwd)
      : worktreePath;
    const realAgentCwd = fs.realpathSync(agentCwd);
    const relativeAgentCwd = path.relative(fs.realpathSync(worktreePath), realAgentCwd);
    if (relativeAgentCwd.startsWith("..") || path.isAbsolute(relativeAgentCwd)) {
      throw new Error("resolved agent cwd escaped the isolated worktree");
    }
    return {
      repoRoot,
      path: worktreePath,
      agentCwd: realAgentCwd,
      baseCommit,
      gitDir,
      gitDirDevice: registrationIdentity.device,
      gitDirInode: registrationIdentity.inode,
      gitCommonDir,
      device: rootStat.dev,
      inode: rootStat.ino,
      rawObjectDirectory,
      rawObjectDevice: rawObjectStat.dev,
      rawObjectInode: rawObjectStat.ino,
      rawObjectToken,
      repositoryObjectDirectory,
      rawBaseTree: rawBase.tree,
      rawBaselineExtras,
    };
  } catch (error) {
    registrationIdentity ??= discoverRegistrationAtPath(
      worktreePath,
      context.gitCommonDir,
    );
    if (!rootIdentity && registrationIdentity) {
      rootIdentity = directoryIdentity(worktreePath);
    }
    if (registrationIdentity && unregisterRegistration(repoRoot, registrationIdentity, worktreePath)) {
      if (rootIdentity) tryRemoveOwnedDirectory(worktreePath, rootIdentity);
      if (rawCreated && rawIdentity) tryRemoveOwnedDirectory(rawObjectDirectory, rawIdentity);
    }
    throw error;
  }
}

/** Capture a byte-exact raw filesystem diff without filters or the real index. */
export function captureWorktreeDiff(
  worktree: Worktree,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
): WorktreeDiff {
  const deadline = Date.now() + normalizeTimeout(timeoutMs);
  assertOwnedWorktree(worktree, deadline);
  const verifiedGitMetadata = assertUnchangedGitlinks(worktree, deadline);
  assertCleanSubmodules(worktree, deadline);
  assertNoUnsupportedFilesystemNodes(worktree, deadline, verifiedGitMetadata);
  const current = buildRawTree({
    cwd: worktree.path,
    baseCommit: worktree.baseCommit,
    objectDirectory: worktree.rawObjectDirectory,
    repositoryObjectDirectory: worktree.repositoryObjectDirectory,
    includeUntracked: true,
    allowTrackedDeletion: true,
    timeoutMs: remainingTimeout(deadline),
  });
  const objectEnv = rawObjectEnvironment(worktree.rawObjectDirectory, worktree.repositoryObjectDirectory);
  const syntheticBasePathsToRemove = new Set(worktree.rawBaselineExtras
    .filter((baseline) => {
      const entry = current.entries.get(baseline.key);
      if (!entry) return true;
      return entry.mode !== baseline.mode
        || entry.type !== baseline.type
        || entry.oid !== baseline.oid
        || (!baseline.tracked && current.trackedPathKeys.has(baseline.key));
    })
    .map((entry) => entry.key));
  const comparisonBaseTree = syntheticBasePathsToRemove.size > 0
    ? filterRawTree(
        worktree.path,
        worktree.rawBaseTree,
        syntheticBasePathsToRemove,
        objectEnv,
        deadline,
      )
    : worktree.rawBaseTree;
  const run = (args: string[]): Buffer => gitBuffer(worktree.path, args, {
    timeoutMs: remainingTimeout(deadline),
    env: objectEnv,
  });
  const sharedDiffArgs = [
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    comparisonBaseTree,
    current.tree,
  ];
  const numstat = run([
    "-c", "core.quotepath=false", "diff", "--numstat", "-z", ...sharedDiffArgs,
  ]);
  const diffStat = run([
    "-c", "core.quotepath=false", "diff", "--stat", ...sharedDiffArgs,
  ]).toString("utf8");
  const patch = run([
    "-c", "core.quotepath=false", "diff", "--binary", "--full-index", ...sharedDiffArgs,
  ]);

  const parsed = parseNumstat(numstat);
  if (parsed.filesChanged > 0 && patch.length === 0) {
    throw new Error("git diff reported changed files but produced an empty patch");
  }
  return { ...parsed, diffStat, patch };
}

export function hasChanges(diff: WorktreeDiff): boolean {
  return diff.filesChanged > 0;
}

interface RawTreeInput {
  cwd: string;
  baseCommit: string;
  objectDirectory: string;
  repositoryObjectDirectory: string;
  includeUntracked: boolean;
  allowTrackedDeletion: boolean;
  timeoutMs: number;
}

interface RawBaselineExtra {
  key: string;
  mode: string;
  type: "blob";
  oid: string;
  tracked: boolean;
}

interface RawTreeResult {
  tree: string;
  entries: Map<string, RawTreeEntry>;
  basePathKeys: Set<string>;
  trackedPathKeys: Set<string>;
}

interface RawTreeEntry {
  mode: string;
  type: "blob" | "commit";
  oid: string;
  path: Buffer;
}

function buildRawTree(input: RawTreeInput): RawTreeResult {
  const deadline = Date.now() + normalizeTimeout(input.timeoutMs);
  const objectEnv = rawObjectEnvironment(input.objectDirectory, input.repositoryObjectDirectory);
  const baseEntries = parseLsTree(gitBuffer(
    input.cwd,
    ["ls-tree", "-r", "-z", "--full-tree", input.baseCommit],
    { timeoutMs: remainingTimeout(deadline), env: objectEnv },
  ));
  const basePathKeys = new Set(baseEntries.map((entry) => entry.path.toString("base64")));
  const trackedPaths = listCurrentTrackedPaths(input.cwd, objectEnv, deadline);
  const trackedPathKeys = new Set(trackedPaths.keys());
  const entries = new Map<string, RawTreeEntry>();
  for (const base of baseEntries) {
    const key = base.path.toString("base64");
    if (base.mode === "160000") {
      setRawTreeEntry(entries, base);
      continue;
    }
    const current = rawEntryFromFilesystem(input.cwd, base.path, objectEnv, deadline);
    if (current) setRawTreeEntry(entries, current);
    else if (!input.allowTrackedDeletion) {
      throw new Error(`fresh worktree is missing a tracked path: ${base.path.toString("utf8")}`);
    }
  }
  if (input.includeUntracked) {
    const untracked = listUntrackedFromBase(input, objectEnv, deadline);
    for (const relative of untracked) {
      const key = relative.toString("base64");
      if (entries.has(key)) continue;
      const entry = rawEntryFromFilesystem(input.cwd, relative, objectEnv, deadline);
      if (entry) setRawTreeEntry(entries, entry);
    }
  }
  for (const [key, relative] of trackedPaths) {
    if (entries.has(key)) continue;
    const entry = rawEntryFromFilesystem(input.cwd, relative, objectEnv, deadline);
    if (entry) setRawTreeEntry(entries, entry);
    else if (!input.allowTrackedDeletion) {
      throw new Error(`fresh worktree is missing a tracked path: ${relative.toString("utf8")}`);
    }
  }

  return {
    tree: writeRawTree(input.cwd, entries.values(), objectEnv, deadline),
    entries,
    basePathKeys,
    trackedPathKeys,
  };
}

function listCurrentTrackedPaths(
  cwd: string,
  objectEnv: NodeJS.ProcessEnv,
  deadline: number,
): Map<string, Buffer> {
  const paths = new Map<string, Buffer>();
  for (const entry of parseLsTree(gitBuffer(
    cwd,
    ["ls-tree", "-r", "-z", "--full-tree", "HEAD"],
    { timeoutMs: remainingTimeout(deadline), env: objectEnv },
  ))) {
    if (entry.mode !== "160000") paths.set(entry.path.toString("base64"), entry.path);
  }
  for (const entry of parseIndexEntries(gitBuffer(
    cwd,
    ["ls-files", "--stage", "-z"],
    { timeoutMs: remainingTimeout(deadline) },
  ))) {
    if (entry.stage !== "0") {
      throw new Error("worktree index contains unmerged entries; worktree must be preserved");
    }
    if (entry.mode !== "160000") paths.set(entry.path.toString("base64"), entry.path);
  }
  return paths;
}

function writeRawTree(
  cwd: string,
  values: Iterable<RawTreeEntry>,
  objectEnv: NodeJS.ProcessEnv,
  deadline: number,
): string {
  const indexPath = path.join(os.tmpdir(), `ultracode-index-${process.pid}-${randomBytes(8).toString("hex")}`);
  const indexEnv = { ...objectEnv, GIT_INDEX_FILE: indexPath };
  try {
    gitBuffer(cwd, ["read-tree", "--empty"], {
      timeoutMs: remainingTimeout(deadline),
      env: indexEnv,
    });
    const indexInfo = [...values]
      .sort((left, right) => Buffer.compare(left.path, right.path))
      .map((entry) => Buffer.concat([
        Buffer.from(`${entry.mode} ${entry.oid}\t`, "ascii"),
        entry.path,
        Buffer.from([0]),
      ]));
    if (indexInfo.length > 0) {
      gitBuffer(cwd, ["update-index", "-z", "--index-info"], {
        timeoutMs: remainingTimeout(deadline),
        env: indexEnv,
        input: Buffer.concat(indexInfo),
      });
    }
    return gitLine(cwd, ["write-tree"], {
      timeoutMs: remainingTimeout(deadline),
      env: indexEnv,
    });
  } finally {
    try {
      fs.rmSync(indexPath, { force: true });
    } catch {
      // ignore
    }
  }
}

function filterRawTree(
  cwd: string,
  tree: string,
  excludedPathKeys: ReadonlySet<string>,
  objectEnv: NodeJS.ProcessEnv,
  deadline: number,
): string {
  const entries = parseLsTree(gitBuffer(
    cwd,
    ["ls-tree", "-r", "-z", "--full-tree", tree],
    { timeoutMs: remainingTimeout(deadline), env: objectEnv },
  )).filter((entry) => !excludedPathKeys.has(entry.path.toString("base64")));
  return writeRawTree(cwd, entries, objectEnv, deadline);
}

function listUntrackedFromBase(
  input: RawTreeInput,
  objectEnv: NodeJS.ProcessEnv,
  deadline: number,
): Buffer[] {
  const indexPath = path.join(os.tmpdir(), `ultracode-base-index-${process.pid}-${randomBytes(8).toString("hex")}`);
  const env = { ...objectEnv, GIT_INDEX_FILE: indexPath };
  try {
    gitBuffer(input.cwd, ["read-tree", input.baseCommit], {
      timeoutMs: remainingTimeout(deadline),
      env,
    });
    return splitNul(gitBuffer(
      input.cwd,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { timeoutMs: remainingTimeout(deadline), env },
    ));
  } finally {
    try {
      fs.rmSync(indexPath, { force: true });
    } catch {
      // ignore
    }
  }
}

interface FilesystemEntry {
  mode: string;
  path: Buffer;
  content: Buffer;
}

function rawEntryFromFilesystem(
  cwd: string,
  relative: Buffer,
  objectEnv: NodeJS.ProcessEnv,
  deadline: number,
): RawTreeEntry | undefined {
  const entry = readFilesystemEntryNoFollow(cwd, relative);
  if (!entry) return undefined;
  const oid = gitLine(cwd, ["hash-object", "-w", "--no-filters", "--stdin"], {
    timeoutMs: remainingTimeout(deadline),
    env: objectEnv,
    input: entry.content,
  });
  return { mode: entry.mode, type: "blob", oid, path: entry.path };
}

function readFilesystemEntryNoFollow(cwd: string, relative: Buffer): FilesystemEntry | undefined {
  const components = splitPath(relative);
  const root = Buffer.from(cwd);
  const separator = Buffer.from(path.sep);
  let target = root;
  const traversed: Buffer[] = [];
  for (let index = 0; index < components.length; index++) {
    const component = components[index];
    traversed.push(component);
    target = Buffer.concat([target, separator, component]);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(target);
    } catch (error: any) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
    const entryPath = Buffer.concat(interleave(traversed, Buffer.from("/")));
    if (stat.isSymbolicLink()) {
      return {
        mode: "120000",
        path: entryPath,
        content: Buffer.from(fs.readlinkSync(target, { encoding: "buffer" }) as Buffer),
      };
    }
    if (stat.isFile()) {
      if (stat.size > MAX_ROLLBACK_SNAPSHOT_BYTES) {
        throw new Error(`raw worktree file exceeds ${MAX_ROLLBACK_SNAPSHOT_BYTES} bytes`);
      }
      return {
        mode: (stat.mode & 0o111) !== 0 ? "100755" : "100644",
        path: entryPath,
        content: fs.readFileSync(target),
      };
    }
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      if (index < components.length - 1) continue;
      return undefined;
    }
    throw new Error(`unsupported filesystem node in worktree: ${entryPath.toString("utf8")}`);
  }
  return undefined;
}

function setRawTreeEntry(entries: Map<string, RawTreeEntry>, entry: RawTreeEntry): void {
  for (const [key, existing] of entries) {
    if (isDescendantPath(entry.path, existing.path)) return;
    if (isDescendantPath(existing.path, entry.path)) entries.delete(key);
  }
  entries.set(entry.path.toString("base64"), entry);
}

function isDescendantPath(candidate: Buffer, parent: Buffer): boolean {
  return candidate.length > parent.length
    && candidate.subarray(0, parent.length).equals(parent)
    && candidate[parent.length] === 0x2f;
}

function parseLsTree(value: Buffer): RawTreeEntry[] {
  return splitNul(value).map((record) => {
    const firstSpace = record.indexOf(0x20);
    const secondSpace = firstSpace < 0 ? -1 : record.indexOf(0x20, firstSpace + 1);
    const tab = secondSpace < 0 ? -1 : record.indexOf(0x09, secondSpace + 1);
    if (firstSpace < 0 || secondSpace < 0 || tab < 0) {
      throw new Error("git ls-tree returned malformed output");
    }
    const mode = record.subarray(0, firstSpace).toString("ascii");
    const type = record.subarray(firstSpace + 1, secondSpace).toString("ascii");
    const oid = record.subarray(secondSpace + 1, tab).toString("ascii");
    if ((type !== "blob" && type !== "commit") || !/^[0-9a-f]+$/.test(oid)) {
      throw new Error("git ls-tree returned an unsupported entry");
    }
    return { mode, type, oid, path: Buffer.from(record.subarray(tab + 1)) } as RawTreeEntry;
  });
}

interface IndexEntry {
  mode: string;
  oid: string;
  stage: string;
  path: Buffer;
}

function parseIndexEntries(value: Buffer): IndexEntry[] {
  return splitNul(value).map((record) => {
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error("git ls-files returned malformed index output");
    const fields = record.subarray(0, tab).toString("ascii").split(" ");
    if (
      fields.length !== 3
      || !/^[0-7]{6}$/.test(fields[0] ?? "")
      || !/^[0-9a-f]+$/.test(fields[1] ?? "")
      || !/^[0-3]$/.test(fields[2] ?? "")
    ) {
      throw new Error("git ls-files returned malformed index entry");
    }
    return {
      mode: fields[0]!,
      oid: fields[1]!,
      stage: fields[2]!,
      path: Buffer.from(record.subarray(tab + 1)),
    };
  });
}

function splitNul(value: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index <= value.length; index++) {
    if (index < value.length && value[index] !== 0) continue;
    if (index > start) records.push(Buffer.from(value.subarray(start, index)));
    start = index + 1;
  }
  return records;
}

function rawObjectEnvironment(objectDirectory: string, repositoryObjectDirectory: string): NodeJS.ProcessEnv {
  return {
    GIT_OBJECT_DIRECTORY: objectDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: repositoryObjectDirectory,
  };
}

function assertUnchangedGitlinks(worktree: Worktree, deadline: number): Set<string> {
  const readTreeGitlinks = (treeish: string): Map<string, { oid: string; path: Buffer }> => {
    const entries = parseLsTree(gitBuffer(
      worktree.path,
      ["ls-tree", "-r", "-z", "--full-tree", treeish],
      { timeoutMs: remainingTimeout(deadline) },
    ));
    return new Map(entries
      .filter((entry) => entry.mode === "160000")
      .map((entry) => [entry.path.toString("base64"), { oid: entry.oid, path: entry.path }]));
  };
  const base = readTreeGitlinks(worktree.baseCommit);
  const head = readTreeGitlinks("HEAD");
  assertSameGitlinks(base, head, "committed");

  const index = new Map<string, { oid: string; path: Buffer }>();
  for (const entry of parseIndexEntries(gitBuffer(
    worktree.path,
    ["ls-files", "--stage", "-z"],
    { timeoutMs: remainingTimeout(deadline) },
  ))) {
    const key = entry.path.toString("base64");
    if (entry.stage !== "0") {
      if (entry.mode === "160000" || base.has(key)) {
        throw new Error("changed gitlink cannot be delivered; worktree must be preserved");
      }
      continue;
    }
    if (entry.mode === "160000") index.set(key, { oid: entry.oid, path: entry.path });
  }
  assertSameGitlinks(base, index, "staged");

  const indexTags = new Map<string, string>();
  for (const record of splitNul(gitBuffer(
    worktree.path,
    ["ls-files", "-v", "-z"],
    { timeoutMs: remainingTimeout(deadline) },
  ))) {
    if (record.length < 3 || record[1] !== 0x20) {
      throw new Error("git ls-files returned malformed flag output");
    }
    indexTags.set(record.subarray(2).toString("base64"), String.fromCharCode(record[0]!));
  }
  for (const [key] of base) {
    if (indexTags.get(key) !== "H") {
      throw new Error("gitlink index flags cannot hide submodule changes; worktree must be preserved");
    }
  }

  const verifiedGitMetadata = new Set<string>();
  for (const entry of base.values()) {
    const submoduleRoot = resolveDirectoryNoFollow(worktree.path, entry.path);
    if (!submoduleRoot) continue;
    const submodulePath = submoduleRoot.toString();
    if (!Buffer.from(submodulePath).equals(submoduleRoot)) {
      throw new Error("submodule path encoding cannot be verified; worktree must be preserved");
    }
    try {
      gitLine(submodulePath, ["rev-parse", "HEAD"], {
        timeoutMs: remainingTimeout(deadline),
      });
    } catch {
      if (fs.readdirSync(submoduleRoot).length === 0) continue;
      throw new Error("uninitialized submodule contains files; worktree must be preserved");
    }
    assertInitializedRepositoryClean(
      submodulePath,
      entry.oid,
      deadline,
      0,
      verifiedGitMetadata,
      entry.path,
    );
  }
  return verifiedGitMetadata;
}

function assertInitializedRepositoryClean(
  repoRoot: string,
  expectedHead: string,
  deadline: number,
  depth: number,
  verifiedGitMetadata: Set<string>,
  relativeRepoRoot: Buffer,
): void {
  if (depth > 64) throw new Error("nested submodule depth cannot be verified; worktree must be preserved");
  const discoveryEnv = {
    GIT_WORK_TREE: repoRoot,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
  const gitDir = fs.realpathSync(gitLine(repoRoot, ["rev-parse", "--path-format=absolute", "--git-dir"], {
    timeoutMs: remainingTimeout(deadline),
    env: discoveryEnv,
  }));
  recordVerifiedGitMetadata(repoRoot, gitDir, relativeRepoRoot, verifiedGitMetadata);
  const repositoryEnv = {
    GIT_DIR: gitDir,
    GIT_WORK_TREE: repoRoot,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
  const fixedConfig = [
    "-c", "core.filemode=true",
    "-c", "core.fsmonitor=false",
    "-c", "core.ignoreStat=false",
  ];
  const run = (args: string[], input?: Buffer): Buffer => gitBuffer(
    repoRoot,
    [...fixedConfig, ...args],
    { timeoutMs: remainingTimeout(deadline), env: repositoryEnv, input },
  );
  const line = (args: string[], input?: Buffer): string => stripOneLineEnding(run(args, input).toString("utf8"));

  if (line(["rev-parse", "HEAD"]) !== expectedHead) {
    throw new Error("changed submodule HEAD cannot be delivered; worktree must be preserved");
  }
  const expectedEntries = parseLsTree(run(["ls-tree", "-r", "-z", "--full-tree", expectedHead]));
  const expectedByPath = new Map(expectedEntries.map((entry) => [entry.path.toString("base64"), entry]));
  const indexEntries = parseIndexEntries(run(["ls-files", "--stage", "-z"]));
  if (indexEntries.some((entry) => entry.stage !== "0") || indexEntries.length !== expectedEntries.length) {
    throw new Error("changed submodule index cannot be delivered; worktree must be preserved");
  }
  for (const entry of indexEntries) {
    const expected = expectedByPath.get(entry.path.toString("base64"));
    if (!expected || expected.mode !== entry.mode || expected.oid !== entry.oid) {
      throw new Error("changed submodule index cannot be delivered; worktree must be preserved");
    }
  }
  for (const flag of ["-v", "-f"]) {
    for (const record of splitNul(run(["ls-files", flag, "-z"]))) {
      if (record.length < 3 || record[1] !== 0x20 || record[0] !== 0x48) {
        throw new Error("submodule index flags cannot hide changes; worktree must be preserved");
      }
    }
  }

  for (const expected of expectedEntries) {
    if (expected.mode === "160000") continue;
    const actual = readFilesystemEntryNoFollow(repoRoot, expected.path);
    if (!actual || !actual.path.equals(expected.path) || actual.mode !== expected.mode) {
      throw new Error("dirty submodule cannot be delivered; worktree must be preserved");
    }
    const oid = line(["hash-object", "--no-filters", "--stdin"], actual.content);
    if (oid !== expected.oid) {
      throw new Error("dirty submodule cannot be delivered; worktree must be preserved");
    }
  }
  if (run(["ls-files", "--others", "--exclude-standard", "-z"]).length > 0) {
    throw new Error("dirty submodule cannot be delivered; worktree must be preserved");
  }

  for (const entry of expectedEntries.filter((candidate) => candidate.mode === "160000")) {
    const nestedRoot = resolveDirectoryNoFollow(repoRoot, entry.path);
    if (!nestedRoot || fs.readdirSync(nestedRoot).length === 0) continue;
    const nestedPath = nestedRoot.toString();
    if (!Buffer.from(nestedPath).equals(nestedRoot)) {
      throw new Error("nested submodule path encoding cannot be verified; worktree must be preserved");
    }
    const nestedRelative = Buffer.concat([relativeRepoRoot, Buffer.from("/"), entry.path]);
    assertInitializedRepositoryClean(
      nestedPath,
      entry.oid,
      deadline,
      depth + 1,
      verifiedGitMetadata,
      nestedRelative,
    );
  }
}

function recordVerifiedGitMetadata(
  repoRoot: string,
  gitDir: string,
  relativeRepoRoot: Buffer,
  verifiedGitMetadata: Set<string>,
): void {
  const metadataPath = path.join(repoRoot, ".git");
  const stat = fs.lstatSync(metadataPath);
  let resolved: string;
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    resolved = fs.realpathSync(metadataPath);
  } else if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096) {
    const match = fs.readFileSync(metadataPath, "utf8").trim().match(/^gitdir:\s+(.+)$/);
    if (!match) throw new Error("submodule Git metadata cannot be verified; worktree must be preserved");
    resolved = fs.realpathSync(path.resolve(repoRoot, match[1]));
  } else {
    throw new Error("submodule Git metadata cannot be verified; worktree must be preserved");
  }
  if (resolved !== gitDir) {
    throw new Error("submodule Git metadata identity changed; worktree must be preserved");
  }
  const relative = Buffer.concat([relativeRepoRoot, Buffer.from("/.git")]);
  verifiedGitMetadata.add(relative.toString("base64"));
}

function resolveDirectoryNoFollow(cwd: string, relative: Buffer): Buffer | undefined {
  const components = splitPath(relative);
  const separator = Buffer.from(path.sep);
  let target = Buffer.from(cwd);
  for (const component of components) {
    target = Buffer.concat([target, separator, component]);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(target);
    } catch (error: any) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("submodule path contains a non-directory ancestor; worktree must be preserved");
    }
  }
  return target;
}

function assertSameGitlinks(
  base: Map<string, { oid: string; path: Buffer }>,
  candidate: Map<string, { oid: string; path: Buffer }>,
  state: string,
): void {
  if (base.size === candidate.size && [...base].every(([key, entry]) => candidate.get(key)?.oid === entry.oid)) {
    return;
  }
  throw new Error(`${state} gitlink changes cannot be delivered; worktree must be preserved`);
}

function assertNoUnsupportedFilesystemNodes(
  worktree: Worktree,
  deadline: number,
  verifiedGitMetadata: ReadonlySet<string>,
): void {
  const cwd = worktree.path;
  const root = Buffer.from(cwd);
  const stack: Array<{ absolute: Buffer; relative: Buffer }> = [{ absolute: root, relative: Buffer.alloc(0) }];
  const special: Buffer[] = [];
  let visited = 0;
  while (stack.length > 0) {
    if (Date.now() >= deadline) throw new Error("worktree filesystem scan exceeded its deadline");
    const directory = stack.pop()!;
    const children = fs.readdirSync(directory.absolute, {
      encoding: "buffer",
      withFileTypes: true,
    }) as unknown as Array<fs.Dirent<Buffer>>;
    for (const child of children) {
      visited++;
      if (visited > 200_000) {
        throw new Error("worktree filesystem scan exceeds 200000 nodes; worktree must be preserved");
      }
      const name = Buffer.from(child.name);
      if (directory.relative.length === 0 && name.equals(Buffer.from(".git"))) continue;
      const separator = Buffer.from(path.sep);
      const absolute = Buffer.concat([directory.absolute, separator, name]);
      const relative = directory.relative.length === 0
        ? name
        : Buffer.concat([directory.relative, Buffer.from("/"), name]);
      const stat = fs.lstatSync(absolute);
      if (name.equals(Buffer.from(".git"))) {
        if (verifiedGitMetadata.has(relative.toString("base64"))) continue;
        special.push(relative);
      } else if (stat.isDirectory() && !stat.isSymbolicLink()) {
        stack.push({ absolute, relative });
      } else if (!stat.isFile() && !stat.isSymbolicLink()) {
        special.push(relative);
      }
    }
  }
  if (special.length === 0) return;

  const input = Buffer.concat(special.flatMap((relative) => [relative, Buffer.from([0])]));
  let ignoredOutput: Buffer;
  try {
    ignoredOutput = gitBuffer(cwd, ["check-ignore", "--no-index", "-z", "--stdin"], {
      timeoutMs: remainingTimeout(deadline),
      input,
    });
  } catch (error: any) {
    if (error?.status !== 1) throw error;
    ignoredOutput = Buffer.isBuffer(error?.stdout) ? error.stdout : Buffer.alloc(0);
  }
  const ignored = new Set(splitNul(ignoredOutput).map((relative) => relative.toString("base64")));
  const unsupported = special.find((relative) => !ignored.has(relative.toString("base64")));
  if (unsupported) {
    throw new Error(`unsupported filesystem node in worktree: ${unsupported.toString("utf8")}`);
  }
}

function assertCleanSubmodules(worktree: Worktree, deadline: number): void {
  const status = gitBuffer(worktree.path, [
    "status",
    "--porcelain=v2",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ], { timeoutMs: remainingTimeout(deadline) });
  for (const record of splitNul(status)) {
    if (record[0] !== 0x31 && record[0] !== 0x32) continue;
    const fields = record.toString("latin1").split(" ");
    const xy = fields[1];
    const submodule = fields[2];
    const touchesGitlink = fields.slice(3, 6).includes("160000");
    if (
      (submodule?.startsWith("S") && submodule !== "S...")
      || (touchesGitlink && xy !== "..")
    ) {
      throw new Error("dirty or changed submodule cannot be delivered; worktree must be preserved");
    }
  }
}

/** Generate a collision-resistant private patch path. */
export function patchTmpPath(): string {
  return path.join(os.tmpdir(), `ultracode-patch-${process.pid}-${randomBytes(8).toString("hex")}.patch`);
}

/**
 * Apply a patch without touching the target repository's index.
 *
 * We deliberately avoid `--3way`: it mutates the real index on conflicts and
 * makes exact rollback of staged state, modes, and symlinks impossible.
 */
export function applyPatch(
  repoRoot: string,
  patchInput: PatchInput,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
): boolean {
  const patch = withTrailingNewline(patchInput);
  if (patch.length === 0 || containsGitlink(patch)) return false;
  const tmp = patchTmpPath();
  const deadline = Date.now() + normalizeTimeout(timeoutMs);
  const targetRoot = fs.realpathSync(repoRoot);
  let repository: PatchRepository | undefined;
  let attempted = false;
  let snapshot: ApplySnapshot | undefined;
  try {
    fs.writeFileSync(tmp, patch, { flag: "wx", mode: 0o600 });
    repository = createPatchRepository(targetRoot, deadline);
    const reportedPaths = readPatchPaths(repository, tmp);
    const postModes = parsePatchPostModes(patch, reportedPaths);
    const touchedPaths = deduplicatePaths(reportedPaths);
    fs.writeFileSync(tmp, reorderPatchSections(patch, reportedPaths));
    populatePatchIndex(repository, targetRoot, touchedPaths);
    runPatchGit(repository, patchApplyArgs(["--check", tmp]));
    snapshot = snapshotApplyPaths(targetRoot, touchedPaths);
    runPatchGit(repository, patchApplyArgs([tmp]));
    attempted = true;
    materializePatchIndex(repository, targetRoot, touchedPaths);
    preserveUnrepresentedFileModes(targetRoot, snapshot);
    assertPatchPostModes(targetRoot, postModes);
    assertPatchPostContents(repository, targetRoot, patch, reportedPaths);
    fsyncAppliedPaths(targetRoot, touchedPaths);
    return true;
  } catch (error) {
    if (attempted && snapshot) {
      try {
        restoreApplySnapshot(repoRoot, snapshot);
      } catch (rollbackError) {
        throw new Error(
          `patch application reached an uncertain state and rollback failed: ${errorMessage(rollbackError)}`,
          { cause: error },
        );
      }
    }
    return false;
  } finally {
    removePatchRepository(repository);
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
}

/** Verify that retained durable delivery material is still present in the target tree. */
export function verifyAppliedPatch(
  repoRoot: string,
  patchPath: string,
  expectedHash: string,
  trustedPatchRoot: string,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
): boolean {
  const patch = readContainedArtifactBytes(
    trustedPatchRoot,
    patchPath,
    "workflow delivery patch",
    MAX_GIT_OUTPUT_BYTES,
  );
  const actualHash = createHash("sha256").update(patch).digest("hex");
  if (actualHash !== expectedHash || containsGitlink(patch)) {
    throw new Error("workflow delivery patch is missing, changed, or unsupported");
  }
  const tmp = patchTmpPath();
  const deadline = Date.now() + normalizeTimeout(timeoutMs);
  const targetRoot = fs.realpathSync(repoRoot);
  let repository: PatchRepository | undefined;
  try {
    fs.writeFileSync(tmp, patch, { flag: "wx", mode: 0o600 });
    repository = createPatchRepository(targetRoot, deadline);
    const reportedPaths = readPatchPaths(repository, tmp);
    const postModes = parsePatchPostModes(patch, reportedPaths);
    assertPatchPostModes(targetRoot, postModes);
    assertPatchPostContents(repository, targetRoot, patch, reportedPaths);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT" || /delivery patch/.test(errorMessage(error))) throw error;
    return false;
  } finally {
    removePatchRepository(repository);
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
}

interface PatchPostMode {
  path: Buffer;
  mode: "100644" | "100755" | "120000" | null;
}

function parsePatchPostModes(patch: Buffer, paths: Buffer[]): PatchPostMode[] {
  const sections: Array<PatchPostMode["mode"] | undefined> = [];
  let section = -1;
  let inHeader = false;
  for (const line of patch.toString("latin1").split("\n")) {
    if (line.startsWith("diff --git ")) {
      sections.push(undefined);
      section++;
      inHeader = true;
      continue;
    }
    if (!inHeader || section < 0) continue;
    let mode: string | null | undefined;
    if (line.startsWith("new file mode ")) mode = line.slice("new file mode ".length);
    else if (line.startsWith("new mode ")) mode = line.slice("new mode ".length);
    else if (line.startsWith("deleted file mode ")) mode = null;
    else if (line.startsWith("--- ") || line === "GIT binary patch" || line.startsWith("@@ ")) {
      inHeader = false;
      continue;
    }
    if (mode !== undefined) {
      if (mode !== null && !["100644", "100755", "120000"].includes(mode)) {
        throw new Error(`patch contains unsupported post-apply mode: ${mode}`);
      }
      sections[section] = mode as PatchPostMode["mode"];
    }
  }
  if (sections.length !== paths.length) {
    throw new Error("patch sections do not match NUL-delimited changed paths");
  }
  const byPath = new Map<string, PatchPostMode>();
  for (let index = 0; index < sections.length; index++) {
    const mode = sections[index];
    if (mode === undefined) continue;
    const entryPath = Buffer.from(paths[index]!);
    byPath.set(entryPath.toString("base64"), { path: entryPath, mode });
  }
  return [...byPath.values()];
}

function reorderPatchSections(patch: Buffer, paths: Buffer[]): Buffer {
  const { prefix, sections: values } = splitPatchSections(patch, paths.length);
  const sections = values.map((value, index) => {
    const headerEndCandidates = ["\n--- ", "\nGIT binary patch", "\n@@ "]
      .map((needle) => value.indexOf(Buffer.from(needle)))
      .filter((candidate) => candidate >= 0);
    const headerEnd = headerEndCandidates.length > 0 ? Math.min(...headerEndCandidates) : value.length;
    const header = value.subarray(0, headerEnd).toString("latin1");
    const deletion = /^deleted file mode /m.test(header);
    return { value, path: paths[index]!, deletion, index };
  });
  sections.sort((left, right) => {
    if (left.deletion !== right.deletion) return left.deletion ? -1 : 1;
    const depthDifference = left.deletion
      ? pathDepth(right.path) - pathDepth(left.path)
      : pathDepth(left.path) - pathDepth(right.path);
    return depthDifference || left.index - right.index;
  });
  return Buffer.concat([prefix, ...sections.map((section) => section.value)]);
}

function deduplicatePaths(paths: Buffer[]): Buffer[] {
  const unique = new Map<string, Buffer>();
  for (const entry of paths) {
    const key = entry.toString("base64");
    if (!unique.has(key)) unique.set(key, Buffer.from(entry));
  }
  return [...unique.values()];
}

function preserveUnrepresentedFileModes(repoRoot: string, snapshot: ApplySnapshot): void {
  for (const entry of snapshot.paths) {
    if (entry.kind !== "file") continue;
    const actual = readFilesystemEntryNoFollow(repoRoot, entry.relative);
    if (
      !actual
      || !actual.path.equals(entry.relative)
      || (actual.mode !== "100644" && actual.mode !== "100755")
    ) continue;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(entry.path);
    } catch (error: any) {
      if (["ENOENT", "ENOTDIR"].includes(error?.code)) continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const before = entry.mode & 0o7777;
    const after = stat.mode & 0o7777;
    const beforeExecutable = (before & 0o111) !== 0;
    const afterExecutable = (after & 0o111) !== 0;
    const desired = beforeExecutable === afterExecutable
      ? before
      : (before & ~0o111) | (after & 0o111);
    if (desired !== after) fs.chmodSync(entry.path, desired);
  }
}

function assertPatchPostModes(repoRoot: string, expectations: PatchPostMode[]): void {
  for (const expectation of expectations) {
    const actual = readFilesystemEntryNoFollow(repoRoot, expectation.path);
    if (expectation.mode === null) {
      if (actual?.path.equals(expectation.path)) {
        throw new Error("applied patch did not preserve its deleted path postcondition");
      }
      continue;
    }
    if (!actual || !actual.path.equals(expectation.path) || actual.mode !== expectation.mode) {
      throw new Error("applied patch mode postcondition is not present in the target tree");
    }
  }
}

function assertPatchPostContents(
  repository: PatchRepository,
  repoRoot: string,
  patch: Buffer,
  paths: Buffer[],
): void {
  const sections = splitPatchSections(patch, paths.length).sections;
  const oidLength = repository.objectFormat === "sha256" ? 64 : 40;
  const byPath = new Map<string, { path: Buffer; oid: string | null }>();
  for (let index = 0; index < sections.length; index++) {
    const text = sections[index]!.toString("latin1");
    const match = text.match(/^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: [0-7]{6})?$/m);
    const hasContent = /\n(?:--- |GIT binary patch)/.test(text);
    if (!match) {
      if (hasContent) throw new Error("delivery patch content lacks a full index postcondition");
      continue;
    }
    const nextOid = match[2]!;
    if (match[1]!.length > oidLength || nextOid.length > oidLength) {
      throw new Error("delivery patch does not use the target repository object format");
    }
    const entryPath = Buffer.from(paths[index]!);
    byPath.set(entryPath.toString("base64"), {
      path: entryPath,
      oid: /^0+$/.test(nextOid) ? null : nextOid,
    });
  }
  for (const expectation of byPath.values()) {
    const actual = readFilesystemEntryNoFollow(repoRoot, expectation.path);
    if (expectation.oid === null) {
      if (actual?.path.equals(expectation.path)) {
        throw new Error("applied patch deleted-content postcondition is not present");
      }
      continue;
    }
    if (!actual || !actual.path.equals(expectation.path)) {
      throw new Error("applied patch content postcondition is not present");
    }
    const oid = stripOneLineEnding(runPatchGit(repository, [
      "hash-object",
      "--no-filters",
      "--stdin",
    ], actual.content).toString("ascii"));
    if (!oid.startsWith(expectation.oid)) {
      throw new Error("applied patch content postcondition changed in the target tree");
    }
  }
}

function splitPatchSections(
  patch: Buffer,
  expectedCount: number,
): { prefix: Buffer; sections: Buffer[] } {
  const marker = Buffer.from("diff --git ");
  const newlineMarker = Buffer.from("\ndiff --git ");
  const starts: number[] = [];
  if (patch.subarray(0, marker.length).equals(marker)) starts.push(0);
  let offset = 0;
  while (true) {
    const index = patch.indexOf(newlineMarker, offset);
    if (index < 0) break;
    starts.push(index + 1);
    offset = index + newlineMarker.length;
  }
  if (starts.length !== expectedCount) {
    throw new Error("patch sections do not match NUL-delimited changed paths");
  }
  return {
    prefix: starts.length > 0 ? Buffer.from(patch.subarray(0, starts[0])) : Buffer.from(patch),
    sections: starts.map((start, index) => Buffer.from(
      patch.subarray(start, index + 1 < starts.length ? starts[index + 1]! : patch.length),
    )),
  };
}

export function writeRescuePatch(
  dir: string,
  runId: string,
  id: number,
  label: string,
  patchInput: PatchInput,
): string {
  ensurePrivateArtifactDirectory(dir);
  const safeRun = runId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "run";
  const safeLabel = label.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "agent";
  const nonce = randomBytes(6).toString("hex");
  const file = path.join(dir, `${safeRun}-${id}-${safeLabel}-${nonce}.patch`);
  writeArtifactFile(file, withTrailingNewline(patchInput), { trustedRoot: dir });
  return file;
}

interface DirectoryIdentity {
  device: number;
  inode: number;
}

interface RegistrationIdentity extends DirectoryIdentity {
  gitDir: string;
  commonDir: string;
  worktreePath: string;
}

/** Remove only the supplied owned worktree from its canonical repository. */
export function removeWorktree(worktree: Worktree): void {
  const root = directoryIdentity(worktree.path);
  if (root && (root.device !== worktree.device || root.inode !== worktree.inode)) return;
  if (!root && pathExistsNoFollow(worktree.path)) return;

  const adminParent = path.dirname(worktree.gitDir);
  const savedAdminIdentity = { device: worktree.gitDirDevice, inode: worktree.gitDirInode };
  let registration: RegistrationIdentity | undefined;
  if (root) {
    const discovered = discoverRegistrationAtPath(worktree.path, worktree.gitCommonDir);
    if (discovered) {
      if (
        discovered.device !== worktree.gitDirDevice
        || discovered.inode !== worktree.gitDirInode
        || !samePotentialPath(path.dirname(discovered.gitDir), adminParent)
      ) return;
      registration = discovered;
    } else {
      const search = findDirectoryByIdentity(adminParent, savedAdminIdentity);
      if (search.state === "unverifiable") return;
      if (search.state === "found") return;
      if (pathExistsNoFollow(path.join(worktree.path, ".git"))) return;
    }
  } else {
    const search = findDirectoryByIdentity(adminParent, savedAdminIdentity);
    if (search.state === "unverifiable") return;
    if (search.state === "found") {
      registration = validateRegistrationDirectory(
        search.path,
        worktree.gitCommonDir,
        worktree.path,
        savedAdminIdentity,
      );
      if (!registration) return;
    }
  }

  if (registration && !unregisterRegistration(worktree.repoRoot, registration, worktree.path)) return;
  if (root) tryRemoveOwnedDirectory(worktree.path, root);
  const raw = directoryIdentity(worktree.rawObjectDirectory);
  if (
    raw
    && raw.device === worktree.rawObjectDevice
    && raw.inode === worktree.rawObjectInode
    && ownsRawObjectDirectory(worktree)
  ) {
    tryRemoveOwnedDirectory(worktree.rawObjectDirectory, raw);
  }
}

function discoverRegistrationAtPath(
  worktreePath: string,
  expectedCommonDir: string,
): RegistrationIdentity | undefined {
  const gitDirPointer = readWorktreeGitDirPointer(worktreePath);
  if (!gitDirPointer) return undefined;
  let gitDir: string;
  try {
    gitDir = fs.realpathSync(gitDirPointer);
  } catch {
    return undefined;
  }
  return validateRegistrationDirectory(gitDir, expectedCommonDir, worktreePath);
}

function readWorktreeGitDirPointer(worktreePath: string): string | undefined {
  try {
    const dotGit = path.join(worktreePath, ".git");
    const stat = fs.lstatSync(dotGit);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return undefined;
    const match = fs.readFileSync(dotGit, "utf8").trim().match(/^gitdir:\s+(.+)$/);
    if (!match) return undefined;
    return path.resolve(worktreePath, match[1]);
  } catch {
    return undefined;
  }
}

function validateRegistrationDirectory(
  gitDir: string,
  expectedCommonDir: string,
  expectedWorktreePath: string,
  expectedIdentity?: DirectoryIdentity,
): RegistrationIdentity | undefined {
  try {
    const stat = fs.lstatSync(gitDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    if (expectedIdentity && (
      stat.dev !== expectedIdentity.device || stat.ino !== expectedIdentity.inode
    )) return undefined;
    const commonFile = path.join(gitDir, "commondir");
    const commonStat = fs.lstatSync(commonFile);
    if (!commonStat.isFile() || commonStat.isSymbolicLink() || commonStat.size > 4096) return undefined;
    const commonPath = fs.readFileSync(commonFile, "utf8").trim();
    const commonDir = fs.realpathSync(path.resolve(gitDir, commonPath));
    if (commonDir !== expectedCommonDir) return undefined;
    const registeredPath = readRegisteredWorktreePath(gitDir);
    if (!registeredPath || !samePotentialPath(registeredPath, expectedWorktreePath)) return undefined;
    return { gitDir, commonDir, device: stat.dev, inode: stat.ino, worktreePath: registeredPath };
  } catch {
    return undefined;
  }
}

function readRegisteredWorktreePath(gitDir: string): string | undefined {
  try {
    const pointer = path.join(gitDir, "gitdir");
    const stat = fs.lstatSync(pointer);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return undefined;
    const dotGit = path.resolve(gitDir, fs.readFileSync(pointer, "utf8").trim());
    if (path.basename(dotGit) !== ".git") return undefined;
    return path.dirname(dotGit);
  } catch {
    return undefined;
  }
}

type DirectoryIdentitySearch =
  | { state: "found"; path: string }
  | { state: "not-found" }
  | { state: "unverifiable" };

function findDirectoryByIdentity(parent: string, identity: DirectoryIdentity): DirectoryIdentitySearch {
  try {
    for (const name of fs.readdirSync(parent)) {
      const candidate = path.join(parent, name);
      const current = directoryIdentity(candidate);
      if (current?.device === identity.device && current.inode === identity.inode) {
        return { state: "found", path: candidate };
      }
    }
    return { state: "not-found" };
  } catch {
    return { state: "unverifiable" };
  }
}

function unregisterRegistration(
  repoRoot: string,
  registration: RegistrationIdentity,
  expectedPath: string,
): boolean {
  const current = validateRegistrationDirectory(
    registration.gitDir,
    registration.commonDir,
    expectedPath,
    registration,
  );
  if (!current) return !pathExistsNoFollow(registration.gitDir);
  tryGit(repoRoot, ["worktree", "remove", "--force", "--force", current.worktreePath]);
  const remaining = directoryIdentity(registration.gitDir);
  return !remaining && !pathExistsNoFollow(registration.gitDir);
}

function samePotentialPath(left: string, right: string): boolean {
  try {
    return canonicalPotentialPath(left) === canonicalPotentialPath(right);
  } catch {
    return false;
  }
}

function canonicalPotentialPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    return path.join(fs.realpathSync(path.dirname(value)), path.basename(value));
  }
}

function directoryIdentity(value: string): DirectoryIdentity | undefined {
  try {
    const stat = fs.lstatSync(value);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    return { device: stat.dev, inode: stat.ino };
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function pathExistsNoFollow(value: string): boolean {
  try {
    fs.lstatSync(value);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function tryRemoveOwnedDirectory(value: string, identity: DirectoryIdentity): void {
  try {
    const current = directoryIdentity(value);
    if (!current) return;
    if (current.device !== identity.device || current.inode !== identity.inode) return;
    removeDirectoryTreeNoFollow(Buffer.from(value));
  } catch {
    // Best effort after exact ownership validation; retained paths remain diagnosable.
  }
}

function removeDirectoryTreeNoFollow(root: Buffer): void {
  const deadline = Date.now() + DEFAULT_GIT_TIMEOUT_MS;
  const stack: Array<{ value: Buffer; visited: boolean }> = [{ value: root, visited: false }];
  let nodes = 0;
  while (stack.length > 0) {
    if (Date.now() >= deadline) throw new Error("owned worktree cleanup exceeded its deadline");
    const entry = stack.pop()!;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(entry.value);
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    nodes++;
    if (nodes > 200_000) throw new Error("owned worktree cleanup exceeds 200000 nodes");
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fs.unlinkSync(entry.value);
      continue;
    }
    if (entry.visited) {
      fs.rmdirSync(entry.value);
      continue;
    }
    fs.chmodSync(entry.value, (stat.mode & 0o7777) | 0o700);
    stack.push({ value: entry.value, visited: true });
    const children = fs.readdirSync(entry.value, { encoding: "buffer" }) as Buffer[];
    const separator = Buffer.from(path.sep);
    for (const child of children) {
      stack.push({ value: Buffer.concat([entry.value, separator, child]), visited: false });
    }
  }
}

function assertOwnedWorktree(worktree: Worktree, deadline: number): void {
  if (!ownsWorktree(worktree, deadline)) {
    throw new Error(`worktree ownership changed or path was replaced: ${worktree.path}`);
  }
}

function ownsWorktree(
  worktree: Worktree,
  deadline = Date.now() + DEFAULT_GIT_TIMEOUT_MS,
): boolean {
  try {
    if (Date.now() >= deadline) return false;
    const stat = fs.lstatSync(worktree.path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if (stat.dev !== worktree.device || stat.ino !== worktree.inode) return false;
    const registration = discoverRegistrationAtPath(worktree.path, worktree.gitCommonDir);
    if (
      !registration
      || registration.gitDir !== worktree.gitDir
      || registration.device !== worktree.gitDirDevice
      || registration.inode !== worktree.gitDirInode
    ) return false;
    const rawObjectStat = fs.lstatSync(worktree.rawObjectDirectory);
    if (
      !rawObjectStat.isDirectory()
      || rawObjectStat.isSymbolicLink()
      || rawObjectStat.dev !== worktree.rawObjectDevice
      || rawObjectStat.ino !== worktree.rawObjectInode
      || !ownsRawObjectDirectory(worktree)
    ) return false;
    return true;
  } catch {
    return false;
  }
}

function writeRawObjectOwnerMarker(directory: string, token: string): void {
  fs.writeFileSync(path.join(directory, RAW_OBJECT_OWNER_MARKER), `${token}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

function ownsRawObjectDirectory(worktree: Worktree): boolean {
  try {
    const markerPath = path.join(worktree.rawObjectDirectory, RAW_OBJECT_OWNER_MARKER);
    const stat = fs.lstatSync(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128) return false;
    return fs.readFileSync(markerPath, "utf8").trim() === worktree.rawObjectToken;
  } catch {
    return false;
  }
}

interface PatchRepository {
  path: string;
  identity: DirectoryIdentity;
  objectFormat: "sha1" | "sha256";
  env: NodeJS.ProcessEnv;
  deadline: number;
}

function createPatchRepository(repoRoot: string, deadline: number): PatchRepository {
  const canonicalRoot = fs.realpathSync(repoRoot);
  const objectFormat = gitLine(canonicalRoot, ["rev-parse", "--show-object-format"], {
    timeoutMs: remainingTimeout(deadline),
  });
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new Error(`unsupported Git object format: ${objectFormat}`);
  }
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-git-apply-"));
  const identity = directoryIdentity(repositoryPath)!;
  try {
    gitBuffer(path.dirname(repositoryPath), [
      "init",
      "--bare",
      "--quiet",
      `--object-format=${objectFormat}`,
      repositoryPath,
    ], { timeoutMs: remainingTimeout(deadline) });
    return {
      path: repositoryPath,
      identity,
      objectFormat,
      deadline,
      env: {
        GIT_DIR: repositoryPath,
        GIT_INDEX_FILE: path.join(repositoryPath, "index"),
        GIT_OPTIONAL_LOCKS: "0",
      },
    };
  } catch (error) {
    tryRemoveOwnedDirectory(repositoryPath, identity);
    throw error;
  }
}

function removePatchRepository(repository: PatchRepository | undefined): void {
  if (repository) tryRemoveOwnedDirectory(repository.path, repository.identity);
}

function runPatchGit(
  repository: PatchRepository,
  args: string[],
  input?: Uint8Array,
): Buffer {
  return gitBuffer(repository.path, args, {
    timeoutMs: remainingTimeout(repository.deadline),
    env: repository.env,
    input,
  });
}

function patchApplyArgs(args: string[]): string[] {
  return [
    "-c", "apply.whitespace=nowarn",
    "-c", "apply.ignoreWhitespace=false",
    "-c", "core.filemode=true",
    "-c", "core.autocrlf=false",
    "-c", "core.eol=lf",
    "-c", "core.safecrlf=false",
    "-c", `core.attributesFile=${os.devNull}`,
    "apply",
    "--cached",
    "--whitespace=nowarn",
    ...args,
  ];
}

function readPatchPaths(repository: PatchRepository, patchPath: string): Buffer[] {
  const output = runPatchGit(repository, patchApplyArgs(["--numstat", "-z", patchPath]));
  return parseNumstat(output).paths;
}

function populatePatchIndex(
  repository: PatchRepository,
  repoRoot: string,
  paths: Buffer[],
): void {
  runPatchGit(repository, ["read-tree", "--empty"]);
  const records: Buffer[] = [];
  for (const entryPath of paths) {
    const entry = readFilesystemEntryNoFollow(repoRoot, entryPath);
    if (!entry) continue;
    const oid = stripOneLineEnding(runPatchGit(repository, [
      "hash-object",
      "-w",
      "--no-filters",
      "--stdin",
    ], entry.content).toString("ascii"));
    records.push(
      Buffer.from(`${entry.mode} ${oid}\t`, "ascii"),
      entry.path,
      Buffer.from([0]),
    );
  }
  if (records.length > 0) {
    runPatchGit(repository, ["update-index", "-z", "--index-info"], Buffer.concat(records));
  }
}

function materializePatchIndex(
  repository: PatchRepository,
  repoRoot: string,
  paths: Buffer[],
): void {
  const entries = parseIndexEntries(runPatchGit(repository, ["ls-files", "--stage", "-z"]));
  if (entries.some((entry) => entry.stage !== "0")) {
    throw new Error("applied patch produced an unmerged private index");
  }
  const expected = new Set(paths.map((entry) => entry.toString("base64")));
  const byPath = new Map(entries.map((entry) => [entry.path.toString("base64"), entry]));
  if ([...byPath.keys()].some((key) => !expected.has(key))) {
    throw new Error("applied patch produced an unexpected private-index path");
  }
  const root = Buffer.from(repoRoot);
  const deepestFirst = [...paths].sort((left, right) =>
    pathDepth(right) - pathDepth(left) || Buffer.compare(right, left));
  for (const entryPath of deepestFirst) {
    if (byPath.has(entryPath.toString("base64"))) continue;
    const target = repositoryPath(root, entryPath);
    try {
      const stat = fs.lstatSync(target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        try {
          fs.rmdirSync(target);
        } catch (error: any) {
          if (error?.code !== "ENOTEMPTY") throw error;
        }
      } else {
        fs.unlinkSync(target);
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  pruneDirectoriesReplacedByLeaves(root, paths, byPath.values());

  const shallowestFirst = [...byPath.values()].sort((left, right) =>
    pathDepth(left.path) - pathDepth(right.path) || Buffer.compare(left.path, right.path));
  for (const entry of shallowestFirst) {
    if (!["100644", "100755", "120000"].includes(entry.mode)) {
      throw new Error(`applied patch produced unsupported mode ${entry.mode}`);
    }
    const target = repositoryPath(root, entry.path);
    try {
      const stat = fs.lstatSync(target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmdirSync(target);
      else fs.unlinkSync(target);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    const content = readPatchBlob(repository, entry.oid);
    const parent = bufferParent(target);
    fs.mkdirSync(parent, { recursive: true, mode: 0o777 });
    if (entry.mode === "120000") {
      fs.symlinkSync(content as any, target as any);
    } else {
      fs.writeFileSync(target, content, {
        flag: "wx",
        mode: entry.mode === "100755" ? 0o777 : 0o666,
      });
    }
  }
  pruneEmptyPatchParents(root, paths);
}

function readPatchBlob(repository: PatchRepository, oid: string): Buffer {
  const content = gitBuffer(repository.path, ["cat-file", "blob", oid], {
    timeoutMs: remainingTimeout(repository.deadline),
    env: repository.env,
    maxBuffer: MAX_ROLLBACK_SNAPSHOT_BYTES + 1024,
  });
  if (content.length > MAX_ROLLBACK_SNAPSHOT_BYTES) {
    throw new Error(`applied patch blob exceeds ${MAX_ROLLBACK_SNAPSHOT_BYTES} bytes`);
  }
  return content;
}

function pathDepth(value: Buffer): number {
  let depth = 1;
  for (const byte of value) if (byte === 0x2f) depth++;
  return depth;
}

function pruneDirectoriesReplacedByLeaves(
  root: Buffer,
  paths: Buffer[],
  finalEntries: Iterable<IndexEntry>,
): void {
  const candidates = new Map<string, Buffer>();
  for (const entry of finalEntries) {
    if (!paths.some((candidate) => isDescendantPath(candidate, entry.path))) continue;
    const target = repositoryPath(root, entry.path);
    for (const relative of paths) {
      if (!isDescendantPath(relative, entry.path)) continue;
      for (const directory of parentDirectories(root, relative)) {
        if (directory.equals(target) || (
          directory.length > target.length
          && directory.subarray(0, target.length).equals(target)
          && directory[target.length] === Buffer.from(path.sep)[0]
        )) {
          candidates.set(directory.toString("hex"), directory);
        }
      }
    }
  }
  for (const directory of [...candidates.values()].sort((left, right) => right.length - left.length)) {
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      fs.rmdirSync(directory);
    } catch (error: any) {
      if (!["ENOENT", "ENOTEMPTY"].includes(error?.code)) throw error;
    }
  }
}

function pruneEmptyPatchParents(root: Buffer, paths: Buffer[]): void {
  const candidates = new Map<string, Buffer>();
  for (const relative of paths) {
    for (const directory of parentDirectories(root, relative)) {
      if (directory.equals(root)) continue;
      candidates.set(directory.toString("hex"), directory);
    }
  }
  for (const directory of [...candidates.values()].sort((left, right) => right.length - left.length)) {
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      fs.rmdirSync(directory);
    } catch (error: any) {
      if (!["ENOENT", "ENOTDIR", "ENOTEMPTY"].includes(error?.code)) throw error;
    }
  }
}

function parseNumstat(value: Buffer): Pick<WorktreeDiff, "filesChanged" | "insertions" | "deletions" | "paths"> {
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  const paths: Buffer[] = [];
  let start = 0;
  for (let index = 0; index <= value.length; index++) {
    if (index < value.length && value[index] !== 0) continue;
    if (index === start) {
      start = index + 1;
      continue;
    }
    const record = value.subarray(start, index);
    start = index + 1;
    const firstTab = record.indexOf(0x09);
    const secondTab = firstTab < 0 ? -1 : record.indexOf(0x09, firstTab + 1);
    if (firstTab < 0 || secondTab < 0 || secondTab === record.length - 1) {
      throw new Error("git returned malformed NUL-delimited numstat output");
    }
    filesChanged++;
    const added = record.subarray(0, firstTab).toString("ascii");
    const removed = record.subarray(firstTab + 1, secondTab).toString("ascii");
    if (added !== "-") insertions += Number(added) || 0;
    if (removed !== "-") deletions += Number(removed) || 0;
    paths.push(Buffer.from(record.subarray(secondTab + 1)));
  }
  return { filesChanged, insertions, deletions, paths };
}

function containsGitlink(patch: Buffer): boolean {
  return /^(?:(?:old|new|new file|deleted file) mode 160000|index [0-9a-f]+\.\.[0-9a-f]+ 160000)$/m
    .test(patch.toString("latin1"));
}

function withTrailingNewline(input: PatchInput): Buffer {
  const value = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  if (value.length === 0 || value[value.length - 1] === 0x0a) return value;
  return Buffer.concat([value, Buffer.from("\n")]);
}

function snapshotApplyPaths(repoRoot: string, paths: Buffer[]): ApplySnapshot {
  const root = Buffer.from(repoRoot);
  const roots = minimalPaths(paths).map((relative) => ({
    path: repositoryPath(root, relative),
    relative,
  }));
  const snapshots: PathSnapshot[] = [];
  const directories = new Map<string, { path: Buffer; existed: boolean; mode?: number }>();
  let totalBytes = 0;
  let nodes = 0;
  for (const snapshotRoot of roots) {
    for (const directory of parentDirectories(root, snapshotRoot.relative)) {
      const key = directory.toString("hex");
      if (directories.has(key)) continue;
      try {
        const directoryStat = fs.lstatSync(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
          throw new Error("patch target parent is not a real directory");
        }
        directories.set(key, {
          path: directory,
          existed: true,
          mode: directoryStat.mode & 0o7777,
        });
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
        directories.set(key, { path: directory, existed: false });
      }
    }
    const stack = [{ path: snapshotRoot.path, relative: snapshotRoot.relative, root: true }];
    while (stack.length > 0) {
      const entry = stack.pop()!;
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(entry.path);
      } catch (error: any) {
        if (error?.code === "ENOENT" && entry.root) {
          snapshots.push({ path: entry.path, relative: entry.relative, kind: "missing" });
          continue;
        }
        throw error;
      }
      nodes++;
      if (nodes > 200_000) throw new Error("patch rollback snapshot exceeds 200000 nodes");
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        snapshots.push({
          path: entry.path,
          relative: entry.relative,
          kind: "directory",
          mode: stat.mode & 0o7777,
        });
        const children = fs.readdirSync(entry.path, { encoding: "buffer" }) as Buffer[];
        for (const child of children) {
          stack.push({
            path: Buffer.concat([entry.path, Buffer.from(path.sep), child]),
            relative: Buffer.concat([entry.relative, Buffer.from("/"), child]),
            root: false,
          });
        }
        continue;
      }
      if (stat.isFile()) {
        if (stat.nlink > 1) throw new Error("patch rollback cannot preserve a hard-linked file");
        totalBytes += stat.size;
        if (totalBytes > MAX_ROLLBACK_SNAPSHOT_BYTES) {
          throw new Error(`patch rollback snapshot exceeds ${MAX_ROLLBACK_SNAPSHOT_BYTES} bytes`);
        }
        snapshots.push({
          path: entry.path,
          relative: entry.relative,
          kind: "file",
          data: fs.readFileSync(entry.path),
          mode: stat.mode & 0o7777,
        });
        continue;
      }
      if (stat.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(entry.path, { encoding: "buffer" }) as Buffer;
        snapshots.push({
          path: entry.path,
          relative: entry.relative,
          kind: "symlink",
          target: Buffer.from(linkTarget),
        });
        continue;
      }
      throw new Error("patch rollback supports only files, directories, symlinks, and missing paths");
    }
  }
  return {
    roots,
    paths: snapshots,
    directories: [...directories.values()].sort((left, right) => right.path.length - left.path.length),
  };
}

function minimalPaths(paths: Buffer[]): Buffer[] {
  const sorted = deduplicatePaths(paths).sort((left, right) =>
    left.length - right.length || Buffer.compare(left, right));
  const roots: Buffer[] = [];
  for (const candidate of sorted) {
    if (!roots.some((root) => isDescendantPath(candidate, root))) roots.push(candidate);
  }
  return roots;
}

function restoreApplySnapshot(repoRoot: string, snapshot: ApplySnapshot): void {
  for (const root of [...snapshot.roots].sort((left, right) => right.path.length - left.path.length)) {
    removeDirectoryTreeNoFollow(root.path);
  }
  const snapshotDirectories = snapshot.paths
    .filter((entry): entry is Extract<PathSnapshot, { kind: "directory" }> => entry.kind === "directory")
    .sort((left, right) => left.path.length - right.path.length);
  for (const entry of snapshotDirectories) {
    fs.mkdirSync(entry.path, { recursive: true, mode: 0o700 });
  }
  for (const entry of snapshot.paths) {
    if (entry.kind === "missing" || entry.kind === "directory") continue;
    const parent = bufferParent(entry.path);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (entry.kind === "file") {
      fs.writeFileSync(entry.path, entry.data, { mode: entry.mode });
      fs.chmodSync(entry.path, entry.mode);
    } else {
      fs.symlinkSync(entry.target as any, entry.path as any);
    }
  }
  for (const entry of snapshotDirectories.sort((left, right) => right.path.length - left.path.length)) {
    fs.chmodSync(entry.path, entry.mode);
  }
  for (const directory of snapshot.directories) {
    if (directory.existed) continue;
    try {
      fs.rmdirSync(directory.path);
    } catch (error: any) {
      if (!["ENOENT", "ENOTEMPTY"].includes(error?.code)) throw error;
    }
  }
  for (const directory of snapshot.directories) {
    if (!directory.existed || directory.mode === undefined) continue;
    fs.chmodSync(directory.path, directory.mode);
  }
  fsyncAppliedPaths(repoRoot, snapshot.paths.map((entry) => entry.relative));
}

function bufferParent(value: Buffer): Buffer {
  const separator = Buffer.from(path.sep)[0]!;
  const index = value.lastIndexOf(separator);
  if (index <= 0) throw new Error("cannot resolve patch path parent");
  return Buffer.from(value.subarray(0, index));
}

function fsyncAppliedPaths(repoRoot: string, paths: Buffer[]): void {
  const root = Buffer.from(repoRoot);
  const directories = new Map<string, Buffer>();
  directories.set(root.toString("hex"), root);
  for (const relative of paths) {
    const target = repositoryPath(root, relative);
    try {
      const stat = fs.lstatSync(target);
      if (stat.isFile()) fsyncFile(target);
    } catch (error: any) {
      if (!["ENOENT", "ENOTDIR"].includes(error?.code)) throw error;
    }
    for (const directory of parentDirectories(root, relative)) {
      directories.set(directory.toString("hex"), directory);
    }
  }
  for (const directory of directories.values()) fsyncDirectory(directory);
}

function fsyncFile(file: Buffer): void {
  const fd = fs.openSync(file, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDirectory(directory: Buffer): void {
  let fd: number | undefined;
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const constants = fs.constants as Record<string, number>;
    const flags = fs.constants.O_RDONLY
      | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_DIRECTORY ?? 0);
    fd = fs.openSync(directory, flags);
    if (!fs.fstatSync(fd).isDirectory()) throw new Error("fsync target is not a directory");
    fs.fsyncSync(fd);
  } catch (error: any) {
    if (![
      "ENOENT",
      "ENOTDIR",
      "ELOOP",
      "EINVAL",
      "ENOTSUP",
      "EISDIR",
      "EBADF",
    ].includes(error?.code)) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function repositoryPath(root: Buffer, relative: Buffer): Buffer {
  const components = splitPath(relative);
  if (components.length === 0 || components.some((part) =>
    part.length === 0 || part.equals(Buffer.from(".")) || part.equals(Buffer.from("..")))) {
    throw new Error("patch contains an unsafe repository-relative path");
  }
  const separator = Buffer.from(path.sep);
  return Buffer.concat([root, separator, ...interleave(components, separator)]);
}

function parentDirectories(root: Buffer, relative: Buffer): Buffer[] {
  const components = splitPath(relative);
  const separator = Buffer.from(path.sep);
  const result = [root];
  for (let count = 1; count < components.length; count++) {
    result.push(Buffer.concat([root, separator, ...interleave(components.slice(0, count), separator)]));
  }
  return result;
}

function splitPath(value: Buffer): Buffer[] {
  if (value.length === 0 || value[0] === 0x2f || value.includes(0)) {
    throw new Error("patch contains an unsafe repository-relative path");
  }
  const result: Buffer[] = [];
  let start = 0;
  for (let index = 0; index <= value.length; index++) {
    if (index < value.length && value[index] !== 0x2f) continue;
    result.push(Buffer.from(value.subarray(start, index)));
    start = index + 1;
  }
  return result;
}

function interleave(parts: Buffer[], separator: Buffer): Buffer[] {
  const result: Buffer[] = [];
  for (let index = 0; index < parts.length; index++) {
    if (index > 0) result.push(separator);
    result.push(parts[index]!);
  }
  return result;
}

function normalizeTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error("Git operation timeout must be positive");
  return Math.max(1, Math.floor(value));
}

function remainingTimeout(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Git operation exceeded its cleanup deadline");
  return remaining;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
