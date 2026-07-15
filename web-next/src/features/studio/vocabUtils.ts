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
  /^a word you saved while reading\b/i,
  /^see [a-z]/i,
]

/**
 * True when the string is empty, a known placeholder, or otherwise not a
 * real dictionary-style definition suitable for MCQ / study cards.
 */
export function isPlaceholderDefinition(def: string | null | undefined): boolean {
  if (!def) return true
  const trimmed = def.trim()
  if (trimmed.length < 8) return true
  return PLACEHOLDER_DEF_PATTERNS.some((re) => re.test(trimmed))
}

/**
 * A definition is usable for practice when it looks like a real gloss:
 * multi-word, not equal to the headword, not a single synonym token, etc.
 */
export function isUsableDefinition(
  def: string | null | undefined,
  headword?: string | null,
): boolean {
  if (isPlaceholderDefinition(def)) return false
  const trimmed = String(def).trim()
  const tokens = trimmed.split(/\s+/).filter(Boolean)
  if (tokens.length < 2) return false

  if (headword) {
    const head = headword.trim().toLowerCase()
    if (head && trimmed.toLowerCase() === head) return false
    // "verbal means verbal" / "the word verbal"
    if (new RegExp(`^(the\\s+)?(word\\s+)?${escapeRegex(head)}\\.?$`, 'i').test(trimmed)) {
      return false
    }
  }

  // Reject pure synonym lists like "behind; after" without real content
  if (tokens.length <= 2 && tokens.every((t) => t.length <= 12 && !/[.,;:]/.test(t))) {
    // short two-word phrases can still be valid ("very large") — only reject if both are single short tokens without function words
    const hasFunction = tokens.some((t) => /^(a|an|the|of|to|in|for|with|that|which|from|into|about|relating)$/i.test(t))
    if (!hasFunction && tokens.every((t) => /^[\p{L}'-]+$/u.test(t))) {
      // still allow if total length is decent and looks phrase-like
      if (trimmed.length < 14) return false
    }
  }

  return true
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Curated definition-like distractors when the deck pool is too thin. */
export const DEFINITION_DISTRACTOR_BANK: string[] = [
  'expressed in spoken words rather than in writing',
  'happening by chance rather than by design',
  'difficult to understand or interpret clearly',
  'showing great care and precision in detail',
  'existing only in the mind; not real or physical',
  'relating to the body rather than the mind',
  'done quickly and without careful thought',
  'having a strong pleasant smell',
  'able to be touched or felt; concrete',
  'full of energy and lively enthusiasm',
  'quiet and restrained in manner or expression',
  'open to more than one interpretation',
  'based on reason and careful judgment',
  'lasting for a very short time',
  'marked by deep sincerity and seriousness',
  'tending to cause disagreement or hostility',
  'pleasing to the senses, especially sight',
  'lacking interest or excitement; dull',
  'suitable for a particular purpose or situation',
  'involving great effort or difficulty',
]
