// Stands in for `dsh` running the dsh-superagent profile: the profile
// commands, and a server with the parts of the management API the harness
// uses. Saving the lab-task Source makes one Ticket from the inbox, runs the
// prepare command, writes README.md in the Ticket directory, replies in the
// outbox, writes a session log and ends the Ticket.
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const args = process.argv.slice(2)
const home = process.env.DSH_HOME
const record = entry => appendFileSync(join(home, 'fake-requests.jsonl'), `${JSON.stringify(entry)}\n`)
record({ args })

if (args.includes('--dump-config')) {
  mkdirSync(join(home, 'profiles', args[0]), { recursive: true })
  process.exit(0)
}
if (args[0] === 'plugin') process.exit(0)

const port = Number(args[args.indexOf('--port') + 1])
let configured = false
const blocks = {
  policy: { value: { rules: [], sources: {} }, revision: 0 },
  executor: { value: { model: null, maxWorkers: 3, directory: '', prepare: '', blockedCommands: [] }, revision: 0 },
}
const ended = []

function work(config) {
  const message = JSON.parse(readFileSync(config.inbox, 'utf8').trim().split('\n')[0])
  const dir = join(blocks.executor.value.directory, 'make-it-t1')
  execFileSync('sh', ['-c', blocks.executor.value.prepare], { cwd: blocks.executor.value.directory, env: { ...process.env, DSH_SUPERAGENT_DIR: dir } })
  writeFileSync(join(dir, 'README.md'), `# ${message.text}\n`)
  appendFileSync(config.outbox, `${JSON.stringify({ id: 'r1', kind: 'reply', text: 'Done.', at: new Date().toISOString() })}\n`)
  const log = join(home, 'sessions', '--state--', 'worker-t1')
  mkdirSync(log, { recursive: true })
  const events = [
    { type: 'session', version: 4, id: 'worker-t1', delegationDepth: 0 },
    { type: 'user/message', data: { source: { kind: 'dsh-superagent' } } },
    { type: 'assistant/message', time: Date.parse('2026-11-10T12:00:00Z'), data: { message: { source: { kind: 'model', provider: 'p', model: 'cheap' } }, usage: { inputTokens: 1000, outputTokens: 100 } } },
  ]
  writeFileSync(join(log, 'session.v4.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n')
  ended.push({ id: 't1', title: 'Make it', state: 'ended', stage: 'ended', ended: { outcome: 'completed' }, summary: 'Wrote README.md.' })
}

const server = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    const path = req.url.replace('/orchestrator/api/', '')
    const value = body === '' ? undefined : JSON.parse(body)
    record({ method: req.method, path, body: value, header: req.headers['x-orchestrator-request'] })
    const send = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }
    if (req.method === 'GET' && path === 'state') {
      return send({ setup: { problem: configured ? null : { code: 'repositoryUnset' }, accounts: configured ? { agent: 'lab-agent' } : null }, health: { runtime: { state: configured ? 'ready' : 'paused' } } })
    }
    if (req.method === 'GET' && path === 'settings') {
      return send({ blocks, sources: [{ id: 'github', revision: configured ? 1 : 0 }, { id: 'lab-task', revision: 0 }] })
    }
    if (req.method === 'GET' && path === 'prompts') return send({ current: { revision: 0, config: { communication: 'c', scope: 's', delivery: 'pr', skills: {} } } })
    if (req.method === 'PUT' && path === 'prompts') return send({ revision: 1 })
    if (req.method === 'PUT' && path === 'settings/source:github') { configured = true; return send({ saved: true, restarting: true }) }
    if (req.method === 'PUT' && path === 'settings/source:lab-task') { work(value.value.config); return send({ saved: true }) }
    if (req.method === 'PUT' && path.startsWith('settings/')) {
      const block = blocks[path.slice('settings/'.length)]
      block.value = value.value
      block.revision++
      return send({ saved: true })
    }
    if (req.method === 'GET' && path.startsWith('tickets')) return send({ items: path.includes('state=ended') ? ended : [] })
    send({ error: 'not found' }, 404)
  })
})
server.listen(port, '127.0.0.1')
process.on('SIGTERM', () => server.close(() => process.exit(0)))
