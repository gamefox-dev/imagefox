import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateOpenAiImage, generateOpenRouterImage } from '../src/image-api.ts'
import { backgroundOptions } from '../src/image-options.ts'

const options = {
  apiKey: 'test-key', modelName: 'openai/gpt-image-2.5-flare', prompt: 'A fox',
  aspectRatio: 'auto', resolution: '1K' as const, imageUrls: [],
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const output = { data: [{ b64_json: 'aGVsbG8=', media_type: 'image/webp' }] }

test('transparency has three distinct states; unspecified omits all overrides', () => {
  assert.deepEqual(backgroundOptions(), {})
  assert.deepEqual(backgroundOptions(false), { background: 'opaque' })
  assert.deepEqual(backgroundOptions(true), { background: 'transparent', output_format: 'png' })
})

for (const modelName of ['openai/gpt-image-2.5-flare', 'openai/gpt-image-2.5-sunburst', 'google/gemini-3.1-flash-image-preview']) {
  test(`OpenRouter ${modelName} uses the Images endpoint and native response MIME`, async t => {
    const fetch = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      assert.equal(url, 'https://openrouter.ai/api/v1/images')
      assert.deepEqual(JSON.parse(init.body as string), { model: modelName, prompt: 'A fox', n: 1 })
      return json(output)
    })
    const blob = await generateOpenRouterImage({ ...options, modelName })
    assert.equal(await blob.text(), 'hello')
    assert.equal(blob.type, 'image/webp')
    assert.equal(fetch.mock.callCount(), 1)
  })
}

test('OpenRouter sends reference images, normalized 512 tier, transparency and proxy URL', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://proxy.example/router/api/v1/images')
    assert.deepEqual(JSON.parse(init.body as string), {
      model: options.modelName, prompt: options.prompt, n: 1,
      aspect_ratio: '16:9', resolution: '512', background: 'transparent', output_format: 'png',
      input_references: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }],
    })
    return json(output)
  })
  await generateOpenRouterImage({ ...options, baseUrl: 'https://proxy.example/router///',
    aspectRatio: '16:9', resolution: '0.5K', transparency: true, imageUrls: ['data:image/png;base64,aGVsbG8='] })
})

test('OpenRouter discovers allowed safety passthrough and restricts eligible providers', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (!init.body) {
      assert.equal(url, 'https://openrouter.ai/api/v1/images/models/openai/gpt-image-2.5-flare/endpoints')
      return json({ endpoints: [
        { provider_slug: 'openai', provider_tag: 'openai', allowed_passthrough_parameters: ['moderation'] },
        { provider_slug: 'fal', provider_tag: 'fal', allowed_passthrough_parameters: ['enable_safety_checker'] },
        { provider_slug: 'other', provider_tag: 'other', allowed_passthrough_parameters: [] },
        { provider_slug: 'unroutable', provider_tag: null, allowed_passthrough_parameters: ['moderation'] },
      ] })
    }
    assert.deepEqual(JSON.parse(init.body as string).provider, {
      only: ['openai', 'fal'], options: { openai: { moderation: 'low' }, fal: { enable_safety_checker: false } },
    })
    return json(output)
  })
  await generateOpenRouterImage({ ...options, disableSafety: true })
  assert.equal(fetch.mock.callCount(), 2)
})

test('unsupported OpenRouter safety override fails before a billable generation', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => json({ endpoints: [{ provider_slug: 'google-ai-studio', allowed_passthrough_parameters: ['cachedContent'] }] }))
  await assert.rejects(generateOpenRouterImage({ ...options, disableSafety: true }), /no routable endpoint/)
  assert.equal(fetch.mock.callCount(), 1)
})

test('capability lookup failure is surfaced without generating', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => json({ error: 'unauthorized' }, 401))
  await assert.rejects(generateOpenRouterImage({ ...options, disableSafety: true }), /check OpenRouter safety options \(401\)/)
  assert.equal(fetch.mock.callCount(), 1)
})

for (const transparency of [undefined, false, true]) {
  for (const edit of [false, true]) {
    test(`OpenAI ${edit ? 'edits' : 'generation'} handles transparency=${transparency} and low moderation`, async t => {
      t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
        assert.equal(url, `https://api.openai.com/v1/images/${edit ? 'edits' : 'generations'}`)
        const body = edit ? Object.fromEntries((init.body as FormData).entries()) : JSON.parse(init.body as string)
        assert.equal(body.background, transparency === undefined ? undefined : transparency ? 'transparent' : 'opaque')
        assert.equal(body.output_format, transparency ? 'png' : undefined)
        assert.equal(body.moderation, 'low')
        assert.equal(body.size, 'auto')
        if (edit) {
          assert.ok(body['image[]'] instanceof File)
          assert.equal((init.headers as Record<string, string>)['Content-Type'], undefined)
        }
        return json({ data: [{ b64_json: 'aGVsbG8=' }] })
      })
      const blob = await generateOpenAiImage({ ...options, modelName: 'gpt-image-2.5-flare', transparency,
        disableSafety: true, inputs: edit ? [{ blob: new Blob(['input']), name: 'input.png', type: 'image/png' }] : [] })
      assert.equal(blob.type, 'image/png')
    })
  }
}

test('OpenAI default safety is omitted and remote image download has no credentials', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (url === 'https://media.example/image.png') {
      assert.equal(init, undefined)
      return new Response('image', { headers: { 'Content-Type': 'image/png' } })
    }
    const body = JSON.parse(init!.body as string)
    assert.equal('moderation' in body, false)
    assert.equal('background' in body, false)
    return json({ data: [{ url: 'https://media.example/image.png' }] })
  })
  assert.equal(await (await generateOpenAiImage({ ...options, inputs: [] })).text(), 'image')
})

for (const [name, response, error] of [
  ['HTTP failure', () => json({ error: 'blocked' }, 400), /OpenRouter \(400\).*blocked/],
  ['empty output', () => json({ data: [] }), /contained no image/],
  ['provider error', () => json({ error: { message: 'Provider failed' } }), /Provider failed/],
] as const) {
  test(`OpenRouter reports ${name} without retrying`, async t => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => response())
    await assert.rejects(generateOpenRouterImage(options), error)
    assert.equal(fetch.mock.callCount(), 1)
  })
}
