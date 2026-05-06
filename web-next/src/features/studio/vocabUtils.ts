export function isVocabWord(text: string): boolean {
  if (typeof text !== 'string') return false
  const tokens = text.trim().split(/\s+/).filter(Boolean)
  if (tokens.length !== 1) return false
  return /[\p{L}]/u.test(tokens[0])
}

const PLACEHOLDER_DEF_PATTERNS = [
  /^saved from (your )?reading\.?$/i,
  /^definition unavailable\.?$/i,
  /^a word from your reading\.?$/i,
  /^a vocabulary word in this deck\.?$/i,
  /^see [a-z]/i,
]

export function isPlaceholderDefinition(def: string | null | undefined): boolean {
  if (!def) return true
  const trimmed = def.trim()
  if (trimmed.length < 3) return true
  return PLACEHOLDER_DEF_PATTERNS.some((re) => re.test(trimmed))
}
