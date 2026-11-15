import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { BenchmarkRef, BenchmarkSource } from './benchmarks.ts'

/**
 * The network of isolated runs. The agent container is attached only to an
 * internal Docker network, so its one way out is a proxy container
 * (mitmproxy, with `lab/isolation/proxy/policy.py`) attached to that network
 * and to the outside. Model APIs pass through the proxy undecrypted. Other
 * HTTPS is decrypted with a lab CA the agent's tools are told to trust, and a
 * request is refused when its URL names an original source of the task: the
 * benchmark repositories, and the upstream project the task was taken from.
 * Everything else stays reachable, so research still works. Every request is
 * logged for auditing what the rules did not catch.
 */

/** mitmproxy 12.1.2, pinned by digest. */
export const PROXY_IMAGE = 'mitmproxy/mitmproxy:12.1.2@sha256:0d7b2a14b4a71a908cd6f31b8f50e29bbc5c8720fe6caa706acf782da558e5c7'
const PROXY_PORT = 8080
/** Hosts tunnelled undecrypted: the model providers' APIs and sign-in. */
export const PASSTHROUGH_HOSTS = ['deepseek.com', 'anthropic.com', 'claude.ai', 'claude.com', 'openai.com', 'chatgpt.com']
/** Where the CA files are mounted in the agent container. */
const AGENT_CA_DIR = '/etc/lab-proxy'
/** Requests listed by URL in run.json; the full log is in network/requests.jsonl. */
const LISTED = 50

export const NetworkRecord = z.object({
  policy: z.literal('block-original-sources'),
  proxyImage: z.string(),
  /** Phrases a URL was refused for naming. */
  blocked: z.array(z.string()),
  passthrough: z.array(z.string()),
  requests: z.number().int().nonnegative(),
  /** How many requests were refused; the first ones are listed in `refused`. */
  refusals: z.number().int().nonnegative(),
  refused: z.array(z.object({ url: z.string(), phrase: z.string() })),
  /** The full request log, relative to the run directory. */
  log: z.string(),
})
export type NetworkRecord = z.output<typeof NetworkRecord>

/**
 * The phrases a run refuses URLs for: each benchmark's name, title and
 * repository, and the task's own original sources.
 * @param sources - every pinned benchmark.
 * @param benchmark - the task's benchmark item, if it is one.
 * @returns the phrases, without duplicates.
 */
