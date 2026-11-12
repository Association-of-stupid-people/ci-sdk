// Static checks of the reusable workflows in workflows/ (published to the runner branch by publish.yml): what
// GitHub only reports when a game runs them.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dir = path.join(root, 'workflows')
const files = readdirSync(dir).filter(f => f.endsWith('.yml'))

interface Step {
  id?: string
  uses?: string
}
interface Job {
  needs?: string | string[]
  outputs?: Record<string, string>
  steps?: Step[]
}
interface Workflow {
  on: { workflow_call: { inputs?: Record<string, unknown>; secrets?: Record<string, unknown> } }
  jobs: Record<string, Job>
}

const load = (file: string): { text: string; wf: Workflow } => {
  const text = readFileSync(path.join(dir, file), 'utf8')
  return { text, wf: parse(text) as Workflow }
}
const matches = (text: string, re: RegExp): string[] => [...text.matchAll(re)].map(m => m[1] ?? '')
// Expressions only: comments may name contexts in prose.
const expressions = (text: string): string => matches(text, /\$\{\{([\s\S]*?)\}\}/g).join('\n')
const asList = (needs: Job['needs']): string[] =>
  needs === undefined ? [] : Array.isArray(needs) ? needs : [needs]

describe.each(files)('%s', file => {
  const { text, wf } = load(file)

  it('is a reusable workflow', () => {
    expect(wf.on.workflow_call).toBeDefined()
  })

  it('uses ci-sdk actions at @runner (pinned by publish.yml) and other actions by full commit sha', () => {
    const uses = Object.values(wf.jobs).flatMap(j =>
      (j.steps ?? []).map(s => s.uses).filter(Boolean)
    ) as string[]
    expect(uses.length).toBeGreaterThan(0)
    for (const u of uses) {
      const own =
        /^Association-of-stupid-people\/ci-sdk\/\.github\/actions\/([a-z0-9-]+)@(.+)$/.exec(u)
      if (own) {
        expect(own[2], u).toBe('runner')
        expect(existsSync(path.join(root, 'packages', own[1] ?? '', 'action.yml')), u).toBe(true)
      } else {
        expect(u, u).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/)
      }
    }
  })

  it('declares every input and secret it reads', () => {
    const inputs = Object.keys(wf.on.workflow_call.inputs ?? {})
    const secrets = Object.keys(wf.on.workflow_call.secrets ?? {})
    for (const name of matches(expressions(text), /\binputs\.([\w-]+)/g))
      expect(inputs, `inputs.${name}`).toContain(name)
    for (const name of matches(expressions(text), /\bsecrets\.([\w-]+)/g))
      expect(secrets, `secrets.${name}`).toContain(name)
    // Every declared one is used.
    for (const name of inputs) expect(text, `input ${name}`).toContain(`inputs.${name}`)
    for (const name of secrets) expect(text, `secret ${name}`).toContain(`secrets.${name}`)
  })

  it.each(Object.keys(wf.jobs))(
    'job %s reads only its own steps and the outputs of jobs it needs',
    name => {
      const job = wf.jobs[name] as Job
      const jobText = expressions(JSON.stringify(job))
      const ids = new Set((job.steps ?? []).map(s => s.id).filter(Boolean))
      for (const id of matches(jobText, /\bsteps\.([\w-]+)\./g))
        expect(ids.has(id), `steps.${id}`).toBe(true)
      const needs = asList(job.needs)
      for (const m of jobText.matchAll(/\bneeds\.([\w-]+)\.(result|outputs\.([\w-]+))/g)) {
        const [ref, need, , output] = m
        expect(needs, ref).toContain(need)
        if (output) expect(Object.keys(wf.jobs[need ?? '']?.outputs ?? {}), ref).toContain(output)
      }
    }
  )
})
