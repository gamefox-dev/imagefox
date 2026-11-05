import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backgroundOptions, falImageSize, formatDuration, geminiImageConfig, imageOutputOptions, openAiSize, openRouterImageConfig } from '../src/image-options.ts'
import type { ImageResolution } from '../src/image-options.ts'

const resolutions: ImageResolution[] = ['0.5K', '1K', '2K', '4K']

test('auto sends literal sizes for OpenAI/fal and omits overrides for Gemini/OpenRouter Images API', () => {
  for (const resolution of resolutions) {
    assert.equal(openAiSize('auto', resolution), 'auto')
    assert.equal(falImageSize('auto', resolution), 'auto')
    assert.deepEqual(openRouterImageConfig('auto', resolution), {})
  }
  assert.deepEqual(geminiImageConfig('auto'), {})
})

test('explicit ratios retain provider sizing options', () => {
  assert.equal(openAiSize('1:1', '1K'), '1024x1024')
  assert.deepEqual(falImageSize('16:9', '2K'), { width: 2048, height: 1152 })
  assert.deepEqual(geminiImageConfig('3:4'), { imageConfig: { aspectRatio: '3:4' } })
  assert.deepEqual(openRouterImageConfig('16:9', '4K'), { aspect_ratio: '16:9', resolution: '4K' })
})

test('explicit GPT Image dimensions stay within supported constraints', () => {
  for (const ratio of ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9']) {
    for (const resolution of resolutions) {
      const [w, h] = openAiSize(ratio, resolution).split('x').map(Number)
      assert.equal(w % 16, 0)
      assert.equal(h % 16, 0)
      assert.ok(w * h >= 655_360 && w * h <= 8_294_400)
      assert.ok(Math.max(w, h) <= 3840)
    }
  }
})

test('passes quality and GIF animation options to image requests', () => {
  assert.deepEqual(imageOutputOptions({ quality: 'xhigh', outputFormat: 'gif', frameCount: 12, frameDurationMs: 353 }), {
    quality: 'xhigh', output_format: 'gif', frame_count: 12, frame_duration_ms: 350,
  })
  assert.deepEqual(openRouterImageConfig('auto', '1K'), {})
  assert.deepEqual(backgroundOptions(true, 'webp'), { background: 'transparent', output_format: 'webp' })
})

test('rejects GIF edits and invalid GIF settings', () => {
  assert.throws(() => imageOutputOptions({ outputFormat: 'gif' }, true), /only supported for text-to-image/)
  assert.throws(() => imageOutputOptions({ outputFormat: 'gif', frameCount: 17 }, false, 16), /between 2 and 16/)
  assert.throws(() => imageOutputOptions({ outputFormat: 'gif', frameDurationMs: 19 }), /between 20 and 2000/)
})

test('formats generation durations including rounding and minute/hour boundaries', () => {
  for (const [ms, expected] of [[0, '0s'], [1234, '1s'], [59_500, '1m 0s'], [94_000, '1m 34s'], [3_661_000, '1h 1m 1s']] as const) {
    assert.equal(formatDuration(ms), expected)
  }
})
