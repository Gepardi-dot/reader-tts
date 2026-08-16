import { describe, expect, it } from 'vitest'
import {
  aggregateSessionResults,
  buildRemedialStep,
  buildSessionPlan,
  buildSmartSessionPlan,
  enforceNotStartingWithHardest,
  interleave,
  isHardExercise,
  objectiveResultToRating,
  pickDistractors,
  pickExerciseForStage,
  pickExerciseForWordContent,
  prioritizeWordsForMode,
  sessionAccuracy,
  sessionLimitForMode,
  worseRating,
  type CardStage,
  type ExerciseKind,
  type PlanInputWord,
  type PlanStep,
} from './sessionPlan'

// Deterministic RNG: given an array of values, returns each in turn.
function seededRng(values: number[]): () => number {
  let i = 0
  return () => {
    const v = values[i % values.length]
    i += 1
    return v
  }
}

const ALL_AVAILABLE: ExerciseKind[] = [
  'mcq', 'cloze', 'recall', 'write-sentence', 'write-definition', 'mnemonic',
]

const PHASE2_AVAILABLE: ExerciseKind[] = ALL_AVAILABLE  // listening + reverse-recall enabled in P3

function word(id: string, stage: CardStage): PlanInputWord {
  return { id, stage }
}

function step<W extends PlanInputWord>(w: W, exercise: ExerciseKind): PlanStep<W> {
  return { id: `${w.id}-${exercise}`, word: w, exercise }
}

describe('pickExerciseForStage', () => {
  it('returns an exercise allowed for the stage', () => {
    const result = pickExerciseForStage('new', PHASE2_AVAILABLE, () => 0)
    expect(['mcq', 'cloze']).toContain(result)
  })

  it('respects the available filter — listening dropped in P2', () => {
    // Stage "learning" has listening 0.2 — should never return it when not available.
    const counts = { cloze: 0, recall: 0, listening: 0 }
    const rng = seededRng([0.05, 0.4, 0.85, 0.5, 0.1, 0.95])
    for (let i = 0; i < 6; i++) {
      const r = pickExerciseForStage('learning', PHASE2_AVAILABLE, rng)
      counts[r as keyof typeof counts] = (counts[r as keyof typeof counts] ?? 0) + 1
    }
    expect(counts.listening).toBe(0)
    expect(counts.cloze + counts.recall).toBe(6)
  })

  it('returns the same exercise for a fixed RNG and weight band', () => {
    // new stage: mcq=0.6, cloze=0.4, total=1.0. r=0.5 → mcq (0.6 > 0.5)
    const rng = () => 0.5
    expect(pickExerciseForStage('new', PHASE2_AVAILABLE, rng)).toBe('mcq')
    // r=0.85 → cloze (0.6 covered, 0.4 covers next 0.4)
    expect(pickExerciseForStage('new', PHASE2_AVAILABLE, () => 0.85)).toBe('cloze')
  })

  it('relearning includes mnemonic in the distribution', () => {
    const counts: Partial<Record<ExerciseKind, number>> = {}
    const rng = seededRng([0.05, 0.4, 0.6, 0.85, 0.95, 0.7])
    for (let i = 0; i < 6; i++) {
      const r = pickExerciseForStage('relearning', PHASE2_AVAILABLE, rng)
      counts[r] = (counts[r] ?? 0) + 1
    }
    // With those samples, mnemonic should appear at least once (0.85 lands in the 0.8–1.0 band).
    expect((counts.mnemonic ?? 0) + (counts.mcq ?? 0) + (counts.cloze ?? 0)).toBe(6)
    expect(counts.mnemonic ?? 0).toBeGreaterThanOrEqual(1)
  })
})

describe('isHardExercise', () => {
  it('marks write-definition and reverse-recall as hard', () => {
    expect(isHardExercise('write-definition')).toBe(true)
    expect(isHardExercise('reverse-recall')).toBe(true)
  })
  it('marks easier exercises as not hard', () => {
    expect(isHardExercise('mcq')).toBe(false)
    expect(isHardExercise('cloze')).toBe(false)
    expect(isHardExercise('recall')).toBe(false)
    expect(isHardExercise('listening')).toBe(false)
  })
})

