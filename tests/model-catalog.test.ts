import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchModelNames } from '../src/model-catalog.ts'

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

test('lists OpenAI models for model-name autocomplete', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    assert.equal(url, 'https://api.openai.com/v1/models')
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer openai-key')
    return json({ data: [{ id: 'gpt-image-2.6-flare' }, { id: 'gpt-image-2.6-sunburst' }, { id: 'gpt-image-2.6-flare' }] })
  })
  assert.deepEqual(await fetchModelNames({ compatibility: 'gpt-image', apiKey: 'openai-key' }), [
    'gpt-image-2.6-flare', 'gpt-image-2.6-sunburst',
  ])
  assert.equal(fetch.mock.callCount(), 1)
})

test('lists OpenRouter models using its models endpoint', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/models')
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer router-key')
    return json({ data: [{ id: 'openai/gpt-image-2.6' }] })
  })
  assert.deepEqual(await fetchModelNames({ compatibility: 'openrouter', apiKey: 'router-key' }), ['openai/gpt-image-2.6'])
})

test('lists fal endpoint IDs from the fal model catalog', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    assert.equal(url, 'https://api.fal.ai/v1/models?limit=100&status=active')
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Key fal-key')
    return json({ models: [{ endpoint_id: 'fal-ai/flux/dev' }, { endpoint_id: 'openai/gpt-image-2.6/flare/text-to-image' }] })
  })
  assert.deepEqual(await fetchModelNames({ compatibility: 'fal', apiKey: 'fal-key' }), [
    'fal-ai/flux/dev', 'openai/gpt-image-2.6/flare/text-to-image',
  ])
})
