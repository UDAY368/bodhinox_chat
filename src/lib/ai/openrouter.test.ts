import { describe, expect, it } from 'vitest'
import { freeOpenRouterModels, isOpenRouterBaseUrl } from './openrouter'
describe('OpenRouter preset', () => {
  it('recognizes only the official endpoint', () => {
    expect(isOpenRouterBaseUrl('https://openrouter.ai/api/v1/')).toBe(true)
    expect(isOpenRouterBaseUrl('https://openrouter.ai/api/v1/chat/completions')).toBe(true)
    expect(isOpenRouterBaseUrl('https://OPENROUTER.AI:443/api/v1')).toBe(true)
    expect(isOpenRouterBaseUrl('https://openrouter.ai.evil.test/api/v1')).toBe(false)
    expect(isOpenRouterBaseUrl('https://openrouter.ai/api/v1?redirect=1')).toBe(false)
  })
  it('offers only free text models, with the free router first', () => {
    const model = (id: string, prompt: string, completion: string, output_modalities = ['text']) => ({ id, name: id, pricing: { prompt, completion }, architecture: { input_modalities: ['text'], output_modalities } })
    expect(freeOpenRouterModels({ data: [model('z/test:free', '0', '0'), model('paid/model', '0.01', '0.01'), model('trap:free', '0', '0.01'), model('image:free', '0', '0', ['image']), model('z/test:free', '0', '0')] }).map(m => m.id)).toEqual(['openrouter/free', 'z/test:free'])
  })
  it('keeps the automatic free router available when the catalog is malformed', () => {
    expect(freeOpenRouterModels(null).map(m => m.id)).toEqual(['openrouter/free'])
  })
})