describe('interleave', () => {
  it('swaps consecutive same-type pairs when a non-conflicting later step exists', () => {
    const a = word('a', 'new')
    const b = word('b', 'new')
    const c = word('c', 'review')
    const steps: PlanStep<PlanInputWord>[] = [
      step(a, 'mcq'),
      step(b, 'mcq'),
      step(c, 'recall'),
    ]
    const result = interleave(steps)
    expect(result.map((s) => s.exercise)).toEqual(['mcq', 'recall', 'mcq'])
  })

  it('leaves non-conflicting plan untouched', () => {
    const a = word('a', 'new')
    const b = word('b', 'review')
    const steps: PlanStep<PlanInputWord>[] = [step(a, 'mcq'), step(b, 'recall')]
    expect(interleave(steps).map((s) => s.exercise)).toEqual(['mcq', 'recall'])
  })

  it('accepts unavoidable repeats with a single greedy pass', () => {
    // Three consecutive mcqs and no non-mcq alternative — interleave can't fix this.
    const a = word('a', 'new')
    const b = word('b', 'new')
    const c = word('c', 'new')
    const steps: PlanStep<PlanInputWord>[] = [
      step(a, 'mcq'),
      step(b, 'mcq'),
      step(c, 'mcq'),
    ]
    expect(interleave(steps).map((s) => s.exercise)).toEqual(['mcq', 'mcq', 'mcq'])
  })
})

describe('enforceNotStartingWithHardest', () => {
  it('swaps the first step when it is a hard exercise', () => {
    const a = word('a', 'review')
    const b = word('b', 'review')
    const steps: PlanStep<PlanInputWord>[] = [
      step(a, 'write-definition'),
      step(b, 'recall'),
    ]
    const result = enforceNotStartingWithHardest(steps)
    expect(result[0].exercise).toBe('recall')
    expect(result[1].exercise).toBe('write-definition')
  })

  it('leaves the plan untouched when first step is already easy', () => {
    const a = word('a', 'new')
    const b = word('b', 'review')
    const steps: PlanStep<PlanInputWord>[] = [step(a, 'mcq'), step(b, 'write-definition')]
    expect(enforceNotStartingWithHardest(steps)).toEqual(steps)
  })

  it('keeps a hard-only plan as-is when no easy alternative exists', () => {
    const a = word('a', 'review')
    const b = word('b', 'review')
    const steps: PlanStep<PlanInputWord>[] = [
      step(a, 'write-definition'),
      step(b, 'reverse-recall'),
    ]
    expect(enforceNotStartingWithHardest(steps)).toEqual(steps)
  })
})

