import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const isolated = await mkdtemp(join(tmpdir(), 'yunji-e2e-'))
const children = new Set()
const password = randomBytes(24).toString('hex')
const encryptionKey = randomBytes(32).toString('base64')
const env = {
  ...process.env,
  ADMIN_PASSWORD: password,
  ENCRYPTION_KEY: encryptionKey,
  CLOUDFLARE_API_TOKEN: '',
  CLOUDFLARE_API_KEY: '',
  CLOUDFLARE_EMAIL: '',
  WRANGLER_SEND_METRICS: 'false',
  E2E_ADMIN_PASSWORD: password,
}
const records = []
const provider = createServer(async (req, res) => {
  if (req.url === '/records') {
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify(records))
  }
  try {
    let body = ''
    for await (const chunk of req) body += chunk
    const data = JSON.parse(body)
    records.push({ path: req.url, data })
    const attempts = records.filter((r) => r.path === req.url && r.data.id === data.id).length
    const status = req.url === '/reject' ? 400 : req.url === '/fail-once' && attempts === 1 ? 503 : 200
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 200, ok: true }))
  } catch {
    res.writeHead(400).end()
  }
})

function start(args, cwd, capture = false) {
  const child = spawn('pnpm', args, {
    cwd, env, detached: process.platform !== 'win32',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  children.add(child)
  child.once('exit', () => children.delete(child))
  return child
}

function run(args, cwd = isolated) {
  return new Promise((resolve, reject) => {
    const child = start(args, cwd)
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`pnpm ${args.join(' ')} exited ${code}`)))
  })
}

let cleanupTask
function cleanup() {
  return cleanupTask ??= (async () => {
    await Promise.all([...children].map((child) => new Promise((resolve) => {
      const stop = (signal) => {
        try {
          if (process.platform === 'win32') child.kill(signal)
          else process.kill(-child.pid, signal)
        } catch {}
      }
      const timeout = setTimeout(() => { stop('SIGKILL'); resolve() }, 2000)
      child.once('exit', () => { clearTimeout(timeout); resolve() })
      stop('SIGTERM')
    })))
    provider.closeAllConnections()
    await new Promise((resolve) => provider.close(resolve))
    await rm(isolated, { recursive: true, force: true })
  })()
}

process.once('SIGINT', () => { void cleanup().finally(() => process.exit(130)) })
process.once('SIGTERM', () => { void cleanup().finally(() => process.exit(143)) })

try {
  // Allowlist source only: never copy the developer's DB, secrets or build output.
  for (const name of ['src', 'web', 'public', 'index.html', 'migrations', 'worker-configuration.d.ts', 'vite.config.ts', 'wrangler.jsonc', 'package.json']) {
    await cp(join(root, name), join(isolated, name), {
      recursive: true,
      filter: (path) => !basename(path).startsWith('.env') && !basename(path).startsWith('.dev.vars'),
    })
  }
  await symlink(join(root, 'node_modules'), join(isolated, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(isolated, '.dev.vars'), `ADMIN_PASSWORD=${password}\nENCRYPTION_KEY=${encryptionKey}\n`, { mode: 0o600 })
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve))
  env.E2E_PROVIDER_URL = `http://127.0.0.1:${provider.address().port}`
  const probe = createTcpServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  env.E2E_BASE_URL = `http://127.0.0.1:${port}`
  console.log(`E2E uses an isolated database and dummy provider: ${env.E2E_BASE_URL}`)
  await run(['build'])
  await run(['db:migrate:local'])
  const preview = start(['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], isolated, true)
  let logs = ''
  const capture = (data) => { logs = (logs + data).slice(-16_384) }
  preview.stdout.on('data', capture)
  preview.stderr.on('data', capture)
  let ready = false
  for (let i = 0; i < 150 && preview.exitCode === null; i++) {
    try {
      const res = await fetch(`${env.E2E_BASE_URL}/health`, { signal: AbortSignal.timeout(1000), redirect: 'error' })
      if (res.ok && (await res.json()).ok === true) { ready = true; break }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  if (!ready) throw new Error(`Isolated preview did not start:\n${logs}`)
  try {
    await run(['exec', 'playwright', 'test', ...process.argv.slice(2)], root)
  } catch (err) {
    console.error(logs)
    throw err
  }
} catch (err) {
  console.error(err)
  process.exitCode = 1
} finally {
  await cleanup()
}
