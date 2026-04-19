import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import {
  createLiveAudioSegment,
  getBookProgress,
  getBookReader,
  getProviders,
  getStoredAudioPreference,
  persistAudioPreference,
  updateAudioProgress,
  updateReadingProgress,
} from '@/shared/api/client'
import { useAudioStore } from '@/shared/state/audioStore'
import type { Highlight, HighlightColor } from '@/shared/types/api'
import { resolveAudioSelection } from '@/shared/utils/audioPreference'
import { paginateText, type ReaderPage } from '@/shared/utils/paginateText'
import styles from './BookRoute.module.css'

// ── Appearance ────────────────────────────────────────────────────────────────

type Appearance = {
  fontFamily: 'serif' | 'sans'
  fontSize: number                                  // rem, 0.9–1.4
  widthPreset: 'narrow' | 'balanced' | 'wide'
  textAlign: 'left' | 'justify'
  spacingPreset: 'tight' | 'comfort' | 'airy'
}

const WIDTH_CH: Record<Appearance['widthPreset'], number>   = { narrow: 52, balanced: 68, wide: 85 }
const SPACING_LH: Record<Appearance['spacingPreset'], number> = { tight: 1.55, comfort: 1.9, airy: 2.3 }

const DEFAULT_APPEARANCE: Appearance = {
  fontFamily: 'serif',
  fontSize: 1.06,
  widthPreset: 'balanced',
  textAlign: 'justify',
  spacingPreset: 'comfort',
}

const APPEARANCE_KEY = 'storybook-reader-appearance'

function loadAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(APPEARANCE_KEY)
    if (!raw) return DEFAULT_APPEARANCE
    const p = JSON.parse(raw) as Partial<Appearance>
    return {
      fontFamily: p.fontFamily === 'sans' ? 'sans' : 'serif',
      fontSize: typeof p.fontSize === 'number' ? Math.min(1.4, Math.max(0.9, p.fontSize)) : DEFAULT_APPEARANCE.fontSize,
      widthPreset: (['narrow', 'balanced', 'wide'] as const).includes(p.widthPreset as never)
        ? (p.widthPreset as Appearance['widthPreset']) : DEFAULT_APPEARANCE.widthPreset,
      textAlign: p.textAlign === 'left' ? 'left' : 'justify',
      spacingPreset: (['tight', 'comfort', 'airy'] as const).includes(p.spacingPreset as never)
        ? (p.spacingPreset as Appearance['spacingPreset']) : DEFAULT_APPEARANCE.spacingPreset,
    }
  } catch { return DEFAULT_APPEARANCE }
}

function saveAppearance(a: Appearance) {
  try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify(a)) } catch { /* ignore */ }
}

// ── Text rendering ────────────────────────────────────────────────────────────

type TextPiece = { type: 'plain' | 'highlight'; text: string; highlight?: Highlight }

function buildPieces(page: ReaderPage, highlights: Highlight[]): TextPiece[] {
  const pageHighlights = highlights
    .filter((h) => h.end > page.start && h.start < page.end)
    .sort((a, b) => a.start - b.start)
  const pieces: TextPiece[] = []
  let cursor = page.start
  for (const h of pageHighlights) {
    const rs = Math.max(h.start, page.start)
    const re = Math.min(h.end, page.end)
    if (rs > cursor) pieces.push({ type: 'plain', text: page.text.slice(cursor - page.start, rs - page.start) })
    if (re > rs) { pieces.push({ type: 'highlight', text: page.text.slice(rs - page.start, re - page.start), highlight: h }); cursor = re }
  }
  if (cursor < page.end) pieces.push({ type: 'plain', text: page.text.slice(cursor - page.start) })
  return pieces
}

function renderParagraphs(pieces: TextPiece[]) {
  type Token = { text: string; highlight?: Highlight }
  const tokens: Token[] = []
  for (const piece of pieces) {
    if (piece.type === 'highlight') tokens.push({ text: piece.text, highlight: piece.highlight })
    else for (const part of piece.text.split(/(\n\n+)/)) tokens.push({ text: part })
  }
  const paragraphs: Token[][] = [[]]
  for (const token of tokens) {
    if (!token.highlight && /^\n\n+$/.test(token.text)) paragraphs.push([])
    else if (token.text.length > 0) paragraphs[paragraphs.length - 1].push(token)
  }
  return paragraphs.filter((p) => p.length > 0)
}

const HIGHLIGHT_CLASS: Record<HighlightColor, string> = {
  amber: styles.highlightAmber,
  sky:   styles.highlightSky,
  rose:  styles.highlightRose,
}

