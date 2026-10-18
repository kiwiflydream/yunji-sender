import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'

// A separate thread can be terminated even when a synchronous regexp stalls.
test('all Markdown renderers handle adversarial input within a bounded time', async () => {
  const worker = new Worker(`
    import { parentPort, workerData } from 'node:worker_threads'
    const renderers = await import(workerData)
    const inputs = ['x' + '\u0060'.repeat(16000), '['.repeat(16000)]
    const started = performance.now()
    for (const input of inputs) {
      for (const name of ['markdownToHtml', 'markdownToPlain', 'markdownToSlack', 'markdownToTelegramHtml']) {
        const actual = renderers[name](input)
        const expected = name === 'markdownToHtml' ? '<p>' + input + '</p>' : input
        if (actual !== expected) throw new Error(name + ' changed unmatched literal text')
      }
    }
    parentPort.postMessage({ cases: inputs.length * 4, elapsedMs: performance.now() - started })
  `, {
    eval: true,
    execArgv: ['--experimental-strip-types', '--input-type=module'],
    workerData: new URL('../src/lib/markdown.ts', import.meta.url).href,
  })
  let timer
  try {
    const result = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Markdown parsing exceeded 2000 ms')), 2000)
      worker.once('message', resolve)
      worker.once('error', reject)
      worker.once('exit', (code) => { if (code !== 0) reject(new Error(`Worker exited ${code}`)) })
    })
    assert.equal(result.cases, 8)
    console.log(`Adversarial Markdown: ${result.cases} cases in ${result.elapsedMs.toFixed(2)} ms`)
  } finally {
    clearTimeout(timer)
    await worker.terminate()
  }
})
