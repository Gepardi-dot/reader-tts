// Session composition for the Practice (vocabulary studio) feature.
// Spec source of truth: stage→exercise weight table, interleaving constraint,
// anti-patterns (don't-start-hardest, don't-end-on-failure), adaptive re-queueing.

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
// Score by length similarity to the target word — short for short, long for long.
// Dedupe by definition string. Caller is responsible for AI fallback when result is < n.
export interface DistractorCandidate {
  word: string
  definition: string
}

export function pickDistractors(
  targetWord: string,
  candidates: ReadonlyArray<DistractorCandidate>,
  n = 3,
): string[] {
  const targetLen = targetWord.length
  const targetLower = targetWord.toLowerCase()
  const scored = candidates
    .filter((c) => c.word && c.definition && c.word.toLowerCase() !== targetLower)
    .map((c) => ({
      ...c,
      score: Math.abs(c.word.length - targetLen),
    }))
    .sort((a, b) => a.score - b.score)

  const seen = new Set<string>()
  const result: string[] = []
  for (const c of scored) {
    const key = c.definition.trim().toLowerCase()
    if (key && !seen.has(key)) {
      seen.add(key)
      result.push(c.definition)
      if (result.length >= n) break
    }
  }
  return result
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
