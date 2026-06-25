/// <reference types="pi-ultracode/workflow" />
//
// Example saved workflow. Copy to `.pi/ultracode/workflows/` and run it with
// the `workflow` tool's `name` parameter, or call `workflow('loop-until-dry-bugs')`
// from another workflow.
//
// Pattern: loop-until-dry discovery + perspective-diverse adversarial verify.
// Keeps spawning finders until two consecutive rounds surface nothing new, then
// confirms each fresh bug with three distinct lenses.

export const meta = {
  name: 'loop-until-dry-bugs',
  description: 'Find bugs until the well runs dry, verifying each with three lenses',
  phases: [{ title: 'Find' }, { title: 'Verify' }],
}

const FINDERS = [
  'Find correctness bugs by reading the changed files closely.',
  'Find bugs by tracing data flow across module boundaries.',
  'Find bugs by hunting error-handling and edge-case gaps.',
]

const BUGS = {
  type: 'object',
  properties: {
    bugs: {
      type: 'array',
      items: {
        type: 'object',
        properties: { file: { type: 'string' }, line: { type: 'number' }, desc: { type: 'string' } },
        required: ['file', 'desc'],
      },
    },
  },
  required: ['bugs'],
}

const VERDICT = {
  type: 'object',
  properties: { real: { type: 'boolean' }, why: { type: 'string' } },
  required: ['real'],
}

const seen = new Set()
const confirmed = []
let dry = 0

while (dry < 2) {
  const rounds = await parallel(
    FINDERS.map((prompt, i) => () => agent(prompt, { label: 'find ' + i, phase: 'Find', schema: BUGS })),
  )
  const found = rounds.filter(Boolean).flatMap((r) => r.bugs ?? [])
  const fresh = found.filter((b) => !seen.has(b.file + ':' + b.desc))
  if (fresh.length === 0) {
    dry++
    continue
  }
  dry = 0
  for (const b of fresh) seen.add(b.file + ':' + b.desc)

  const judged = await parallel(
    fresh.map((b) => () =>
      parallel(
        ['correctness', 'security', 'does-it-reproduce'].map((lens) => () =>
          agent('Judge via the ' + lens + ' lens — is this real? "' + b.desc + '" (' + b.file + '). Default to real:false if unsure.',
            { label: 'verify ' + lens, phase: 'Verify', agentType: 'code-reviewer', schema: VERDICT }),
        ),
      ).then((votes) => ({ bug: b, real: votes.filter(Boolean).filter((v) => v.real).length >= 2 })),
    ),
  )
  confirmed.push(...judged.filter((j) => j.real).map((j) => j.bug))
}

return { confirmed, totalSeen: seen.size }
