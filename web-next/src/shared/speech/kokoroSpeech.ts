/**
 * Shape book text into something Kokoro can say naturally.
 *
 * Kokoro's own number pass turns 1984 into the digits "19 84", which the
 * voice then reads one digit at a time. Years, money, and ordinals are
 * written out here so the model never sees those digits.
 *
 * Paragraph breaks become an em dash. Kokoro pauses on that dash the way a
 * narrator takes a breath. The model has no breath sound, so this does not
 * insert an inhale.
 *
 * The function is safe to run twice. Plain sentences come back unchanged so
 * audio cache keys stay put when nothing about the speech changed.
 */

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
] as const

const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'] as const

const ORDINALS: Record<number, string> = {
  1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth',
  6: 'sixth', 7: 'seventh', 8: 'eighth', 9: 'ninth', 10: 'tenth',
  11: 'eleventh', 12: 'twelfth', 13: 'thirteenth', 14: 'fourteenth', 15: 'fifteenth',
  16: 'sixteenth', 17: 'seventeenth', 18: 'eighteenth', 19: 'nineteenth', 20: 'twentieth',
  30: 'thirtieth', 40: 'fortieth', 50: 'fiftieth', 60: 'sixtieth',
  70: 'seventieth', 80: 'eightieth', 90: 'ninetieth',
}

const DECADES: Record<number, string> = {
  10: 'tens', 20: 'twenties', 30: 'thirties', 40: 'forties',
  50: 'fifties', 60: 'sixties', 70: 'seventies', 80: 'eighties', 90: 'nineties',
}

function under100(n: number): string {
  if (n < 20) return ONES[n] ?? String(n)
  const ten = Math.floor(n / 10)
  const one = n % 10
  return one ? `${TENS[ten]}-${ONES[one]}` : TENS[ten] ?? String(n)
}

function under1000(n: number): string {
  if (n < 100) return under100(n)
  const hundreds = Math.floor(n / 100)
  const rest = n % 100
  const head = `${ONES[hundreds]} hundred`
  return rest ? `${head} ${under100(rest)}` : head
}

export function cardinalWords(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n)
  const whole = Math.floor(n)
  if (whole < 1000) return under1000(whole)
  const scales: Array<[number, string]> = [
    [1_000_000_000, 'billion'],
    [1_000_000, 'million'],
    [1_000, 'thousand'],
  ]
  for (const [scale, name] of scales) {
    if (whole >= scale) {
      const hi = Math.floor(whole / scale)
      const lo = whole % scale
      const head = `${cardinalWords(hi)} ${name}`
      return lo ? `${head} ${cardinalWords(lo)}` : head
    }
  }
  return under1000(whole)
}

/** 1984 → "nineteen eighty-four", 2005 → "two thousand five", 2024 → "twenty twenty-four". */
export function yearWords(year: number): string {
  if (year === 2000) return 'two thousand'
  if (year >= 2000 && year <= 2009) return `two thousand ${under100(year - 2000)}`
  if (year >= 2010 && year <= 2099) return `twenty ${under100(year % 100)}`
  if (year === 1000) return 'one thousand'
  if (year % 100 === 0 && year >= 1100 && year <= 1900) {
    return `${under100(year / 100)} hundred`
  }
  const century = Math.floor(year / 100)
  const rest = year % 100
  const centuryName = under100(century)
  if (rest === 0) return `${centuryName} hundred`
  if (rest < 10) return `${centuryName} oh ${ONES[rest]}`
  return `${centuryName} ${under100(rest)}`
}

function decadeWords(year: number): string {
  if (year === 2000) return 'two thousands'
  if (year >= 2010 && year <= 2090) {
    return `twenty ${DECADES[year % 100] ?? under100(year % 100)}`
  }
  if (year >= 2000 && year < 2010) return 'two thousands'
  const rest = year % 100
  const centuryName = under100(Math.floor(year / 100))
  if (rest === 0) return `${centuryName} hundreds`
  return `${centuryName} ${DECADES[rest] ?? under100(rest)}`
}

function ordinalWords(n: number): string {
  if (ORDINALS[n]) return ORDINALS[n]
  if (n < 100) {
    const tens = Math.floor(n / 10) * 10
    const ones = n % 10
    if (ones && ORDINALS[ones]) return `${under100(tens)}-${ORDINALS[ones]}`
  }
  const rest = n % 100
  if (rest === 0) {
    const base = cardinalWords(n)
    if (base.endsWith('y')) return `${base.slice(0, -1)}ieth`
    return `${base}th`
  }
  return `${cardinalWords(n - rest)} ${ordinalWords(rest)}`
}