// ── Types ─────────────────────────────────────────────────────────────────────

type ReaderTab = 'reader' | 'edit' | 'audio'

// ── Component ─────────────────────────────────────────────────────────────────

export function BookRoute() {
  const { bookId = '' } = useParams()
  const pageTopRef = useRef<HTMLDivElement | null>(null)
  const [audioPreference, setAudioPreference] = useState(getStoredAudioPreference)
  const setTrack = useAudioStore((s) => s.setTrack)

  // Queries
  const readerQuery   = useQuery({ queryKey: ['reader', bookId],   queryFn: () => getBookReader(bookId),   enabled: Boolean(bookId) })
  const progressQuery = useQuery({ queryKey: ['progress', bookId], queryFn: () => getBookProgress(bookId), enabled: Boolean(bookId) })
  const providersQuery = useQuery({ queryKey: ['providers'], queryFn: getProviders })

  const pages = useMemo(() => paginateText(readerQuery.data?.text ?? ''), [readerQuery.data?.text])

  // Page index
  const [pageIndex, setPageIndex] = useState<number | null>(null)
  const derivedPageIndex = useMemo(() => {
    if (!pages.length) return 0
    return Math.min(Math.max(0, (progressQuery.data?.reading?.pageNumber ?? 1) - 1), pages.length - 1)
  }, [pages, progressQuery.data?.reading?.pageNumber])
  const activePageIndex = pageIndex ?? derivedPageIndex
  const currentPage = pages[activePageIndex] ?? pages[0]

  // Appearance
  const [appearance, setAppearance] = useState<Appearance>(loadAppearance)
  function updateAppearance(delta: Partial<Appearance>) {
    setAppearance((prev) => { const next = { ...prev, ...delta }; saveAppearance(next); return next })
  }

  // Active tab
  const [activeTab, setActiveTab] = useState<ReaderTab>('reader')

  // Audio selection
  const audioSelection = useMemo(
    () => providersQuery.data
      ? resolveAudioSelection(providersQuery.data.providers, audioPreference)
      : { provider: null, voiceId: null, modelId: null },
    [audioPreference, providersQuery.data],
  )

  // Scroll to top on page change
  useEffect(() => {
    pageTopRef.current?.scrollIntoView({ behavior: 'instant', block: 'start' })
  }, [activePageIndex])

  // Keyboard navigation (only in reader tab)
  const goTo = useCallback((index: number) => {
    setPageIndex(Math.max(0, Math.min(pages.length - 1, index)))
  }, [pages.length])

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (activeTab !== 'reader') return
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); goTo(activePageIndex + 1) }
      if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   { e.preventDefault(); goTo(activePageIndex - 1) }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [activePageIndex, activeTab, goTo])

  // Progress sync
  const progressMutation = useMutation({
    mutationFn: (page: ReaderPage) => updateReadingProgress(bookId, {
      pageNumber: page.pageNumber, totalPages: pages.length,
      textStart: page.start, textEnd: page.end, textLength: readerQuery.data?.text.length ?? 0,
    }),
  })
  useEffect(() => {
    if (!currentPage || !bookId || !readerQuery.data?.text.length) return
    void progressMutation.mutateAsync(currentPage).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, currentPage])

  // Audio generation
  const audioMutation = useMutation({
    mutationFn: async ({ start, end, text }: { start: number; end: number; text: string }) => {
      if (!audioSelection.provider || !currentPage) throw new Error('No audio provider available.')
      const segment = await createLiveAudioSegment(bookId, {
        provider: audioSelection.provider.id, voice: audioSelection.voiceId, model: audioSelection.modelId,
        output_format: audioPreference.outputFormat, narration_style: audioPreference.narrationStyle,
        length_scale: audioPreference.lengthScale, sentence_silence: audioPreference.sentenceSilence,
        pageNumber: currentPage.pageNumber, start, end, text,
      })
      await updateAudioProgress(bookId, { audioUrl: segment.url, currentTime: 0, wasPlaying: true })
      return segment
    },
    onSuccess: (segment) => setTrack(
      { id: `${segment.pageNumber}:${segment.start}`, url: segment.url, title: readerQuery.data?.book.title ?? 'Reader', subtitle: `Page ${segment.pageNumber}` },
      true,
    ),
  })

  // Loading state
  if (!readerQuery.data || !currentPage) {
    return (
      <section className={styles.loading}>
        <article className={`surface ${styles.loadingPanel}`}>
          <p className="eyebrow">Opening book</p>
          <h2>{readerQuery.isError ? 'Could not load book.' : 'Loading…'}</h2>
          {readerQuery.isError && <Link className="button button--secondary" to="/books">Back to library</Link>}
        </article>
      </section>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const paragraphs    = renderParagraphs(buildPieces(currentPage, readerQuery.data.highlights))
  const progressPercent = pages.length > 0 ? Math.round(((activePageIndex + 1) / pages.length) * 100) : 0

  const textStyle = {
    fontFamily: appearance.fontFamily === 'sans' ? 'var(--font-ui)' : 'var(--font-display)',
    fontSize:   `${appearance.fontSize}rem`,
    lineHeight: SPACING_LH[appearance.spacingPreset],
    maxWidth:   `${WIDTH_CH[appearance.widthPreset]}ch`,
    textAlign:  appearance.textAlign as 'left' | 'justify',
  }

  function handleTabClick(tab: ReaderTab) {
    // Tapping the active non-reader tab collapses back to reader
    setActiveTab(activeTab === tab && tab !== 'reader' ? 'reader' : tab)
  }

  return (
    <div className={styles.root} ref={pageTopRef}>

      {/* ── Header ── */}
      <header className={styles.header}>
        <Link className={styles.backBtn} to="/books">
          <span className={styles.backChevron}>‹</span>
          <span>Library</span>
        </Link>
        <div className={styles.headerCenter}>
          <h1 className={styles.bookTitle}>{readerQuery.data.book.title}</h1>
          <p className={styles.headerProgress}>Pg {currentPage.pageNumber} / {pages.length} · {progressPercent}% read</p>
        </div>
        <div className={styles.headerSpacer} />
      </header>

      {/* ── Tab bar ── */}
      <div className={styles.tabBarWrap}>
        <div className={styles.tabBar} role="tablist">
          {(['reader', 'edit', 'audio'] as const).map((tab) => (
            <button
              key={tab}
              role="tab"
              aria-selected={activeTab === tab}
              className={`${styles.tab} ${activeTab === tab ? styles.tabActive : ''}`}
              onClick={() => handleTabClick(tab)}
              type="button"
            >
              {tab === 'reader' ? 'Reader' : tab === 'edit' ? 'Edit' : 'Audio'}
            </button>
          ))}
        </div>
      </div>

      {/* ── Reading area (always rendered) ── */}
      <div className={styles.readerPane}>
        <article className={styles.pageText} style={textStyle}>
          {paragraphs.map((para, pi) => (
            <p className={styles.paragraph} key={pi}>
              {para.map((token, ti) =>
                token.highlight ? (
                  <mark
                    className={`${styles.highlight} ${HIGHLIGHT_CLASS[token.highlight.color]}`}
                    key={`${token.highlight.id}-${ti}`}
                  >
                    {token.text}
                  </mark>
                ) : (
                  <Fragment key={`t-${pi}-${ti}`}>{token.text}</Fragment>
                ),
              )}
            </p>
          ))}
        </article>

        {/* Page nav */}
        <div className={styles.pageNav}>
          <button
            className={styles.navBtn}
            disabled={activePageIndex === 0}
            onClick={() => goTo(activePageIndex - 1)}
            type="button"
            aria-label="Previous page"
          >←</button>
          <div className={styles.progressTrack} role="progressbar" aria-valuenow={progressPercent} aria-valuemin={0} aria-valuemax={100}>
            <div className={styles.progressFill} style={{ width: `${progressPercent}%` }} />
          </div>
          <button
            className={styles.navBtn}
            disabled={activePageIndex >= pages.length - 1}
            onClick={() => goTo(activePageIndex + 1)}
            type="button"
            aria-label="Next page"
          >→</button>
        </div>
      </div>

      {/* ── Edit sheet ── */}
      {activeTab === 'edit' && (
        <div className={styles.sheet} role="tabpanel">
          <div className={styles.sheetHandle} />

          {/* FORMAT: font + size slider on same row */}
          <div className={`${styles.sheetRow} ${styles.sheetRowFormat}`}>
            <span className={styles.sheetLabel}>FORMAT</span>
            <div className={styles.pillGroup}>
              <button
                className={`${styles.pill} ${appearance.fontFamily === 'serif' ? styles.pillActive : ''}`}
                onClick={() => updateAppearance({ fontFamily: 'serif' })}
                type="button"
                style={{ fontFamily: 'var(--font-display)' }}
              >Serif</button>
              <button
                className={`${styles.pill} ${appearance.fontFamily === 'sans' ? styles.pillActive : ''}`}
                onClick={() => updateAppearance({ fontFamily: 'sans' })}
                type="button"
              >Sans</button>
            </div>
            <div className={styles.sizeRow}>
              <span className={styles.sizeLabel}>A−</span>
              <input
                className={styles.sizeSlider}
                type="range" min={0.9} max={1.4} step={0.02}
                value={appearance.fontSize}
                onChange={(e) => updateAppearance({ fontSize: Number(e.target.value) })}
                aria-label="Font size"
              />
              <span className={`${styles.sizeLabel} ${styles.sizeLabelPlus}`}>A+</span>
            </div>
          </div>

          <div className={styles.sheetDivider} />

          {/* SIZE PAGE */}
          <div className={styles.sheetRow}>
            <span className={styles.sheetLabel}>SIZE{'\n'}PAGE</span>
            <div className={styles.pillGroup}>
              {(['narrow', 'balanced', 'wide'] as const).map((p) => (
                <button
                  key={p}
                  className={`${styles.pill} ${appearance.widthPreset === p ? styles.pillActive : ''}`}
                  onClick={() => updateAppearance({ widthPreset: p })}
                  type="button"
                >{p.charAt(0).toUpperCase() + p.slice(1)}</button>
              ))}
            </div>
          </div>

          <div className={styles.sheetDivider} />

          {/* TEXT alignment */}
          <div className={styles.sheetRow}>
            <span className={styles.sheetLabel}>TEXT</span>
            <div className={styles.pillGroup}>
              <button
                className={`${styles.pill} ${appearance.textAlign === 'left' ? styles.pillActive : ''}`}
                onClick={() => updateAppearance({ textAlign: 'left' })}
                type="button"
              >Left</button>
              <button
                className={`${styles.pill} ${appearance.textAlign === 'justify' ? styles.pillActive : ''}`}
                onClick={() => updateAppearance({ textAlign: 'justify' })}
                type="button"
              >Justify</button>
            </div>
          </div>

          <div className={styles.sheetDivider} />

          {/* SPACING */}
          <div className={styles.sheetRow}>
            <span className={styles.sheetLabel}>SPACING</span>
            <div className={styles.pillGroup}>
              {(['tight', 'comfort', 'airy'] as const).map((p) => (
                <button
                  key={p}
                  className={`${styles.pill} ${appearance.spacingPreset === p ? styles.pillActive : ''}`}
                  onClick={() => updateAppearance({ spacingPreset: p })}
                  type="button"
                >{p.charAt(0).toUpperCase() + p.slice(1)}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Audio sheet ── */}
      {activeTab === 'audio' && (
        <div className={styles.sheet} role="tabpanel">
          <div className={styles.sheetHandle} />

          <div className={styles.audioGrid}>
            <label className={styles.audioField}>
              <span className={styles.sheetLabel}>PROVIDER</span>
              <select
                className="select"
                value={audioPreference.providerId ?? ''}
                onChange={(e) => {
                  const next = { ...audioPreference, providerId: (e.target.value as never) || null }
                  setAudioPreference(next)
                  persistAudioPreference(next)
                }}
              >
                <option value="">Auto</option>
                {providersQuery.data?.providers.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.available}>
                    {p.name}{p.available ? '' : ' (unavailable)'}
                  </option>
                ))}
              </select>
            </label>

            <label className={styles.audioField}>
              <span className={styles.sheetLabel}>VOICE</span>
              <select
                className="select"
                value={audioPreference.voiceId ?? ''}
                onChange={(e) => {
                  const next = { ...audioPreference, voiceId: e.target.value || null }
                  setAudioPreference(next)
                  persistAudioPreference(next)
                }}
              >
                <option value="">Default voice</option>
                {audioSelection.provider?.voices.map((v) => (
                  <option key={v.id} value={v.id}>{v.label}</option>
                ))}
              </select>
            </label>
          </div>

          <button
            className={`button button--primary ${styles.hearBtn}`}
            disabled={!audioSelection.provider || audioMutation.isPending}
            onClick={() => audioMutation.mutate({ start: currentPage.start, end: currentPage.end, text: currentPage.text })}
            type="button"
          >
            {audioMutation.isPending ? 'Generating…' : '▶  Hear this page'}
          </button>

          {audioMutation.isError && (
            <p className={styles.audioError}>Failed to generate audio. Check provider settings.</p>
          )}

          <Link className={styles.audioSettingsLink} to="/settings/audio">
            More audio settings →
          </Link>
        </div>
      )}
    </div>
  )
}
