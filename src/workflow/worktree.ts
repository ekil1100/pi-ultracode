/**
 * Git worktree isolation for workflow subagents.
 *
 * When an agent() call requests `isolation: 'worktree'`, the subagent runs in a
 * throwaway git worktree on a detached branch so parallel file-mutating agents
 * don't clobber each other. After the agent finishes we capture a diff; a
 * worktree with no changes is removed immediately ("auto-removed if unchanged").
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Worktree {
  path: string;
  /** cwd the subagent should use (worktree root joined with the original relative cwd). */
  agentCwd: string;
  branch: string;
  baseCommit: string;
}

export interface WorktreeDiff {
  filesChanged: number;
  insertions: number;
  deletions: number;
  diffStat: string;
  patch: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(cwd: string, args: string[]): string | undefined {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
}

/** Like tryGit but does NOT `.trim()` — required for `git diff --binary` output,
 *  whose trailing blank lines are part of the patch format and must not be stripped. */
function tryGitRaw(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return undefined;
  }
}

export function isGitRepo(cwd: string): boolean {
  return tryGit(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

/**
 * Create an isolated worktree for one subagent. Throws if `cwd` is not inside a
 * git repository (the caller falls back to a shared cwd in that case).
 */
export function createWorktree(cwd: string, runId: string, index: number): Worktree {
  const toplevel = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!toplevel) throw new Error("isolation: 'worktree' requires the working directory to be inside a git repository");

  const baseCommit = tryGit(cwd, ["rev-parse", "HEAD"]) ?? "";
  if (!baseCommit) {
    throw new Error("isolation: 'worktree' requires at least one commit in the repository");
  }

  const safeRun = runId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "run";
  const branch = `ultracode/${safeRun}-${index}`;
  const worktreePath = path.join(os.tmpdir(), `ultracode-wt-${safeRun}-${index}`);

  // Clean up any stale worktree from a crashed prior run.
  removeWorktreeQuiet(toplevel, worktreePath, branch);

  git(toplevel, ["worktree", "add", "--detach", worktreePath, baseCommit]);
  // Move onto a named branch so the diff has a stable ref and cleanup is unambiguous.
  tryGit(worktreePath, ["checkout", "-B", branch]);

  linkNodeModules(toplevel, worktreePath);

  const relativeCwd = path.relative(toplevel, path.resolve(cwd));
  const agentCwd = relativeCwd && !relativeCwd.startsWith("..") ? path.join(worktreePath, relativeCwd) : worktreePath;

  return { path: worktreePath, agentCwd, branch, baseCommit };
}

/** Stage everything and capture the diff vs the base commit. */
export function captureWorktreeDiff(worktree: Worktree): WorktreeDiff {
  tryGit(worktree.path, ["add", "-A"]);
  // core.quotepath=false keeps non-ASCII paths unquoted in the patch text (so
  // applyPatch's path parser targets the real file); --binary carries literal
  // binary patch data so binary changes are applicable + recoverable.
  const numstat = tryGit(worktree.path, ["-c", "core.quotepath=false", "diff", "--cached", "--numstat", worktree.baseCommit]) ?? "";
  const diffStat = tryGit(worktree.path, ["-c", "core.quotepath=false", "diff", "--cached", "--stat", worktree.baseCommit]) ?? "";
  const patch = tryGitRaw(worktree.path, ["-c", "core.quotepath=false", "diff", "--cached", "--binary", worktree.baseCommit]) ?? "";

  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    filesChanged++;
    const [add, del] = line.split("\t");
    if (add && add !== "-") insertions += Number(add) || 0;
    if (del && del !== "-") deletions += Number(del) || 0;
  }
  return { filesChanged, insertions, deletions, diffStat, patch };
}

export function hasChanges(diff: WorktreeDiff): boolean {
  return diff.filesChanged > 0;
}