function expandAbbreviations(text: string): string {
  return text
    .replace(/\bMr\./g, 'Mister')
    .replace(/\bMrs\./g, 'Missus')
    .replace(/\bMs\./g, 'Miss')
    .replace(/\bDr\./g, 'Doctor')
    .replace(/\bProf\./g, 'Professor')
    .replace(/\bJr\./g, 'Junior')
    .replace(/\bSr\./g, 'Senior')
    .replace(/\bvs\./gi, 'versus')
    .replace(/\betc\./gi, 'et cetera')
    .replace(/\be\.g\./gi, 'for example')
    .replace(/\bi\.e\./gi, 'that is')
}

function verbalizeNumbers(text: string): string {
  let next = text
  next = next.replace(/[$£](\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g, (match, whole: string, frac?: string) => {
    const symbol = match[0] === '£' ? 'pound' : 'dollar'
    const amount = Number(whole.replace(/,/g, ''))
    const unit = amount === 1 ? symbol : `${symbol}s`
    if (!frac) return `${cardinalWords(amount)} ${unit}`
    const cents = Number(frac.padEnd(2, '0').slice(0, 2))
    const coin = match[0] === '£'
      ? (cents === 1 ? 'penny' : 'pence')
      : (cents === 1 ? 'cent' : 'cents')
    return `${cardinalWords(amount)} ${unit} and ${cardinalWords(cents)} ${coin}`
  })
  next = next.replace(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?%/g, (_match, whole: string, frac?: string) => {
    const amount = cardinalWords(Number(whole.replace(/,/g, '')))
    if (!frac) return `${amount} percent`
    const digits = [...frac].map((digit) => ONES[Number(digit)] ?? digit).join(' ')
    return `${amount} point ${digits} percent`
  })
  next = next.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (_match, hour: string, minute: string) => {
    const h = Number(hour)
    const m = Number(minute)
    const hourName = h === 0 ? 'twelve' : under100(h)
    if (m === 0) return `${hourName} o'clock`
    if (m < 10) return `${hourName} oh ${ONES[m]}`
    return `${hourName} ${under100(m)}`
  })
  next = next.replace(
    /\b(1[0-9]{3}|20[0-9]{2})\s*[-–—]\s*(1[0-9]{3}|20[0-9]{2})\b/g,
    (_match, start: string, end: string) => `${yearWords(Number(start))} to ${yearWords(Number(end))}`,
  )
  next = next.replace(/\b((?:1[0-9]|20)[0-9]0)s\b/g, (_match, year: string) => decadeWords(Number(year)))
  next = next.replace(/\b(\d{1,4})(st|nd|rd|th)\b/gi, (match, digits: string, suffix: string) => {
    const n = Number(digits)
    const expected = n % 100 >= 11 && n % 100 <= 13
      ? 'th'
      : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'
    if (suffix.toLowerCase() !== expected) return match
    return ordinalWords(n)
  })
  next = next.replace(/\b\d{1,3}(?:,\d{3})+\b/g, (match) => cardinalWords(Number(match.replace(/,/g, ''))))
  next = next.replace(/\b(1[0-9]{3}|20[0-9]{2})\b/g, (match) => yearWords(Number(match)))
  next = next.replace(/\b([2-9]\d{3}|\d{5,6})\b/g, (match) => cardinalWords(Number(match)))
  next = next.replace(/\b(\d+)\.(\d+)\b/g, (_match, whole: string, frac: string) => {
    const digits = [...frac].map((digit) => ONES[Number(digit)] ?? digit).join(' ')
    return `${cardinalWords(Number(whole))} point ${digits}`
  })
  return next
}

function shapePauses(text: string): string {
  let next = text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n')
  next = next.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
  next = next.replace(/[·•]/g, '. ')
  next = next.replace(/\.{3,}|…+/g, ' … ')
  next = next.replace(/\s*[—–]\s*/g, ' — ')
  // A wrapped line is not a new sentence. A blank line is where a narrator breathes.
  next = next.replace(/\n{3,}/g, '\n\n')
  next = next.replace(/([^.!?"'…—])\s*\n\n/g, '$1.\n\n')
  next = next.replace(/\n\n/g, ' — ')
  next = next.replace(/\n/g, ' ')
  next = next.replace(/([.!?])([A-Za-z])/g, '$1 $2')
  next = next.replace(/[ \t]{2,}/g, ' ')
  next = next.replace(/\s+([,.;:!?])/g, '$1')
  return next.trim()
}

function quietShouting(text: string): string {
  return text.replace(/\b[A-Z]{5,}\b/g, (word) => word[0] + word.slice(1).toLowerCase())
}

export function prepareKokoroSpeech(text: string): string {
  if (!text) return text
  const shaped = shapePauses(verbalizeNumbers(expandAbbreviations(quietShouting(text))))
  return shaped === text ? text : shaped
}
