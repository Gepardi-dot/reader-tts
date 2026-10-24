import { expect, it } from 'vitest'
import { payloadFromWiktionary } from '../../../../cloudflare/worker/src/dictionary'
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
