import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { hermeticGitEnvironment, stripOneLineEnding } from "./hermetic-git.ts";

const MAX_GIT_PATH_BYTES = 1024 * 1024;

export interface RepositoryContext {
  identity: string;
  cwd: string;
  repoRoot?: string;
  relativeCwd?: string;
  gitDir?: string;
  gitCommonDir?: string;
}

/** Resolve the immutable working-tree target used by resume and delivery. */
export function resolveRepositoryContext(cwd: string): RepositoryContext {
  const realCwd = fs.realpathSync(cwd);
  if (gitLine(realCwd, ["rev-parse", "--is-inside-work-tree"], true) !== "true") {
    const identity = JSON.stringify({
      kind: "directory",
      cwd: realCwd,
      cwdFile: fileIdentity(realCwd),
    });
    return { identity, cwd: realCwd };
  }

  const repoRoot = fs.realpathSync(gitLine(realCwd, ["rev-parse", "--show-toplevel"]));
  const gitDir = fs.realpathSync(gitLine(realCwd, ["rev-parse", "--path-format=absolute", "--git-dir"]));
  const gitCommonDir = fs.realpathSync(
    gitLine(realCwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  );
  const relativeCwd = path.relative(repoRoot, realCwd);
  if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) {
    throw new Error("workflow cwd must remain inside its Git working tree");
  }
  const repositoryRootCommit = gitLine(realCwd, ["rev-list", "--max-parents=0", "HEAD"], true);
  const identity = JSON.stringify({
    kind: "git-worktree",
    repoRoot,
    repoRootFile: fileIdentity(repoRoot),
    cwdFile: fileIdentity(realCwd),
    gitDir,
    gitDirFile: fileIdentity(gitDir),
    gitCommonDir,
    gitCommonDirFile: fileIdentity(gitCommonDir),
    repositoryRootCommit,
    relativeCwd,
  });
  return { identity, cwd: realCwd, repoRoot, relativeCwd, gitDir, gitCommonDir };
}

/** Read one Git plumbing line without stripping valid path whitespace. */
function gitLine(cwd: string, args: string[], optional = false): string {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: hermeticGitEnvironment(),
      maxBuffer: MAX_GIT_PATH_BYTES,
      timeout: 25_000,
      killSignal: "SIGKILL",
    });
    return stripOneLineEnding(output);
  } catch (error) {
    if (optional) return "";
    throw error;
  }
}

function fileIdentity(filePath: string): { dev: number; ino: number; birthtimeMs: number } {
  const stat = fs.statSync(filePath);
  return { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
}
