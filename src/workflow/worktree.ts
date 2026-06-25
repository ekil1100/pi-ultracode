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
  const numstat = tryGit(worktree.path, ["diff", "--cached", "--numstat", worktree.baseCommit]) ?? "";
  const diffStat = tryGit(worktree.path, ["diff", "--cached", "--stat", worktree.baseCommit]) ?? "";
  const patch = tryGit(worktree.path, ["diff", "--cached", worktree.baseCommit]) ?? "";

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
  const tmp = path.join(os.tmpdir(), `ultracode-patch-${process.pid}-${cwd.length}.patch`);
  try {
    fs.writeFileSync(tmp, patch.endsWith("\n") ? patch : `${patch}\n`);
    git(cwd, ["apply", "--3way", tmp]);
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
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
