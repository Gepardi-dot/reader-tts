// Session composition for the Practice (vocabulary studio) feature.
// Spec source of truth: stage→exercise weight table, interleaving constraint,
// anti-patterns (don't-start-hardest, don't-end-on-failure), adaptive re-queueing.

import { DEFINITION_DISTRACTOR_BANK, isUsableDefinition } from './vocabUtils'

export type CardStage = 'new' | 'learning' | 'review' | 'relearning'

export type ExerciseKind =
  | 'mcq'
  | 'cloze'
  | 'mnemonic'
  | 'recall'
  | 'write-sentence'
  | 'write-definition'
  | 'reverse-recall'
  | 'listening'

export type Rating = 'again' | 'hard' | 'good' | 'easy'

const STAGE_WEIGHTS: Record<CardStage, Partial<Record<ExerciseKind, number>>> = {
  new: { mcq: 0.6, cloze: 0.4 },
  learning: { cloze: 0.3, recall: 0.5, listening: 0.2 },
  review: {
    recall: 0.3,
    'reverse-recall': 0.25,
    'write-sentence': 0.2,
    'write-definition': 0.15,
    listening: 0.1,
  },
  relearning: { mcq: 0.5, cloze: 0.3, mnemonic: 0.2 },
}

const HARD_EXERCISES: ReadonlySet<ExerciseKind> = new Set([
  'write-definition',
  'reverse-recall',
])

export function isHardExercise(kind: ExerciseKind): boolean {
  return HARD_EXERCISES.has(kind)
}

export function pickExerciseForStage(
  stage: CardStage,
  available: ReadonlyArray<ExerciseKind>,
  rng: () => number = Math.random,
): ExerciseKind {
  const weights = STAGE_WEIGHTS[stage]
  const filtered = available
    .map((kind) => [kind, weights[kind] ?? 0] as const)
    .filter(([, w]) => w > 0)

  if (filtered.length === 0) {
    if (available.length === 0) return 'recall'
    return available[Math.floor(rng() * available.length)]
  }

  const total = filtered.reduce((sum, [, w]) => sum + w, 0)
  let r = rng() * total
  for (const [kind, w] of filtered) {
    r -= w
    if (r <= 0) return kind
  }
  return filtered[filtered.length - 1][0]
}

export interface PlanInputWord {
  id: string
  stage: CardStage
}

export interface PlanStep<W extends PlanInputWord> {
  id: string
  word: W
  exercise: ExerciseKind
}

// Single greedy swap pass: avoid two consecutive same-type exercises.
// On small N with skewed stages, one repeat may remain — that is acceptable per plan.
export function interleave<W extends PlanInputWord>(steps: PlanStep<W>[]): PlanStep<W>[] {
  const arr = [...steps]
  for (let i = 0; i < arr.length - 1; i++) {
    if (arr[i].exercise !== arr[i + 1].exercise) continue
    for (let j = i + 2; j < arr.length; j++) {
      const candidate = arr[j]
      const before = arr[i]
      const after = arr[j + 1]
      if (
        candidate.exercise !== before.exercise &&
        (after === undefined || after.exercise !== arr[i + 1].exercise)
      ) {
        ;[arr[i + 1], arr[j]] = [arr[j], arr[i + 1]]
        break
      }
    }
  }
  return arr
}

// Anti-pattern: don't start with the hardest exercise types.
export function enforceNotStartingWithHardest<W extends PlanInputWord>(
  steps: PlanStep<W>[],
): PlanStep<W>[] {
  if (steps.length < 2 || !isHardExercise(steps[0].exercise)) return steps
  const arr = [...steps]
  for (let j = 1; j < arr.length; j++) {
    if (!isHardExercise(arr[j].exercise)) {
      ;[arr[0], arr[j]] = [arr[j], arr[0]]
      break
    }
  }
  return arr
}

export function buildSessionPlan<W extends PlanInputWord>(
  words: ReadonlyArray<W>,
  available: ReadonlyArray<ExerciseKind>,
  rng: () => number = Math.random,
): PlanStep<W>[] {
  if (words.length === 0) return []
  const seen = new Set<string>()
  const steps: PlanStep<W>[] = []
  for (const word of words) {
    if (seen.has(word.id)) continue
    seen.add(word.id)
    const exercise = pickExerciseForStage(word.stage, available, rng)
    steps.push({ id: `${word.id}-${exercise}`, word, exercise })
  }
  return enforceNotStartingWithHardest(interleave(steps))
}

