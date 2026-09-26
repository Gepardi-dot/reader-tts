import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Volume2, X } from 'lucide-react'
import { READER_THEMES } from './readerTheme'
import {
  dictionaryQueryOptions,
  normalizeLookupWord,
  peekCachedDictionary,
} from '@/shared/storage/dictionaryClient'
import { buildDictionaryCard } from '@/shared/storage/dictionaryPresentation'
import {
  prefetchStudioWord,
  speakStudioText,
  stopStudioSpeech,
  warmHostedKokoro,
} from '@/features/studio/studioVoice'

type ReaderColors = typeof READER_THEMES['paper']

export function DictionaryPanel({
  word: initialWord,
  context,
  onClose,
  colors,
}: {
  word: string
  context?: string | null
  onClose: () => void
  colors: ReaderColors
}) {
  const lookupWord = normalizeLookupWord(initialWord) || initialWord
  const placeholder = peekCachedDictionary(lookupWord) ?? undefined
  const { data: dictData, isFetching, refetch } = useQuery({
    ...dictionaryQueryOptions(lookupWord),
    placeholderData: placeholder,
  })

  const card = buildDictionaryCard(dictData, {
    queriedTerm: lookupWord,
    context,
    maxPos: 1,
    maxSensesPerPos: 1,
  })
  const showLoading = !card && (isFetching || !dictData)
  const [speaking, setSpeaking] = useState(false)
  const speakLock = useRef(false)

  useEffect(() => {
    warmHostedKokoro()
    prefetchStudioWord(lookupWord)
    return () => {
      stopStudioSpeech()
    }
  }, [lookupWord])

  async function speak() {
    const term = card?.term || lookupWord
    if (!term?.trim() || speakLock.current) return
    speakLock.current = true
    setSpeaking(true)
    try {
      await speakStudioText(term, { onPlaying: () => setSpeaking(true) })
    } finally {
      speakLock.current = false
      setSpeaking(false)
    }
  }

  const dark = colors.bg === '#1a1a18'
  const accent = dark ? '#c4b08a' : '#9a7b4f'
  const muted = dark ? 'rgba(232,230,225,0.58)' : 'rgba(28,28,30,0.55)'
  const faint = dark ? 'rgba(232,230,225,0.38)' : 'rgba(28,28,30,0.38)'
  const well = dark ? 'rgba(255,255,255,0.05)' : 'rgba(28,28,30,0.045)'
  const rule = dark ? 'rgba(232,230,225,0.12)' : 'rgba(28,28,30,0.10)'

  return (
    <div style={{ color: colors.text, paddingBottom: 'max(env(safe-area-inset-bottom,0px), 28px)' }}>
      <div className="flex items-start justify-between gap-3 px-5 pt-1">
        <div className="flex items-start gap-3.5 min-w-0">
          <button
            type="button"
            onPointerDown={(e) => {
              if (e.button !== 0) return
              void speak()
            }}
            onClick={() => void speak()}
            aria-label="Pronounce"
            className="w-11 h-11 rounded-full flex items-center justify-center shrink-0 mt-0.5 transition-transform active:scale-90"
            style={{
              background: speaking ? accent : colors.text,
              boxShadow: speaking
                ? `0 0 0 4px ${accent}33`
                : dark ? '0 6px 16px rgba(0,0,0,0.35)' : '0 6px 16px rgba(28,28,30,0.14)',
            }}
          >
            <Volume2 size={18} strokeWidth={1.75} style={{ color: speaking ? '#1c1c1e' : colors.bg }} />
          </button>
          <div className="min-w-0 pt-0.5">
            <h2
              className="leading-[1.15] break-words"
              style={{
                fontFamily: '"Playfair Display", Georgia, serif',
                fontSize: 34,
                fontWeight: 400,
                letterSpacing: '-0.03em',
                color: colors.text,
              }}
            >
              {card?.displayTerm || card?.term || lookupWord}
            </h2>
            {card?.pronunciation && (
              <p
                style={{
                  fontSize: 13.5,
                  color: muted,
                  marginTop: 6,
                  letterSpacing: '0.01em',
                  fontFamily: 'Lora, Georgia, serif',
                }}
              >
                {card.pronunciation}
              </p>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded-full transition-opacity shrink-0"
          style={{ color: faint }}
          aria-label="Close"
        >
          <X size={16} />
        </button>
      </div>

      <div className="px-5 pt-4 pb-2" style={{ maxHeight: '62vh', overflowY: 'auto', minHeight: 96 }}>
        {showLoading && (
          <p style={{ fontFamily: 'Lora, Georgia, serif', fontSize: 17, lineHeight: 1.65, color: muted }}>
            Defining…
          </p>
        )}

        {!showLoading && card && (
          <div>
            {card.groups.map((group) => (
              <section key={group.partOfSpeech} className="pb-5">
                <p
                  style={{
                    fontFamily: 'Lora, Georgia, serif',
                    fontStyle: 'italic',
                    fontSize: 14,
                    color: accent,
                    marginBottom: 10,
                    letterSpacing: '0.02em',
                  }}
                >
                  {group.partOfSpeech}
                </p>
                <div className="space-y-5">
                  {group.senses.map((sense, index) => (
                    <div key={`${group.partOfSpeech}-${index}`}>
                      <p
                        style={{
                          fontFamily: 'Lora, Georgia, serif',
                          fontSize: 17,
                          lineHeight: 1.65,
                          color: colors.text,
                        }}
                      >
                        {sense.definition}
                      </p>
                      {sense.example && (
                        <p
                          style={{
                            fontFamily: 'Lora, Georgia, serif',
                            fontStyle: 'italic',
                            fontSize: 15.5,
                            lineHeight: 1.55,
                            color: muted,
                            marginTop: 12,
                            padding: '10px 0 10px 14px',
                            borderLeft: `2px solid ${accent}`,
                          }}
                        >
                          {sense.example}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        {!showLoading && !card && (
          <div className="pt-2 space-y-3">
            <p style={{ fontFamily: 'Lora, Georgia, serif', fontSize: 15, color: muted }}>
              No definition found for “{lookupWord}”.
            </p>
            <button
              type="button"
              onClick={() => void refetch()}
              disabled={isFetching}
              className="text-xs font-semibold px-3 py-1.5 rounded-full"
              style={{
                background: well,
                color: muted,
                border: `1px solid ${rule}`,
                opacity: isFetching ? 0.6 : 1,
              }}
            >
              {isFetching ? 'Looking up…' : 'Try again'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
