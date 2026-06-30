import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  resolveModelSelection,
  matchModelIn,
  splitThinkingSuffix,
  type ThinkingLevel,
} from "../src/workflow/agent-runner.ts";
import { writeRescuePatch, applyPatch, captureWorktreeDiff } from "../src/workflow/worktree.ts";

const MODELS = [
  { provider: "anthropic", id: "claude-sonnet", name: "Sonnet" },
  { provider: "anthropic", id: "claude-opus", name: "Opus" },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
];
const DEFAULT = { provider: "anthropic", id: "claude-opus", name: "Opus" };

// ---------------------------------------------------------------------------
// C1: a bare ":level" pattern must keep the default model, only override thinking.
// Regression: previously matchModel("") matched every model because
// "any-id".includes("") === true, silently returning the FIRST registered model.
// ---------------------------------------------------------------------------

test("splitThinkingSuffix: bare :level yields empty base", () => {
  const a = splitThinkingSuffix(":high");
  assert.equal(a.base, "");
  assert.equal(a.thinking, "high");
  const b = splitThinkingSuffix("anthropic/claude-sonnet:high");
  assert.equal(b.base, "anthropic/claude-sonnet");
  assert.equal(b.thinking, "high");
  const c = splitThinkingSuffix("sonnet");
  assert.equal(c.base, "sonnet");
  assert.equal(c.thinking, undefined);
});

test("splitThinkingSuffix: trailing colon (empty suffix) strips to a matchable base", () => {
  // Regression: "sonnet:" used to keep base "sonnet:" (no match -> default model).
  const r = splitThinkingSuffix("sonnet:");
  assert.equal(r.base, "sonnet");
  assert.equal(r.thinking, undefined);
});

test("splitThinkingSuffix: unknown suffix (e.g. 'groq:llama') is left intact", () => {
  // A colon in a model id that isn't a thinking suffix keeps the whole string.
  const r = splitThinkingSuffix("groq:llama");
  assert.equal(r.base, "groq:llama");
  assert.equal(r.thinking, undefined);
});

test("resolveModelSelection: bare :high keeps the default model, only overrides thinking", () => {
  const r = resolveModelSelection({ pattern: ":high", defaultModel: DEFAULT, models: MODELS });
  assert.equal(r.model, DEFAULT, "default model is kept for empty-base :level pattern");
  assert.equal(r.thinkingLevel, "high");
});

test("resolveModelSelection: no pattern and no role falls back to defaults", () => {
  const r = resolveModelSelection({
    defaultModel: DEFAULT,
    defaultThinking: "medium" as ThinkingLevel,
    models: MODELS,
  });
  assert.equal(r.model, DEFAULT);
  assert.equal(r.thinkingLevel, "medium");
});

test("resolveModelSelection: real pattern matches and applies the thinking suffix", () => {
  const r = resolveModelSelection({ pattern: "sonnet:high", defaultModel: DEFAULT, models: MODELS });
  assert.equal(r.model?.id, "claude-sonnet");
  assert.equal(r.thinkingLevel, "high");
});

test("resolveModelSelection: whitespace-padded pattern still matches (trim)", () => {
  // Regression: lower was untrimmed, so " sonnet " matched nothing -> default.
  const r = resolveModelSelection({ pattern: " sonnet :high", defaultModel: DEFAULT, models: MODELS });
  assert.equal(r.model?.id, "claude-sonnet");
  assert.equal(r.thinkingLevel, "high");
});

test("resolveModelSelection: unmatched pattern falls back to the default model", () => {
  const r = resolveModelSelection({ pattern: "nope:high", defaultModel: DEFAULT, models: MODELS });
  assert.equal(r.model, DEFAULT);
  assert.equal(r.thinkingLevel, "high");
});

test("resolveModelSelection: role model/thinking are used when no per-call pattern is given", () => {
  const r = resolveModelSelection({
    roleModel: "gpt-4o",
    roleThinking: "low" as ThinkingLevel,
    defaultModel: DEFAULT,
    models: MODELS,
  });
  assert.equal(r.model?.id, "gpt-4o");
  assert.equal(r.thinkingLevel, "low");
});

