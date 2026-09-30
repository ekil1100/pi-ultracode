import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentSession, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createWorkflowTool } from "../src/workflow/tool.ts";

for (const source of ["registry", "explicit-runtime", "unavailable-explicit-runtime"] as const) {
  test(`Jev tool production initialization uses authoritative ${source} credentials`, { timeout: 10_000 }, async (t) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "uc-jev-credentials-"));
    const previousDir = process.env.PI_CODING_AGENT_DIR;
    const previousKey = process.env.TYPESAFE_API_KEY;
    const agentDir = path.join(cwd, "pi");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.TYPESAFE_API_KEY;
    t.after(() => {
      if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousDir;
      if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previousKey;
      fs.rmSync(cwd, { recursive: true, force: true });
    });
    const requests: any[] = [];
    const fetch = t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
      assert.equal(String(url), "https://api.typesafe.ai/v1/systemone");
      const expectedKey = source === "registry" ? "fake-host-key" : "fake-explicit-key";
      assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${expectedKey}`);
      requests.push(JSON.parse(init.body as string));
      return Response.json({ answers: {
        task_0: { type: "choice", choice: "low", confidence: 1, probabilities: { low: 1 } },
      } });
    });
    const host = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
    });
    await host.setRuntimeApiKey("typesafe", "fake-host-key");
    const registry = new ModelRegistry(host);
    assert.equal(registry.getProviderAuthStatus("typesafe").source, "runtime");
    assert.equal(registry.getAvailable().some((model) => model.provider === "typesafe"), false);
    assert.equal(registry.getRegisteredProviderIds().includes("typesafe"), false);
    const model = host.getModels("anthropic").find((model) => model.reasoning)!;
    assert.ok(model);
    const explicit = source === "registry" ? undefined : await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
    });
    if (source === "explicit-runtime") await explicit!.setRuntimeApiKey("typesafe", "fake-explicit-key");
    const hostClassify = t.mock.method(registry, "classify", registry.classify.bind(registry));
    const explicitClassify = explicit && t.mock.method(explicit, "classify", explicit.classify.bind(explicit));
    const createRuntime = t.mock.method(ModelRuntime, "create", ModelRuntime.create);
    const efforts: string[] = [];
    // Keep the real tool, runner, runtime initialization and session factory.
    // Only replace paid chat execution; native classification uses the fetch mock.
    t.mock.method(AgentSession.prototype, "prompt", async function (this: AgentSession) {
      assert.equal(this.model?.id, model.id);
      assert.ok(this.getAvailableThinkingLevels().length > 1);
      efforts.push(this.thinkingLevel);
    });
    const dispose = t.mock.method(AgentSession.prototype, "dispose", AgentSession.prototype.dispose);
    const tool = createWorkflowTool(explicit ? { modelRuntime: explicit } : {});
    await tool.execute("credentials", {
      script: `export const meta = { name: 'credentials', description: 'Native host credentials' };
        return await agent('Check a local rule', {label: 'check', model: ':high'});`,
    }, t.signal, undefined, {
      cwd, modelRegistry: registry, model,
      isProjectTrusted: () => false,
      sessionManager: { getSessionDir: () => path.join(cwd, "session") },
    } as any);
    const available = source !== "unavailable-explicit-runtime";
    assert.deepEqual(efforts, [available ? "low" : "high"]);
    assert.equal(dispose.mock.callCount(), 1);
    assert.equal(fetch.mock.callCount(), available ? 1 : 0);
    assert.equal(hostClassify.mock.callCount(), source === "registry" ? 1 : 0);
    assert.equal(explicitClassify?.mock.callCount() ?? 0, source === "explicit-runtime" ? 1 : 0);
    assert.equal(createRuntime.mock.callCount(), source === "registry" ? 1 : 0);
    if (source === "registry") {
      assert.deepEqual(createRuntime.mock.calls[0].arguments[0], {
        authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false,
      });
      const childRuntime = await createRuntime.mock.calls[0].result!;
      assert.notEqual(childRuntime, host);
      assert.equal(childRuntime.getProviderAuthStatus("typesafe").configured, false,
        "classification must use host auth, not a copy limited to chat providers");
    }
    if (available) assert.deepEqual(requests[0].state.tasks.task_0.model, { provider: model.provider, id: model.id });
  });
}
