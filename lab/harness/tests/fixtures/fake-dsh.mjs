// Stands in for `dsh --profile headless --json -`: reads the task from stdin,
// writes one root and one delegated session log under $DSH_HOME, prints two
// events and creates README.md in the working directory.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const task = readFileSync(0, 'utf8')
const sessions = join(process.env.DSH_HOME, 'sessions', '--workspace--')

function log(id, depth, events) {
  const dir = join(sessions, id)
  mkdirSync(dir, { recursive: true })
  const header = { type: 'session', version: 3, id, delegationDepth: depth }
  writeFileSync(join(dir, 'session.v3.jsonl'), [header, ...events].map(e => JSON.stringify(e)).join('\n') + '\n')
}

const reply = (provider, model, usage) => ({
  type: 'assistant/message',
  data: { message: { role: 'assistant', source: { kind: 'model', provider, model } }, usage },
})

const user = text => ({ type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind: 'user' } } })

log('session-root', 0, [
  user(task),
  { type: 'user/message', data: { source: { kind: 'runtime-context' } } },
  reply('p', 'strong', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000 }),
  { type: 'turn/end', data: {} },
])
log('session-child', 1, [
  user('delegated'),
  reply('p', 'cheap', { inputTokens: 2000, outputTokens: 400 }),
  reply('p', 'cheap', { inputTokens: 1000, outputTokens: 100 }),
  { type: 'turn/end', data: {} },
])

writeFileSync('README.md', `# ${task}\n`)
process.stdout.write(JSON.stringify({ type: 'session', id: 'session-root' }) + '\n')
process.stdout.write(JSON.stringify({ type: 'final', text: 'done' }) + '\n')
process.stderr.write(`args: ${process.argv.slice(2).join(' ')}\n`)
