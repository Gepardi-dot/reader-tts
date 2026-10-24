import { expect, it } from 'vitest'
import { dictionaryWaitMs, payloadFromWiktionary } from '../../../../cloudflare/worker/src/dictionary'
import { authoritativeReading } from './dictionaryGloss'

it('keeps the ordinary Wiktionary sense for courtesan', () => {
  const payload = payloadFromWiktionary({
    en: [{
      partOfSpeech: 'Noun',
      definitions: [
        {
          definition: 'A <a href="/wiki/female" title="female">female</a> <a href="/wiki/prostitute" title="prostitute">prostitute</a>, especially one with high-status or wealthy clients.',
        },
        {
          definition: '<span class="usage-label-sense"></span> A <a href="/wiki/fairy_chess">fairy chess</a> piece.',
        },
      ],
    }],
  }, 'courtesan')
  const reading = authoritativeReading(payload)
  expect(reading?.kind).toBe('sense')
  if (reading?.kind !== 'sense') return
  expect(reading.definition).toBe('A female prostitute, especially one with high-status or wealthy clients.')
  expect(reading.everyday).toBe(true)
})

it('keeps a lemma follow-up and the gap-fill inside the client wait', () => {
  expect(dictionaryWaitMs(0, 9000)).toBe(9000)
  expect(dictionaryWaitMs(9000, 9000)).toBe(9000)
  expect(dictionaryWaitMs(15000, 12000)).toBe(5000)
  expect(dictionaryWaitMs(20000, 12000)).toBe(0)
  const worst = dictionaryWaitMs(0, 9000)
    + dictionaryWaitMs(9000, 9000)
    + dictionaryWaitMs(18000, 12000)
  expect(worst).toBeLessThanOrEqual(20_000)
  expect(worst).toBeLessThan(24_000)
})

it('drops Wiktionary style tags instead of showing the CSS', () => {
  const payload = payloadFromWiktionary({
    en: [{
      partOfSpeech: 'Noun',
      definitions: [{
        definition: 'The <a href="/wiki/mistress">mistress</a> of a castle. <style>.mw-parser-output .defdate{font-size:smaller}</style>',
      }],
    }],
  }, 'chatelaine')
  const definition = payload?.entries?.[0]?.definitions?.[0]?.definition ?? ''
  expect(definition).toBe('The mistress of a castle.')
  expect(definition).not.toMatch(/mw-parser-output|defdate|style/)
})
