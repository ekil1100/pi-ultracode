import assert from "node:assert/strict";
import { runWorkflow } from "../../src/workflow/runtime.ts";
import { WorkflowPolicyError } from "../../src/workflow/admission.ts";

let runnerCalls = 0;
await runWorkflow(
  `export const meta = { name: 'batch_rejection', description: 'Batch rejection regression' }
   const tasks = ${JSON.stringify(Array.from({ length: 512 }, (_, index) => index))}
   return await parallel(tasks.map(index =>
     () => agent('task ' + index, { agentType: '__batch_rejection_unknown_agent_type__' })
   ))`,
  {
    maxAgents: 512,
    runner: {
      run: () => {
        runnerCalls++;
        throw new Error("Unknown agent types must fail before invoking the runner");
      },
    },
  },
).then(
  () => assert.fail("Expected a handled workflow policy error"),
  (error: unknown) => {
    assert.ok(error instanceof WorkflowPolicyError, String(error));
    assert.equal(error.message, "unknown agent type: __batch_rejection_unknown_agent_type__");
    assert.equal(runnerCalls, 0);
    console.log(JSON.stringify({ handled: true, runnerCalls, code: error.code }));
  },
);
