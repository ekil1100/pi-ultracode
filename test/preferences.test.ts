import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UltracodePreferences } from "../src/preferences.ts";

test("startup preferences default off and persist on/off without changing other fields", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "uc-preferences-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "agent", "ultracode.json");
  const preferences = new UltracodePreferences(file);
  assert.equal(preferences.getDefaultEnabled(), false);
  preferences.setDefaultEnabled(true);
  assert.equal(new UltracodePreferences(file).getDefaultEnabled(), true);
  writeFileSync(file, JSON.stringify({ defaultEnabled: true, other: "preserved" }));
  preferences.setDefaultEnabled(false);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    defaultEnabled: false,
    other: "preserved",
  });
  assert.equal(new UltracodePreferences(file).getDefaultEnabled(), false);
  assert.deepEqual(
    readdirSync(join(dir, "agent")),
    ["ultracode.json"],
    "atomic writes leave no temporary files",
  );
});

test("invalid startup preferences are reported rather than silently overwritten", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "uc-preferences-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
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
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "ultracode.json");
  mkdirSync(file);
  const preferences = new UltracodePreferences(file);
  assert.throws(() => preferences.getDefaultEnabled());
  assert.throws(() => preferences.setDefaultEnabled(true));
});

test("selector defaults and both backend types persist globally while preserving settings", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "uc-selector-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "agent", "ultracode.json");
  const preferences = new UltracodePreferences(file);
  assert.deepEqual(preferences.getSelectorBackend(), {
    type: "classifier",
    provider: "typesafe",
    id: "jev-latest",
  });
  const copy = preferences.getSelectorBackend();
  copy.id = "modified";
  assert.equal(preferences.getSelectorBackend().id, "jev-latest");
  preferences.setDefaultEnabled(true);
  const settings = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...settings, other: { nested: true } }));
  for (const type of ["chat", "classifier"] as const) {
    const backend = { type, provider: "provider", id: "org/model" };
    preferences.setSelectorBackend(backend);
    assert.deepEqual(new UltracodePreferences(file).getSelectorBackend(), backend);
    assert.equal(preferences.getDefaultEnabled(), true);
    preferences.setDefaultEnabled(false);
    assert.deepEqual(preferences.getSelectorBackend(), backend);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).other, { nested: true });
    preferences.setDefaultEnabled(true);
  }
  assert.deepEqual(readdirSync(join(dir, "agent")), ["ultracode.json"]);
});

test("malformed selectors and invalid writes preserve the existing preference file", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "uc-selector-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "ultracode.json");
  const preferences = new UltracodePreferences(file);
  for (const selectorBackend of [
    null,
    [],
    {},
    { type: "image", provider: "p", id: "i" },
    { type: "chat", provider: "", id: "i" },
    { type: "chat", provider: "p", id: "\u001bi" },
  ]) {
    const content = JSON.stringify({ defaultEnabled: true, selectorBackend });
    writeFileSync(file, content);
    assert.throws(() => preferences.getSelectorBackend());
    assert.throws(() => preferences.setDefaultEnabled(false));
    assert.equal(readFileSync(file, "utf8"), content);
  }
  writeFileSync(file, '{"defaultEnabled":true}');
  assert.throws(() => preferences.setSelectorBackend({ type: "chat", provider: "p", id: "" }));
  assert.equal(readFileSync(file, "utf8"), '{"defaultEnabled":true}');
});
