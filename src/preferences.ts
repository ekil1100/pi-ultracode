/** Global Ultracode startup preferences, separate from Pi's own settings. */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface UltracodePreferenceStore {
  getDefaultEnabled(): boolean;
  setDefaultEnabled(enabled: boolean): void;
}

export class UltracodePreferences implements UltracodePreferenceStore {
  private readonly path: string;

  constructor(path = join(getAgentDir(), "ultracode.json")) {
    this.path = path;
  }

  getDefaultEnabled(): boolean {
    return this.read().defaultEnabled === true;
  }

  setDefaultEnabled(enabled: boolean): void {
    const settings = { ...this.read(), defaultEnabled: enabled };
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      renameSync(temporaryPath, this.path);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }

  private read(): Record<string, unknown> {
    let content: string;
    try {
      content = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    const value: unknown = JSON.parse(content);
    if (!value || typeof value !== "object" || Array.isArray(value)
      || ("defaultEnabled" in value && typeof value.defaultEnabled !== "boolean")) {
      throw new Error(`Invalid Ultracode preferences in ${this.path}: expected an object with a boolean defaultEnabled.`);
    }
    return value as Record<string, unknown>;
  }
}
