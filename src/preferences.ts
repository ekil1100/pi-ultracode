/** Global Ultracode preferences, separate from Pi's own settings. */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Effect, Result } from "effect";

import {
  DEFAULT_SELECTOR_BACKEND,
  isSelectorBackend,
  type SelectorBackend,
} from "./selector-backend.ts";

export interface UltracodePreferenceStore {
  getSelectorBackend(): SelectorBackend;
  setSelectorBackend(backend: SelectorBackend): void;
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
    this.write({ ...this.read(), defaultEnabled: enabled });
  }

  getSelectorBackend(): SelectorBackend {
    const backend = this.read().selectorBackend as SelectorBackend | undefined;
    return { ...(backend ?? DEFAULT_SELECTOR_BACKEND) };
  }

  setSelectorBackend(backend: SelectorBackend): void {
    if (!isSelectorBackend(backend)) throw new Error("Invalid Ultracode selector backend.");
    this.write({
      ...this.read(),
      selectorBackend: { type: backend.type, provider: backend.provider, id: backend.id },
    });
  }

  private write(settings: Record<string, unknown>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    Effect.runSync(
      Effect.try({
        try: () => {
          writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
            flag: "wx",
            mode: 0o600,
          });
          renameSync(temporaryPath, this.path);
        },
        catch: (error) => error,
      }).pipe(Effect.ensuring(Effect.sync(() => rmSync(temporaryPath, { force: true })))),
    );
  }

  private read(): Record<string, unknown> {
    const content = Result.try({
      try: () => readFileSync(this.path, "utf8"),
      catch: (error) => error,
    }).pipe(
      Result.getOrElse((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "{}";
        throw error;
      }),
    );
    const value: unknown = JSON.parse(content);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      ("defaultEnabled" in value && typeof value.defaultEnabled !== "boolean")
    ) {
      throw new Error(
        `Invalid Ultracode preferences in ${this.path}: expected an object with a boolean defaultEnabled.`,
      );
    }
    if ("selectorBackend" in value && !isSelectorBackend(value.selectorBackend)) {
      throw new Error(`Invalid Ultracode selector backend in ${this.path}.`);
    }
    return value as Record<string, unknown>;
  }
}
