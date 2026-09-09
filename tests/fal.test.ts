import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateFalImage } from '../src/fal.ts'

const options = {
  apiKey: 'test-key',
  modelName: 'openai/gpt-image-2.5/flare/edit',
  prompt: 'Make it blue',
  imageUrls: ['data:image/png;base64,aGVsbG8='],
  imageSize: { width: 1024, height: 1024 },
}
const queue = {
  status: 'IN_QUEUE',
  request_id: 'request-1',
  status_url: 'https://queue.fal.run/openai/gpt-image-2.5/requests/request-1/status',
  response_url: 'https://queue.fal.run/openai/gpt-image-2.5/requests/request-1',
}
const output = { images: [{ url: 'https://fal.media/image.png', content_type: 'image/png' }] }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

test('submits image inputs, polls the returned URLs and downloads without credentials', async t => {
  const originalSetTimeout = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', (fn: () => void, ms: number) => originalSetTimeout(fn, ms === 1000 ? 0 : ms))
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const responses = [json(queue), json({ status: 'IN_PROGRESS' }), json({ status: 'COMPLETED' }), json(output), new Response('image')]
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    assert.ok(responses.length)
    return responses.shift()!
  })
  const blob = await generateFalImage(options)
  assert.equal(blob.type, 'image/png')
  assert.equal(await blob.text(), 'image')
  assert.equal(calls[0].url, 'https://queue.fal.run/openai/gpt-image-2.5/flare/edit')
  assert.deepEqual(calls[0].init?.headers, { Authorization: 'Key test-key', 'Content-Type': 'application/json' })
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), {
    prompt: options.prompt, image_urls: options.imageUrls, image_size: options.imageSize, num_images: 1,
  })
  assert.equal(calls[1].url, queue.status_url)
  assert.equal(calls[2].url, queue.status_url)
  assert.equal(calls[3].url, queue.response_url)
  assert.equal(calls[4].init?.headers, undefined)
})

test('text-only request omits image_urls, preserves endpoint and routes follow-ups through proxy', async t => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const responses = [json({ ...queue, status: 'COMPLETED' }), json(output), new Response('image')]
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return responses.shift()!
  })
  await generateFalImage({ ...options, modelName: '/fal-ai/flux/dev/', baseUrl: 'https://proxy.example/fal///', imageUrls: [] })
  assert.equal(calls[0].url, 'https://proxy.example/fal/fal-ai/flux/dev')
  assert.equal('image_urls' in JSON.parse(calls[0].init?.body as string), false)
  assert.equal(calls[1].url, 'https://proxy.example/fal/openai/gpt-image-2.5/requests/request-1')
})

test('sends auto size unchanged for image editing', async t => {
  let submitted: Record<string, unknown> | undefined
  const responses = [json({ ...queue, status: 'COMPLETED' }), json(output), new Response('image')]
  t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
    if (init?.body) submitted = JSON.parse(init.body as string)
    return responses.shift()!
  })
  await generateFalImage({ ...options, imageSize: 'auto' })
  assert.equal(submitted?.image_size, 'auto')
  assert.deepEqual(submitted?.image_urls, options.imageUrls)
})

test('downloads data URI output', async t => {
  const nativeFetch = globalThis.fetch
  const responses = [json({ ...queue, status: 'COMPLETED' }), json({ images: [{ url: 'data:image/png;base64,aGVsbG8=' }] })]
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    return url.startsWith('data:') ? nativeFetch(url, init) : responses.shift()!
  })
  const blob = await generateFalImage(options)
  assert.equal(await blob.text(), 'hello')
  assert.equal(blob.type, 'image/png')
})

for (const [name, response, message] of [
  ['API validation errors', json({ detail: 'image_urls is required' }, 422), /fal.ai \(422\).*image_urls is required/],
  ['queue failures', json({ ...queue, status: 'COMPLETED', error: 'Generation failed' }), /Generation failed/],
  ['unknown queue status', json({ ...queue, status: 'UNKNOWN' }), /unexpected queue status/],
  ['missing queue URLs', json({ status: 'IN_QUEUE' }), /missing a status_url or response_url/],
  ['untrusted queue URLs', json({ ...queue, status_url: 'https://evil.example/status' }), /outside the configured API origin/],
  ['invalid JSON', new Response('not json'), /invalid JSON/],
] as const) {
  test(`reports ${name}`, async t => {
    t.mock.method(globalThis, 'fetch', async () => response)
    await assert.rejects(generateFalImage(options), message)
  })
}

test('reports empty image output', async t => {
  const responses = [json({ ...queue, status: 'COMPLETED' }), json({ images: [] })]
  t.mock.method(globalThis, 'fetch', async () => responses.shift()!)
  await assert.rejects(generateFalImage(options), /contained no image/)
})

test('rejects URLs and path traversal instead of accepting them as endpoint IDs', async () => {
  for (const modelName of ['https://fal.ai/models/fal-ai/flux/dev', 'fal-ai/../dev', '']) {
    await assert.rejects(generateFalImage({ ...options, modelName }), /must be an endpoint ID/)
  }
})

test('reports media download errors', async t => {
  const responses = [json({ ...queue, status: 'COMPLETED' }), json(output), new Response('gone', { status: 404 })]
  t.mock.method(globalThis, 'fetch', async () => responses.shift()!)
  await assert.rejects(generateFalImage(options), /download fal.ai image \(404\)/)
})

test('aborts a stalled request at the deadline and clears the timer', async t => {
  const originalSetTimeout = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', (fn: () => void) => originalSetTimeout(fn, 0))
  const clear = t.mock.method(globalThis, 'clearTimeout')
  t.mock.method(globalThis, 'fetch', (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
  }))
  await assert.rejects(generateFalImage(options), /timed out after 10 minutes.*may still be running/)
  assert.equal(clear.mock.callCount(), 1)
})
