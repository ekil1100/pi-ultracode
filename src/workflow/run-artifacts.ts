import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

export function standaloneWorkflowRunsDir(cwd: string): string {
  const cwdKey = crypto.createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 24);
  return path.join(os.homedir(), ".pi", "ultracode-runs", cwdKey);
}

/** Ensure an artifact directory is real; with a root, reject every symlink below that root. */
export function ensurePrivateArtifactDirectory(dir: string, trustedRoot?: string): void {
  if (trustedRoot !== undefined) {
    ensureContainedDirectory(trustedRoot, dir);
    return;
  }
  let created = false;
  try {
    fs.lstatSync(dir);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    created = true;
  }
  assertRealDirectory(dir);
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
  if (created) {
    fsyncArtifactDirectory(dir);
    const parent = path.dirname(dir);
    if (parent !== dir) fsyncArtifactDirectory(parent);
  }
}

function ensureContainedDirectory(trustedRoot: string, dir: string): void {
  const root = path.resolve(trustedRoot);
  const target = path.resolve(dir);
  assertRealDirectory(root);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`workflow artifact directory must stay inside ${root}`);
  }
  let current = root;
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part);
    let created = false;
    try {
      assertRealDirectory(current);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      fs.mkdirSync(current, { mode: 0o700 });
      created = true;
      assertRealDirectory(current);
    }
    if (process.platform !== "win32") fs.chmodSync(current, 0o700);
    if (created) {
      fsyncArtifactDirectory(current);
      fsyncArtifactDirectory(path.dirname(current));
    }
  }
}

function assertRealDirectory(dir: string): void {
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`workflow artifact directory must be a real directory: ${dir}`);
  }
}

/** Persist directory-entry changes on platforms that support directory fsync. */
export function fsyncArtifactDirectory(dir: string): void {
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isDirectory()) throw new Error(`workflow artifact parent must be a directory: ${dir}`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function artifactPathExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/** Reject symlinks and non-regular artifact files before reading or resuming them. */
export function assertRegularArtifactFile(filePath: string, label: string): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw new Error(`${label} was not found: ${filePath}`, { cause: error });
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file and may not be a symlink: ${filePath}`);
  }
  return stat;
}

export function readContainedArtifactFile(
  trustedRoot: string,
  filePath: string,
  label: string,
  maxBytes = 16 * 1024 * 1024,
): string {
  const root = path.resolve(trustedRoot);
  const target = path.resolve(filePath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside ${root}`);
  }
  let current = root;
  const parts = relative.split(path.sep);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} path may not contain symlinks: ${current}`);
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new Error(`${label} parent must be a directory: ${current}`);
    }
  }
  return readArtifactFile(target, label, maxBytes);
}

export function readArtifactFile(filePath: string, label: string, maxBytes = 16 * 1024 * 1024): string {
  assertRegularArtifactFile(filePath, label);
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | NO_FOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${label} must be a regular file: ${filePath}`);
    if (stat.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes: ${filePath}`);
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes: ${filePath}`);
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export function appendArtifactFile(
  filePath: string,
  data: string | Uint8Array,
  options: { trustedRoot: string },
): void {
  ensurePrivateArtifactDirectory(path.dirname(filePath), options.trustedRoot);
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      filePath,
      fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_APPEND | NO_FOLLOW,
      0o600,
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`workflow artifact must be a regular file: ${filePath}`);
    fs.writeFileSync(fd, data);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Write an artifact through an exclusive random temporary file and atomic rename.
 * Existing symlinks are rejected rather than followed.
 */
export function writeArtifactFile(
  filePath: string,
  data: string | Uint8Array,
  options: { trustedRoot: string; overwrite?: boolean },
): void {
  ensurePrivateArtifactDirectory(path.dirname(filePath), options.trustedRoot);
  let existing: fs.Stats | undefined;
  try {
    existing = fs.lstatSync(filePath);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error(`workflow artifact must be a regular file and may not be a symlink: ${filePath}`);
  }
  if (existing && !options.overwrite) {
    throw new Error(`workflow artifact already exists: ${filePath}`);
  }

  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      tempPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NO_FOLLOW,
      0o600,
    );
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, filePath);
    fsyncArtifactDirectory(path.dirname(filePath));
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort descriptor cleanup
      }
    }
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // best-effort temporary-file cleanup
    }
  }
}