export interface WordPracticeMeta {
  hasUsableDefinition: boolean
  hasBookSentence: boolean
}

/**
 * Prefer practical exercises given what we know about the card:
 * - good book sentence → cloze (context from reading)
 * - usable definition → mcq / reverse-recall / recall
 * - thin data → simpler types only
 */
export function pickExerciseForWordContent(
  stage: CardStage,
  available: ReadonlyArray<ExerciseKind>,
  meta: WordPracticeMeta,
  rng: () => number = Math.random,
): ExerciseKind {
  const base = { ...STAGE_WEIGHTS[stage] }

  if (meta.hasBookSentence) {
    base.cloze = (base.cloze ?? 0) + 0.35
    base.listening = (base.listening ?? 0) + 0.1
  } else {
    delete base.cloze
  }

  if (!meta.hasUsableDefinition) {
    delete base.mcq
    delete base.listening
    delete base['reverse-recall']
    delete base['write-definition']
    delete base.recall
    // Fall back to cloze (if sentence) or mnemonic
    if (meta.hasBookSentence) base.cloze = 1
    else base.mnemonic = 1
  }

  // New words: avoid free production until they know the gloss.
  if (stage === 'new') {
    delete base['write-sentence']
    delete base['write-definition']
    delete base['reverse-recall']
  }

  const weighted = available
    .map((kind) => [kind, base[kind] ?? 0] as const)
    .filter(([, w]) => w > 0)

  if (weighted.length === 0) {
    if (meta.hasBookSentence && available.includes('cloze')) return 'cloze'
    if (meta.hasUsableDefinition && available.includes('mcq')) return 'mcq'
    return available.includes('recall') ? 'recall' : (available[0] ?? 'mcq')
  }

  const total = weighted.reduce((sum, [, w]) => sum + w, 0)
  let r = rng() * total
  for (const [kind, w] of weighted) {
    r -= w
    if (r <= 0) return kind
  }
  return weighted[weighted.length - 1][0]
}

