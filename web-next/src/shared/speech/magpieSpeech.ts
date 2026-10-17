/**
 * Shape book text for Magpie the way current Gemini and ElevenLabs
 * audiobook guides shape a transcript: the punctuation is the pause.
 *
 * Measured on Magpie Aria: a comma adds a breath, a period is a full stop,
 * and an em dash does not. Gemini and Eleven v3/v4 use that dash as a beat,
 * so it is written as a comma here. Commas that are already in the book stay
 * commas. Kokoro cannot do that, and its em-dash rewrite is not used.
 *
 * A blank line with no sentence ending gets a period, because a bare line
 * break is the same length as no break. An ellipsis stays one weighted pause.
 * Titles such as Dr. and Mr. are spoken in full so the period is not a stop.
 * Angle-bracket and square-bracket pause tags are not inserted. Magpie would
 * read them aloud.
 *
 * Plain sentences come back unchanged, so a clip with nothing to fix keeps
 * its cache hit. The function is safe to run twice.
 */

function expandTitles(text: string): string {
  return text
    .replace(/\bMr\./g, 'Mister')
    .replace(/\bMrs\./g, 'Missus')
    .replace(/\bMs\./g, 'Miz')
    .replace(/\bDr\./g, 'Doctor')
    .replace(/\bProf\./g, 'Professor')
    .replace(/\bJr\./g, 'Junior')
    .replace(/\bSr\./g, 'Senior')
    .replace(/\bvs\./gi, 'versus')
    .replace(/\betc\./gi, 'et cetera')
    .replace(/\be\.g\./gi, 'for example')
    .replace(/\bi\.e\./gi, 'that is')
}

export function prepareMagpieSpeech(text: string): string {
  if (!text) return text
  let next = text.replace(/\r\n/g, '\n')
  next = next.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
  next = next.replace(/[·•]/g, '. ')
  next = expandTitles(next)
  next = next.replace(/\.{3,}|…+/g, ' … ')
  // A dash between words is a beat. A dash between numbers is a range.
  next = next.replace(/(?<!\d)\s*(?:--|[–—])\s*(?!\d)/g, ', ')
  next = next.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n')
  next = next.replace(/\n{3,}/g, '\n\n')
  next = next.replace(/([^.!?"'…,:;])\s*\n\n/g, '$1.\n\n')
  next = next.replace(/\n+/g, ' ')
  next = next.replace(/([.!?])([A-Za-z"'(])/g, '$1 $2')
  next = next.replace(/[ \t]{2,}/g, ' ')
  next = next.replace(/\s+([,.;:!?])/g, '$1')
  next = next.replace(/,(?:\s*,)+/g, ',')
  return next.trim()
}