export function blockedPhrases(sources: readonly BenchmarkSource[], benchmark: BenchmarkRef | undefined): string[] {
  const phrases: string[] = []
  for (const source of sources) {
    const path = new URL(source.repository).pathname.replace(/^\/|\.git$|\/$/g, '')
    phrases.push(source.name, source.title, path, path.split('/').at(-1) ?? path)
  }
  phrases.push(...(benchmark?.originals ?? []))
  const seen = new Set<string>()
  return phrases.filter(p => {
    const key = p.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (key === '' || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function docker(args: string[]): string {
  const result = spawnSync('docker', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`docker ${args[0]}: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

export interface RunNetwork {
  /** Arguments for the agent's `docker run`. */
  agentArgs: string[]
  /** Stops the proxy, removes the network and returns the run's network record; moves the files into `runDir/network`. */
  close(runDir: string | null): Promise<NetworkRecord | null>
}

/**
 * Starts the proxy and the internal network for one run.
 * @param labDir - the lab directory; the CA lives in `.cache/proxy-ca`.
 * @param agentImage - the agent image, whose CA bundle is extended.
 * @param phrases - URLs naming these are refused.
 * @returns the arguments for the agent container and the teardown.
 */
export async function startNetwork(labDir: string, agentImage: string, phrases: string[]): Promise<RunNetwork> {
  const key = randomUUID().slice(0, 8)
  const name = `collab-lab-proxy-${key}`
  const net = `collab-lab-net-${key}`
  const dir = join(labDir, '.cache/network', key)
  const caDir = join(labDir, '.cache/proxy-ca')
  await mkdir(dir, { recursive: true })
  await mkdir(caDir, { recursive: true })
  await writeFile(join(dir, 'rules.json'), `${JSON.stringify({ blocked: phrases }, null, 2)}\n`)
  await writeFile(join(dir, 'requests.jsonl'), '')

  const passthrough = `^(.+\\.)?(${PASSTHROUGH_HOSTS.map(h => h.replace(/\./g, '\\.')).join('|')}):\\d+$`
  docker(['network', 'create', '--internal', net])
  const teardown = (): void => {
    spawnSync('docker', ['rm', '--force', name], { encoding: 'utf8' })
    spawnSync('docker', ['network', 'rm', net], { encoding: 'utf8' })
  }
  try {
    docker([
      'run', '--detach', '--name', name,
      '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      '--env', 'HOME=/tmp', '--env', 'PYTHONUNBUFFERED=1',
      '--env', 'LAB_PROXY_RULES=/lab-network/rules.json',
      '--env', 'LAB_PROXY_LOG=/lab-network/requests.jsonl',
      '--volume', `${dir}:/lab-network`,
      '--volume', `${caDir}:/lab-ca`,
      '--volume', `${join(labDir, 'isolation/proxy')}:/lab-proxy:ro`,
      // The image's entrypoint script switches users; the proxy runs as the operator instead, to write the mounts.
      '--entrypoint', 'mitmdump',
      PROXY_IMAGE,
      '--listen-port', String(PROXY_PORT), '--set', 'confdir=/lab-ca',
      '--ignore-hosts', passthrough, '--set', 'flow_detail=0',
      '-s', '/lab-proxy/policy.py',
    ])
    docker(['network', 'connect', net, name])
    await waitFor(() => existsSync(join(caDir, 'mitmproxy-ca-cert.pem')) && proxyLogs(name).includes('proxy listening'), `proxy ${name}`)

    // The agent image's own roots plus the lab CA, for tools that read one bundle file.
    const roots = docker(['run', '--rm', '--entrypoint', 'cat', agentImage, '/etc/ssl/certs/ca-certificates.crt'])
    const ca = await readFile(join(caDir, 'mitmproxy-ca-cert.pem'), 'utf8')
    await writeFile(join(dir, 'ca-bundle.pem'), `${roots}\n${ca}`)
    await writeFile(join(dir, 'ca.pem'), ca)
  } catch (error) {
    teardown()
    throw error
  }

  const proxy = `http://${name}:${PROXY_PORT}`
  const bundle = `${AGENT_CA_DIR}/ca-bundle.pem`
  const env: Record<string, string> = {
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy,
    NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1',
    // Node's own fetch and http honour the proxy variables only with this set.
    NODE_USE_ENV_PROXY: '1',
    NODE_EXTRA_CA_CERTS: `${AGENT_CA_DIR}/ca.pem`,
    SSL_CERT_FILE: bundle, REQUESTS_CA_BUNDLE: bundle, CURL_CA_BUNDLE: bundle, PIP_CERT: bundle, GIT_SSL_CAINFO: bundle,
  }
  const agentArgs = [
    '--network', net,
    '--volume', `${join(dir, 'ca.pem')}:${AGENT_CA_DIR}/ca.pem:ro`,
    '--volume', `${join(dir, 'ca-bundle.pem')}:${bundle}:ro`,
    ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
  ]

  return {
    agentArgs,
    async close(runDir) {
      teardown()
      if (runDir === null) return null
      const target = join(runDir, 'network')
      await rename(dir, target)
      const entries = (await readFile(join(target, 'requests.jsonl'), 'utf8')).split('\n').filter(Boolean)
        .map(line => JSON.parse(line) as { kind: string; url?: string; blocked?: string })
      const refused = entries.filter(e => e.blocked !== undefined).map(e => ({ url: e.url ?? '', phrase: e.blocked ?? '' }))
      return NetworkRecord.parse({
        policy: 'block-original-sources',
        proxyImage: PROXY_IMAGE,
        blocked: phrases,
        passthrough: PASSTHROUGH_HOSTS,
        requests: entries.filter(e => e.kind === 'request').length,
        refusals: refused.length,
        refused: refused.slice(0, LISTED),
        log: 'network/requests.jsonl',
      })
    },
  }
}

/** mitmdump logs to stderr. */
function proxyLogs(name: string): string {
  const result = spawnSync('docker', ['logs', name], { encoding: 'utf8' })
  return `${result.stdout}${result.stderr}`
}

async function waitFor(ready: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (ready()) return
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  throw new Error(`${what} did not start within ${timeoutMs / 1000} s`)
}