describe('buildSessionPlan', () => {
  it('emits one step per word', () => {
    const words = [word('a', 'new'), word('b', 'review'), word('c', 'learning')]
    const plan = buildSessionPlan(words, PHASE2_AVAILABLE, () => 0.5)
    expect(plan).toHaveLength(3)
    expect(plan.map((s) => s.word.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('does not start with a hard exercise when an easier one exists', () => {
    const words = [word('a', 'review'), word('b', 'new')]
    // Force first word to get write-definition: review weights → r=0.95 lands in write-def band.
    const rng = seededRng([0.92, 0.0])
    const plan = buildSessionPlan(words, PHASE2_AVAILABLE, rng)
    expect(isHardExercise(plan[0].exercise)).toBe(false)
  })

  it('interleaves consecutive same-type exercises when alternatives exist', () => {
    // Two new words → mcq/mcq, two review words → recall/recall.
    // Pre-interleave: [mcq, mcq, recall, recall]. Post-interleave should alternate.
    const words = [
      word('a', 'new'), word('b', 'new'), word('c', 'review'), word('d', 'review'),
    ]
    const rng = () => 0
    const plan = buildSessionPlan(words, PHASE2_AVAILABLE, rng)
    for (let i = 0; i < plan.length - 1; i++) {
      expect(plan[i].exercise).not.toBe(plan[i + 1].exercise)
    }
  })

  it('skips duplicate word ids', () => {
    const words = [word('a', 'new'), word('a', 'new'), word('b', 'review')]
    const plan = buildSessionPlan(words, PHASE2_AVAILABLE, () => 0)
    expect(plan).toHaveLength(2)
  })

  it('returns empty plan for empty input', () => {
    expect(buildSessionPlan([], PHASE2_AVAILABLE)).toEqual([])
  })
})

describe('buildRemedialStep', () => {
  const w = word('w1', 'review')

  it('appends an MCQ when reverse-recall fails', () => {
    const failed = step(w, 'reverse-recall')
    const remedial = buildRemedialStep(failed, PHASE2_AVAILABLE, 0)
    expect(remedial?.exercise).toBe('mcq')
    expect(remedial?.word.id).toBe('w1')
  })

  it('appends a cloze when write-definition fails', () => {
    const failed = step(w, 'write-definition')
    const remedial = buildRemedialStep(failed, PHASE2_AVAILABLE, 0)
    expect(remedial?.exercise).toBe('cloze')
  })

  it('appends an MCQ for any other failed type (don\'t-end-on-failure)', () => {
    const failed = step(w, 'recall')
    const remedial = buildRemedialStep(failed, PHASE2_AVAILABLE, 1)
    expect(remedial?.exercise).toBe('mcq')
  })

  it('returns null when the cap is hit', () => {
    const failed = step(w, 'reverse-recall')
    expect(buildRemedialStep(failed, PHASE2_AVAILABLE, 2)).toBeNull()
    expect(buildRemedialStep(failed, PHASE2_AVAILABLE, 5)).toBeNull()
  })

  it('returns null when remedial type is not available', () => {
    const failed = step(w, 'reverse-recall')
    const noMcq = PHASE2_AVAILABLE.filter((k) => k !== 'mcq')
    expect(buildRemedialStep(failed, noMcq, 0)).toBeNull()
  })
})

describe('pickDistractors', () => {
  it('returns up to n distractor definitions', () => {
    const result = pickDistractors('cat', [
      { word: 'dog', definition: 'a domesticated canine companion animal' },
      { word: 'fish', definition: 'an aquatic vertebrate that lives in water' },
      { word: 'bird', definition: 'a feathered flying animal with wings' },
      { word: 'mouse', definition: 'a small rodent often found in homes' },
    ], 3)
    expect(result).toHaveLength(3)
    for (const def of result) {
      expect(def.split(/\s+/).length).toBeGreaterThanOrEqual(2)
    }
  })

  it('excludes the target word itself (case-insensitive)', () => {
    const result = pickDistractors('Cat', [
      { word: 'cat', definition: 'a small domesticated feline animal' },
      { word: 'dog', definition: 'a loyal domesticated canine companion' },
      { word: 'fish', definition: 'an aquatic vertebrate that lives in water' },
    ], 3)
    expect(result.some((d) => /feline/i.test(d))).toBe(false)
  })

  it('never returns single-word distractors even when candidates are weak', () => {
    const result = pickDistractors('verbal', [
      { word: 'behind', definition: 'behind' },
      { word: 'incredible', definition: 'incredible' },
      { word: 'billed', definition: 'billed' },
    ], 3, 'relating to or consisting of words')
    expect(result).toHaveLength(3)
    expect(result).not.toContain('behind')
    expect(result).not.toContain('verbal')
    for (const def of result) {
      expect(def.split(/\s+/).length).toBeGreaterThanOrEqual(3)
    }
  })

  it('prefers definitions of similar length to the correct gloss', () => {
    const correct = 'a place where one lives and feels at home'
    const result = pickDistractors('happy', [
      { word: 'x', definition: 'showing deep concern and kindness toward other people in need' },
      { word: 'y', definition: 'a place where one lives and feels safe' },
      { word: 'z', definition: 'unhappy feeling after a loss' },
    ], 1, correct)
    expect(result[0]).toBe('a place where one lives and feels safe')
  })

  it('dedupes by definition', () => {
    const result = pickDistractors('cat', [
      { word: 'dog', definition: 'a loyal domesticated canine companion' },
      { word: 'pup', definition: 'a loyal domesticated canine companion' },
      { word: 'fish', definition: 'an aquatic vertebrate living in water' },
    ], 3)
    // 2 unique from candidates + bank fill may add more; at least 2 unique from input
    const unique = new Set(result.map((d) => d.toLowerCase()))
    expect(unique.size).toBe(result.length)
    expect(result.filter((d) => d.includes('canine')).length).toBe(1)
  })

  it('fills from the bank when the pool is small', () => {
    const result = pickDistractors('cat', [
      { word: 'dog', definition: 'a loyal domesticated canine companion' },
    ], 3)
    expect(result).toHaveLength(3)
  })
})

describe('objectiveResultToRating', () => {
  it('first-try correct → good', () => {
    expect(objectiveResultToRating({ correct: true, hintsUsed: 0, attempts: 1 })).toBe('good')
  })
  it('correct after hint → hard', () => {
    expect(objectiveResultToRating({ correct: true, hintsUsed: 1, attempts: 1 })).toBe('hard')
  })
  it('correct after multiple attempts → hard', () => {
    expect(objectiveResultToRating({ correct: true, hintsUsed: 0, attempts: 2 })).toBe('hard')
  })
  it('wrong → again, regardless of hints/attempts', () => {
    expect(objectiveResultToRating({ correct: false, hintsUsed: 0, attempts: 1 })).toBe('again')
    expect(objectiveResultToRating({ correct: false, hintsUsed: 2, attempts: 3 })).toBe('again')
  })
})

describe('aggregateSessionResults', () => {
  it('does not hide a miss behind a later remedial success (last-wins bug)', () => {
    const aggregated = aggregateSessionResults([
      { word: 'incredible', wordId: '1', correct: false, rating: 'again', exercise: 'mcq' },
      { word: 'incredible', wordId: '1', correct: true, rating: 'good', exercise: 'mcq' },
      { word: 'behind', wordId: '2', correct: true, rating: 'good', exercise: 'mcq' },
    ])
    expect(aggregated).toHaveLength(2)
    const incredible = aggregated.find((w) => w.word === 'incredible')!
    expect(incredible.needsRepeat).toBe(true)
    expect(incredible.allCorrect).toBe(false)
    expect(incredible.outcome).toBe('retry') // recovered on second attempt
    expect(incredible.misses).toBe(1)
    expect(incredible.worstRating).toBe('again')

    const behind = aggregated.find((w) => w.word === 'behind')!
    expect(behind.outcome).toBe('correct')
    expect(behind.needsRepeat).toBe(false)
  })

  it('counts every intentional miss across different words', () => {
    const aggregated = aggregateSessionResults([
      { word: 'a', correct: false },
      { word: 'b', correct: false },
      { word: 'c', correct: true },
      { word: 'd', correct: false },
      { word: 'e', correct: true },
      { word: 'f', correct: true },
    ])
    const stats = sessionAccuracy([
      { word: 'a', correct: false },
      { word: 'b', correct: false },
      { word: 'c', correct: true },
      { word: 'd', correct: false },
      { word: 'e', correct: true },
      { word: 'f', correct: true },
    ])
    expect(aggregated.filter((w) => w.needsRepeat)).toHaveLength(3)
    expect(stats.wordsToRepeat).toBe(3)
    expect(stats.wordsCorrect).toBe(3)
    expect(stats.stepAccuracy).toBe(50)
  })

  it('treats explicit again rating as a miss even if correct flag is wrong', () => {
    const [row] = aggregateSessionResults([
      { word: 'x', correct: true, rating: 'again' },
    ])
    expect(row.needsRepeat).toBe(true)
    expect(row.outcome).toBe('again')
  })
})

describe('worseRating', () => {
  it('prefers again over good', () => {
    expect(worseRating('good', 'again')).toBe('again')
    expect(worseRating('again', 'easy')).toBe('again')
  })
})

describe('pickExerciseForWordContent', () => {
  const available: ExerciseKind[] = [
    'mcq', 'cloze', 'recall', 'listening', 'reverse-recall', 'write-definition', 'mnemonic',
  ]

  it('schedules type-the-word (cloze) when a usable definition exists', () => {
    let cloze = 0
    for (let i = 0; i < 40; i++) {
      const kind = pickExerciseForWordContent(
        'new',
        available,
        { hasUsableDefinition: true, hasBookSentence: false },
        () => (i % 10) / 10,
      )
      if (kind === 'cloze') cloze += 1
    }
    expect(cloze).toBeGreaterThan(0)
  })

  it('falls back to mnemonic when no usable definition', () => {
    const kind = pickExerciseForWordContent(
      'new',
      available,
      { hasUsableDefinition: false, hasBookSentence: true },
      () => 0.1,
    )
    expect(kind).toBe('mnemonic')
  })

  it('does not require a book sentence for cloze', () => {
    const kind = pickExerciseForWordContent(
      'learning',
      available,
      { hasUsableDefinition: true, hasBookSentence: false },
      () => 0.05,
    )
    expect(['cloze', 'recall', 'listening']).toContain(kind)
  })
})

describe('session modes', () => {
  it('limits quick sessions to 5', () => {
    expect(sessionLimitForMode('quick')).toBe(5)
  })

  it('puts weak stages first', () => {
    const words: PlanInputWord[] = [
      { id: '1', stage: 'review' },
      { id: '2', stage: 'learning' },
      { id: '3', stage: 'new' },
    ]
    expect(prioritizeWordsForMode(words, 'weak').map((w) => w.id)).toEqual(['2', '3', '1'])
  })
})

describe('buildSmartSessionPlan', () => {
  it('builds one step per word', () => {
    const words = [
      {
        id: 'a',
        stage: 'new' as const,
        word: 'verbal',
        definition: 'relating to or consisting of words',
        sentence: 'His verbal promise meant little in the story.',
      },
      {
        id: 'b',
        stage: 'learning' as const,
        word: 'behind',
        definition: 'at the back of something',
        sentence: '',
      },
    ]
    const plan = buildSmartSessionPlan(words, ALL_AVAILABLE, () => 0.2)
    expect(plan).toHaveLength(2)
    expect(new Set(plan.map((p) => p.word.id)).size).toBe(2)
  })
})
