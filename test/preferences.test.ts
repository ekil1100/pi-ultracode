import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UltracodePreferences } from "../src/preferences.ts";

test("startup preferences default off and persist on/off without changing other fields", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "uc-preferences-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "agent", "ultracode.json");
  const preferences = new UltracodePreferences(file);
  assert.equal(preferences.getDefaultEnabled(), false);
  preferences.setDefaultEnabled(true);
  assert.equal(new UltracodePreferences(file).getDefaultEnabled(), true);
  writeFileSync(file, JSON.stringify({ defaultEnabled: true, other: "preserved" }));
  preferences.setDefaultEnabled(false);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { defaultEnabled: false, other: "preserved" });
  assert.equal(new UltracodePreferences(file).getDefaultEnabled(), false);
  assert.deepEqual(readdirSync(join(dir, "agent")), ["ultracode.json"], "atomic writes leave no temporary files");
});

test("invalid startup preferences are reported rather than silently overwritten", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "uc-preferences-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "ultracode.json");
  const preferences = new UltracodePreferences(file);
  for (const content of ["{", "null", "[]", "true", '{"defaultEnabled":"on"}']) {
    writeFileSync(file, content);
    assert.throws(() => preferences.getDefaultEnabled());
    assert.throws(() => preferences.setDefaultEnabled(true));
    assert.equal(readFileSync(file, "utf8"), content);
  }
});

test("startup preference filesystem errors propagate", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "uc-preferences-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "ultracode.json");
  mkdirSync(file);
  const preferences = new UltracodePreferences(file);
  assert.throws(() => preferences.getDefaultEnabled());
  assert.throws(() => preferences.setDefaultEnabled(true));
});