export function buildSmartSessionPlan<W extends PlanInputWord & {
  definition?: string
  sentence?: string
  word?: string
}>(
  words: ReadonlyArray<W>,
  available: ReadonlyArray<ExerciseKind>,
  rng: () => number = Math.random,
): PlanStep<W>[] {
  if (words.length === 0) return []
  const seen = new Set<string>()
  const steps: PlanStep<W>[] = []
  for (const word of words) {
    if (seen.has(word.id)) continue
    seen.add(word.id)
    const head = (word as { word?: string }).word ?? ''
    const def = (word as { definition?: string }).definition ?? ''
    const sentence = (word as { sentence?: string }).sentence ?? ''
    const hasUsableDefinition = isUsableDefinition(def, head)
    const hasBookSentence = Boolean(
      sentence
      && sentence.length > 12
      && !/^as you read/i.test(sentence)
      && (!head || new RegExp(`\\b${head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(sentence)),
    )
    const exercise = pickExerciseForWordContent(
      word.stage,
      available,
      { hasUsableDefinition, hasBookSentence },
      rng,
    )
    steps.push({ id: `${word.id}-${exercise}`, word, exercise })
  }
  return enforceNotStartingWithHardest(interleave(steps))
}

export type SessionMode = 'quick' | 'due' | 'weak' | 'full'

export function sessionLimitForMode(mode: SessionMode): number {
  if (mode === 'quick') return 5
  if (mode === 'due') return 10
  if (mode === 'weak') return 8
  return 12
}

/** Prefer learning/relearning/new over solid review cards for "weak" focus. */
export function prioritizeWordsForMode<W extends PlanInputWord>(
  words: ReadonlyArray<W>,
  mode: SessionMode,
): W[] {
  const list = [...words]
  if (mode === 'weak') {
    const rank = (s: CardStage) => (
      s === 'relearning' ? 0
        : s === 'learning' ? 1
          : s === 'new' ? 2
            : 3
    )
    list.sort((a, b) => rank(a.stage) - rank(b.stage))
  } else if (mode === 'due') {
    const rank = (s: CardStage) => (
      s === 'learning' || s === 'relearning' ? 0
        : s === 'new' ? 1
          : 2
    )
    list.sort((a, b) => rank(a.stage) - rank(b.stage))
  }
  return list
}

// Adaptive re-queueing: append a remedial step on the same word.
// Failed Reverse Recall → MCQ; failed Write Definition → Cloze; otherwise → MCQ.
// Caller tracks how many remedial steps have been appended; we cap at maxAppended.
export function buildRemedialStep<W extends PlanInputWord>(
  failed: PlanStep<W>,
  available: ReadonlyArray<ExerciseKind>,
  appendedCount: number,
  maxAppended = 2,
): PlanStep<W> | null {
  if (appendedCount >= maxAppended) return null
  let remedial: ExerciseKind
  if (failed.exercise === 'reverse-recall') remedial = 'mcq'
  else if (failed.exercise === 'write-definition') remedial = 'cloze'
  else remedial = 'mcq'
  if (!available.includes(remedial)) return null
  return {
    id: `${failed.word.id}-remedial-${appendedCount + 1}`,
    word: failed.word,
    exercise: remedial,
  }
}

// Distractor selection for MCQ and Listening exercises.
// Always returns *definition strings*, never bare headwords.
// Prefers other deck definitions of similar length, then a curated bank.
export interface DistractorCandidate {
  word: string
  definition: string
}

function normalizeDefKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function pickDistractors(
  targetWord: string,
  candidates: ReadonlyArray<DistractorCandidate>,
  n = 3,
  correctDefinition?: string | null,
): string[] {
  const targetLower = targetWord.trim().toLowerCase()
  const correctKey = correctDefinition ? normalizeDefKey(correctDefinition) : ''
  const targetDefLen = correctDefinition?.trim().length || Math.max(24, targetWord.length * 4)

  const scored = candidates
    .filter((c) => {
      if (!c.word || !c.definition) return false
      if (c.word.toLowerCase() === targetLower) return false
      if (!isUsableDefinition(c.definition, c.word)) return false
      const key = normalizeDefKey(c.definition)
      if (correctKey && key === correctKey) return false
      // Never surface a distractor that is just the target headword.
      if (key === targetLower) return false
      return true
    })
    .map((c) => ({
      definition: c.definition.trim(),
      // Prefer definitions of similar length to the correct gloss.
      score: Math.abs(c.definition.trim().length - targetDefLen),
    }))
    .sort((a, b) => a.score - b.score)

  const seen = new Set<string>(correctKey ? [correctKey] : [])
  const result: string[] = []
  for (const c of scored) {
    const key = normalizeDefKey(c.definition)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(c.definition)
    if (result.length >= n) return result
  }

  // Fill from curated bank so MCQ never degrades into single-word options.
  const bank = [...DEFINITION_DISTRACTOR_BANK].sort(
    (a, b) => Math.abs(a.length - targetDefLen) - Math.abs(b.length - targetDefLen),
  )
  for (const def of bank) {
    if (!isUsableDefinition(def)) continue
    const key = normalizeDefKey(def)
    if (seen.has(key) || key === targetLower) continue
    seen.add(key)
    result.push(def)
    if (result.length >= n) break
  }
  return result
}

/** Build a shuffled 4-option MCQ list: 1 correct definition + 3 quality distractors. */
export function buildDefinitionMcqOptions(
  correctDefinition: string,
  distractors: ReadonlyArray<string>,
  targetWord?: string,
  rng: () => number = Math.random,
): string[] {
  const correct = correctDefinition.trim()
  const seen = new Set<string>([normalizeDefKey(correct)])
  const picked: string[] = []

  for (const raw of distractors) {
    const d = raw.trim()
    if (!isUsableDefinition(d, targetWord)) continue
    const key = normalizeDefKey(d)
    if (seen.has(key) || (targetWord && key === targetWord.trim().toLowerCase())) continue
    seen.add(key)
    picked.push(d)
    if (picked.length >= 3) break
  }

  if (picked.length < 3) {
    const more = pickDistractors(targetWord ?? '', [], 3 - picked.length, correct)
    for (const d of more) {
      const key = normalizeDefKey(d)
      if (seen.has(key)) continue
      seen.add(key)
      picked.push(d)
      if (picked.length >= 3) break
    }
  }

  const options = [correct, ...picked.slice(0, 3)]
  for (let i = options.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[options[i], options[j]] = [options[j], options[i]]
  }
  return options
}

// Rating mapping for objective exercises (MCQ, Cloze, Reverse Recall, Listening).
// Recall has its own self-rated 4-point scale — don't use this helper there.
export interface ObjectiveResult {
  correct: boolean
  hintsUsed: number
  attempts: number
}

export function objectiveResultToRating(opts: ObjectiveResult): Rating {
  if (!opts.correct) return 'again'
  if (opts.hintsUsed > 0 || opts.attempts > 1) return 'hard'
  return 'good'
}

const RATING_RANK: Record<Rating, number> = {
  again: 0,
  hard: 1,
  good: 2,
  easy: 3,
}

/** Lower rank = worse outcome (again is worst). */
export function worseRating(a: Rating | null | undefined, b: Rating | null | undefined): Rating | null {
  if (!a) return b ?? null
  if (!b) return a
  return RATING_RANK[a] <= RATING_RANK[b] ? a : b
}

export type WordOutcome = 'correct' | 'retry' | 'again'

export interface SessionStepResult {
  word: string
  wordId?: string
  correct: boolean
  rating?: Rating | null
  exercise?: string
}

export interface AggregatedWordResult {
  word: string
  wordId?: string
  /** True only when every attempt on this word was correct. */
  allCorrect: boolean
  /** True when any attempt was wrong (needs more practice). */
  needsRepeat: boolean
  outcome: WordOutcome
  attempts: number
  misses: number
  worstRating: Rating | null
  steps: SessionStepResult[]
}

/**
 * Aggregate multi-step practice results per word.
 * A word that was missed once then recovered on a remedial still "needs repeat"
 * — last-result-wins was hiding intentional mistakes.
 */
export function aggregateSessionResults(
  results: ReadonlyArray<SessionStepResult>,
): AggregatedWordResult[] {
  const order: string[] = []
  const byWord = new Map<string, SessionStepResult[]>()

  for (const r of results) {
    const key = r.wordId || r.word
    if (!byWord.has(key)) {
      byWord.set(key, [])
      order.push(key)
    }
    byWord.get(key)!.push(r)
  }

  return order.map((key) => {
    const steps = byWord.get(key)!
    const word = steps[0]?.word ?? key
    const misses = steps.filter((s) => !s.correct || s.rating === 'again').length
    const allCorrect = misses === 0
    const needsRepeat = misses > 0
    let worstRating: Rating | null = null
    for (const s of steps) {
      const derived: Rating | null = s.rating
        ?? (s.correct ? 'good' : 'again')
      worstRating = worseRating(worstRating, derived)
    }
    let outcome: WordOutcome = 'correct'
    if (needsRepeat) {
      // Recovered later in the session → retry; still ended cold → again
      const last = steps[steps.length - 1]
      const lastMiss = !last.correct || last.rating === 'again'
      outcome = lastMiss ? 'again' : 'retry'
    }
    return {
      word,
      wordId: steps[0]?.wordId,
      allCorrect,
      needsRepeat,
      outcome,
      attempts: steps.length,
      misses,
      worstRating,
      steps,
    }
  })
}

export function sessionAccuracy(results: ReadonlyArray<SessionStepResult>): {
  stepAccuracy: number
  correctSteps: number
  totalSteps: number
  wordsCorrect: number
  wordsToRepeat: number
  wordCount: number
} {
  const totalSteps = results.length
  const correctSteps = results.filter((r) => r.correct && r.rating !== 'again').length
  const aggregated = aggregateSessionResults(results)
  const wordsCorrect = aggregated.filter((w) => w.allCorrect).length
  const wordsToRepeat = aggregated.filter((w) => w.needsRepeat).length
  return {
    stepAccuracy: Math.round((correctSteps / Math.max(1, totalSteps)) * 100),
    correctSteps,
    totalSteps,
    wordsCorrect,
    wordsToRepeat,
    wordCount: aggregated.length,
  }
}