/** Apply a captured patch back onto the original working tree. */
export function applyPatch(cwd: string, patch: string): boolean {
  if (!patch.trim()) return false;
  const paths = patchedFiles(patch);
  // Snapshot the pre-apply working-tree content of every path the patch touches,
  // so a failed apply (which leaves conflict markers + an unmerged index) can be
  // reverted to exactly this state, preserving any pre-existing uncommitted edits.
  const before = new Map<string, Buffer | null>();
  for (const p of paths) {
    try {
      before.set(p, fs.readFileSync(path.join(cwd, p)));
    } catch {
      before.set(p, null); // path does not exist yet (the patch adds it)
    }
  }
  const tmp = path.join(os.tmpdir(), `ultracode-patch-${process.pid}-${cwd.length}.patch`);
  try {
    fs.writeFileSync(tmp, patch.endsWith("\n") ? patch : `${patch}\n`);
    git(cwd, ["apply", "--3way", tmp]);
    return true;
  } catch {
    // `git apply --3way` on a real conflict writes conflict markers into the file
    // and leaves an unmerged (UU) index entry; `git checkout --` then refuses with
    // "path is unmerged". Reset the index entry and restore the pre-apply content.
    revertPatchedPaths(cwd, paths, before);
    return false;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
}

/** Every path a patch touches (adds, modifies, deletes, renames). Parses the
 *  `+++ b/<path>`, `--- a/<path>`, and `diff --git a/<x> b/<y>` headers, skipping
 *  `/dev/null`. Deletions (`+++ /dev/null`) are captured via their `--- a/` side
 *  so a failed apply can restore the deleted file too. */
function patchedFiles(patch: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string) => {
    if (p && p !== "/dev/null" && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };
  for (const line of patch.split("\n")) {
    let m = line.match(/^\+\+\+ b\/(.+)$/);
    if (m) {
      push(m[1]);
      continue;
    }
    m = line.match(/^--- a\/(.+)$/);
    if (m) {
      push(m[1]);
      continue;
    }
    m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (m) {
      push(m[1]);
      push(m[2]);
    }
  }
  return out;
}

/** Restore patched paths to their pre-apply state, clearing conflict markers + UU index. */
function revertPatchedPaths(
  cwd: string,
  paths: string[],
  before: Map<string, Buffer | null>,
): void {
  for (const p of paths) {
    // Clear any unmerged index entry left by `git apply --3way` (idempotent).
    tryGit(cwd, ["reset", "HEAD", "--", p]);
    const prev = before.get(p);
    if (prev == null) {
      // Path did not exist before apply; remove any marker file the conflict wrote.
      try {
        fs.rmSync(path.join(cwd, p), { force: true });
      } catch {
        // ignore
      }
    } else {
      try {
        fs.writeFileSync(path.join(cwd, p), prev);
      } catch {
        // best-effort revert
      }
    }
  }
}

/**
 * Persist a patch that could not be auto-applied (3-way conflict) to a durable
 * file under `<dir>/<runId>-<id>-<label>.patch`. Called before the worktree is
 * force-removed so the agent's changes are recoverable instead of lost. Includes
 * the agent sequence id so two same-label agents in one run don't overwrite each
 * other's rescue patch.
 */
export function writeRescuePatch(
  dir: string,
  runId: string,
  id: number,
  label: string,
  patch: string,
): string {
  fs.mkdirSync(dir, { recursive: true });
  const safeRun = runId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "run";
  const safeLabel = label.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "agent";
  const file = path.join(dir, `${safeRun}-${id}-${safeLabel}.patch`);
  fs.writeFileSync(file, patch.endsWith("\n") ? patch : `${patch}\n`);
  return file;
}

export function removeWorktree(worktree: Worktree): void {
  const toplevel = tryGit(worktree.path, ["rev-parse", "--show-toplevel"]);
  const repo = toplevel ?? path.dirname(worktree.path);
  removeWorktreeQuiet(repo, worktree.path, worktree.branch);
}

function removeWorktreeQuiet(repo: string, worktreePath: string, branch: string): void {
  tryGit(repo, ["worktree", "remove", "--force", worktreePath]);
  // worktree remove may fail if the dir was deleted manually; prune + rmrf to be safe.
  tryGit(repo, ["worktree", "prune"]);
  try {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  } catch {
    // ignore
  }
  tryGit(repo, ["branch", "-D", branch]);
}

function linkNodeModules(toplevel: string, worktreePath: string): void {
  const src = path.join(toplevel, "node_modules");
  const dest = path.join(worktreePath, "node_modules");
  if (!fs.existsSync(src) || fs.existsSync(dest)) return;
  try {
    fs.symlinkSync(src, dest, "dir");
  } catch {
    // unsupported filesystem; subagents just won't have node_modules linked
  }
}