test("matchModelIn: empty/whitespace pattern does not match (returns undefined, not first)", () => {
  assert.equal(matchModelIn(MODELS, ""), undefined);
  assert.equal(matchModelIn(MODELS, "   "), undefined);
  assert.equal(matchModelIn(undefined, "sonnet"), undefined);
  assert.equal(matchModelIn(MODELS, " sonnet ")?.id, "claude-sonnet", "whitespace-padded matches");
  assert.equal(matchModelIn(MODELS, "sonnet")?.id, "claude-sonnet");
  assert.equal(matchModelIn(MODELS, "anthropic/claude-opus")?.id, "claude-opus");
});

// ---------------------------------------------------------------------------
// H1: a patch that cannot be auto-applied (3-way conflict) is persisted to disk
// so the agent's work is recoverable, AND the shared tree is reverted (no
// conflict markers, no unmerged index) instead of being left corrupted.
// ---------------------------------------------------------------------------

test("writeRescuePatch: persists the patch with a sanitized filename and trailing newline", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-rescue-"));
  try {
    const p = writeRescuePatch(dir, "wf_run1", 1, "my agent", "diff --git a/x b/x\n+hello");
    assert.ok(fs.existsSync(p), "rescue patch file was written");
    assert.ok(p.endsWith(".patch"));
    assert.match(path.basename(p), /-1-/, "filename includes the agent id");
    assert.doesNotMatch(path.basename(p), /\s/, "filename has no spaces");
    assert.equal(fs.readFileSync(p, "utf8"), "diff --git a/x b/x\n+hello\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeRescuePatch: different agent ids get separate files (no silent overwrite)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-rescue2-"));
  try {
    const p1 = writeRescuePatch(dir, "wf_run2", 1, "verify", "patch-v1\n");
    const p2 = writeRescuePatch(dir, "wf_run2", 2, "verify", "patch-v2\n");
    assert.notEqual(p1, p2, "different ids produce different files");
    assert.equal(fs.readFileSync(p1, "utf8"), "patch-v1\n");
    assert.equal(fs.readFileSync(p2, "utf8"), "patch-v2\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeRescuePatch: sanitizes hostile run/label input", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-rescue3-"));
  try {
    const p = writeRescuePatch(dir, "../etc/passwd", 7, "a;b && rm -rf", "x");
    assert.ok(fs.existsSync(p));
    assert.equal(path.basename(p), "etcpasswd-7-abrm-rf.patch");
    assert.equal(fs.readFileSync(p, "utf8"), "x\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Helper: run git in a temp repo. */
function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("applyPatch: applies a clean patch and returns true", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-apply-ok-"));
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "line1\nline2\n");
    gitIn(repo, ["add", "f.txt"]);
    gitIn(repo, ["commit", "-qm", "base"]);
    const base = gitIn(repo, ["rev-parse", "HEAD"]);
    // agent branch: append a line
    gitIn(repo, ["checkout", "-qb", "agent", base]);
    fs.writeFileSync(path.join(repo, "f.txt"), "line1\nline2\nline3\n");
    gitIn(repo, ["add", "f.txt"]);
    gitIn(repo, ["commit", "-qm", "agent"]);
    const patch = gitIn(repo, ["diff", "--cached", base]);
    // shared branch at base, clean
    gitIn(repo, ["checkout", "-q", "-B", "main", base]);
    assert.equal(applyPatch(repo, patch), true);
    assert.equal(fs.readFileSync(path.join(repo, "f.txt"), "utf8"), "line1\nline2\nline3\n");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("applyPatch: on 3-way conflict, reverts the shared tree (no markers, no UU)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-apply-conflict-"));
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "line1\nline2\nline3\n");
    gitIn(repo, ["add", "f.txt"]);
    gitIn(repo, ["commit", "-qm", "base"]);
    const base = gitIn(repo, ["rev-parse", "HEAD"]);
    // agent branch: change line2 to "line2-agent"
    gitIn(repo, ["checkout", "-qb", "agent", base]);
    fs.writeFileSync(path.join(repo, "f.txt"), "line1\nline2-agent\nline3\n");
    gitIn(repo, ["add", "f.txt"]);
    gitIn(repo, ["commit", "-qm", "agent"]);
    const patch = gitIn(repo, ["diff", "--cached", base]);
    // shared branch ALSO changes line2 (conflicting)
    gitIn(repo, ["checkout", "-q", "-B", "main", base]);
    fs.writeFileSync(path.join(repo, "f.txt"), "line1\nline2-shared\nline3\n");
    gitIn(repo, ["add", "f.txt"]);
    gitIn(repo, ["commit", "-qm", "shared"]);
    const before = fs.readFileSync(path.join(repo, "f.txt"), "utf8");

    const ok = applyPatch(repo, patch);
    assert.equal(ok, false, "conflicting patch must not report success");

    const after = fs.readFileSync(path.join(repo, "f.txt"), "utf8");
    assert.equal(after, before, "shared tree restored to its pre-apply content");
    assert.doesNotMatch(after, /<{7}|>{7}/, "no conflict markers left behind");
    const status = gitIn(repo, ["status", "--porcelain"]);
    assert.doesNotMatch(status, /^(UU|AA) /m, "no unmerged index entries remain");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("applyPatch: on add/add conflict, reverts the shared tree to the shared version", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-apply-addadd-"));
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    gitIn(repo, ["add", "base.txt"]);
    gitIn(repo, ["commit", "-qm", "base"]);
    const base = gitIn(repo, ["rev-parse", "HEAD"]);
    // agent branch adds new.txt = "agent"
    gitIn(repo, ["checkout", "-qb", "agent", base]);
    fs.writeFileSync(path.join(repo, "new.txt"), "agent\n");
    gitIn(repo, ["add", "new.txt"]);
    gitIn(repo, ["commit", "-qm", "agent-add"]);
    const patch = gitIn(repo, ["diff", "--cached", base]);
    // shared branch ALSO adds new.txt = "shared" (add/add conflict)
    gitIn(repo, ["checkout", "-q", "-B", "main", base]);
    fs.writeFileSync(path.join(repo, "new.txt"), "shared\n");
    gitIn(repo, ["add", "new.txt"]);
    gitIn(repo, ["commit", "-qm", "shared-add"]);

    const ok = applyPatch(repo, patch);
    assert.equal(ok, false, "add/add conflict must not report success");
    const after = fs.readFileSync(path.join(repo, "new.txt"), "utf8");
    assert.equal(after, "shared\n", "shared version restored, no markers");
    assert.doesNotMatch(after, /<{7}|>{7}/);
    const status = gitIn(repo, ["status", "--porcelain"]);
    assert.doesNotMatch(status, /^(UU|AA) /m, "no unmerged index entries remain");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("applyPatch: multi-file patch (clean delete + conflicting modify) reverts BOTH", () => {
  // Regression for the deletion-revert hole: git apply --3way is non-atomic and
  // applies the clean deletion before failing on the conflicting modify; the
  // deleted file must be restored too, not just the conflicted one.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-apply-mix-"));
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "keep.txt"), "keep1\nkeep2\n");
    fs.writeFileSync(path.join(repo, "delete-me.txt"), "gone\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    const base = gitIn(repo, ["rev-parse", "HEAD"]);
    // agent branch: modify keep.txt + delete delete-me.txt
    gitIn(repo, ["checkout", "-qb", "agent", base]);
    fs.writeFileSync(path.join(repo, "keep.txt"), "keep1\nagent-edit\n");
    fs.rmSync(path.join(repo, "delete-me.txt"));
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "agent-mix"]);
    const patch = gitIn(repo, ["diff", "--cached", base]);
    // shared branch: conflicting modify to keep.txt (delete-me.txt untouched)
    gitIn(repo, ["checkout", "-q", "-B", "main", base]);
    fs.writeFileSync(path.join(repo, "keep.txt"), "keep1\nshared-edit\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "shared-mix"]);
    const beforeKeep = fs.readFileSync(path.join(repo, "keep.txt"), "utf8");

    const ok = applyPatch(repo, patch);
    assert.equal(ok, false, "conflicting patch must not report success");
    // The conflicting modify is reverted...
    assert.equal(fs.readFileSync(path.join(repo, "keep.txt"), "utf8"), beforeKeep);
    // ...AND the clean deletion is rolled back (file restored, not staged-D).
    assert.ok(fs.existsSync(path.join(repo, "delete-me.txt")), "deleted file was restored");
    assert.equal(fs.readFileSync(path.join(repo, "delete-me.txt"), "utf8"), "gone\n");
    const status = gitIn(repo, ["status", "--porcelain"]);
    assert.doesNotMatch(status, /^(UU|AA|D ) /m, "no unmerged or staged-delete entries remain");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("captureWorktreeDiff: captures binary changes as applicable binary patch data", () => {
  // Regression: `git diff --cached` without --binary emits only "Binary files
  // differ" with no path line / no data, so applyPatch could not apply it and
  // the rescue patch could not reconstruct the binary.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-bin-"));
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    const base = gitIn(repo, ["rev-parse", "HEAD"]);
    // change the binary content + stage
    fs.writeFileSync(path.join(repo, "blob.bin"), Buffer.from([9, 9, 9, 9, 0, 7]));
    gitIn(repo, ["add", "."]);

    const diff = captureWorktreeDiff({ path: repo, agentCwd: repo, branch: "x", baseCommit: base });
    assert.ok(diff.filesChanged >= 1, "binary change is counted");
    assert.match(diff.patch, /diff --git a\/blob\.bin b\/blob\.bin/, "patch carries the blob.bin path");
    assert.match(diff.patch, /GIT binary patch/, "patch carries literal binary patch data");
    assert.doesNotMatch(diff.patch, /Binary files.*differ/, "no textless 'Binary files differ'");
    // The captured binary patch must be re-applicable on a clean tree.
    gitIn(repo, ["reset", "--hard", "-q", base]);
    assert.equal(applyPatch(repo, diff.patch), true, "binary patch applies on the clean base");
    assert.deepEqual(fs.readFileSync(path.join(repo, "blob.bin")), Buffer.from([9, 9, 9, 9, 0, 7]));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("applyPatch: on a binary 3-way conflict, reverts the shared tree to the shared bytes", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-bin-conflict-"));
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    const base = gitIn(repo, ["rev-parse", "HEAD"]);
    // agent branch: change bytes
    gitIn(repo, ["checkout", "-qb", "agent", base]);
    fs.writeFileSync(path.join(repo, "blob.bin"), Buffer.from([9, 9, 9, 9, 0, 7]));
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "agent"]);
    const patch = gitIn(repo, ["-c", "core.quotepath=false", "diff", "--cached", "--binary", base]);
    // shared branch: change to DIFFERENT bytes (conflict)
    gitIn(repo, ["checkout", "-q", "-B", "main", base]);
    fs.writeFileSync(path.join(repo, "blob.bin"), Buffer.from([5, 5, 5, 5, 0, 5]));
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "shared"]);
    const before = Buffer.from([5, 5, 5, 5, 0, 5]);

    const ok = applyPatch(repo, patch);
    assert.equal(ok, false, "binary conflict must not report success");
    assert.deepEqual(fs.readFileSync(path.join(repo, "blob.bin")), before, "shared bytes restored, no corruption");
    const status = gitIn(repo, ["status", "--porcelain"]);
    assert.doesNotMatch(status, /^(UU|AA) /m, "no unmerged index entries remain");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
