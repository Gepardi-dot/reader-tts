import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  BookOpen,
  Minus,
  Plus,
  Rows3,
} from 'lucide-react'
import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'
import type { BookAppearance } from './bookSettings'
import { READER_THEMES } from './readerTheme'

export function AppearanceContent({
  appearance,
  onChange,
  colorMode = 'theme',
}: {
  appearance: BookAppearance
  onChange: (patch: Partial<BookAppearance>) => void
  colorMode?: 'theme' | 'chrome'
}) {
  const colors = READER_THEMES[appearance.theme]

  return (
    <div
      className="px-3.5 pt-2.5 space-y-3"
      style={{
        color: colorMode === 'theme' ? colors.text : undefined,
        paddingBottom: 16,
      }}
    >

      {/* Font */}
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-widest opacity-40 mb-1">Font</p>
        <div className="flex gap-1.5">
          {(['serif', 'sans'] as const).map((f) => (
            <button key={f} onClick={() => onChange({ font: f })}
              className={cn('flex-1 py-2 rounded-lg border text-sm font-medium transition-all',
                appearance.font === f ? 'border-primary bg-primary text-white shadow-sm' : 'border-border/60 opacity-55 hover:opacity-90')}
              style={{ fontFamily: f === 'serif' ? 'Lora, Georgia, serif' : 'Inter, sans-serif' }}>
              {f === 'serif' ? 'Serif' : 'Sans'}
            </button>
          ))}
          <button
            onClick={() => onChange({ bionic: !appearance.bionic })}
            title="Bionic Reading — bold initial letters for faster reading"
            style={{
              flexShrink: 0,
              padding: '7px 15px',
              borderRadius: 12,
              fontSize: 13.5,
              fontFamily: 'Inter, sans-serif',
              cursor: 'pointer',
              outline: 'none',
              background: appearance.bionic ? '#2563eb' : '#ffffff',
              border: '1px solid rgba(0,0,0,0.08)',
              boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
            }}>
            <b style={{ fontWeight: 900, color: appearance.bionic ? '#ffffff' : '#080808' }}>B</b>
            <span style={{ color: appearance.bionic ? 'rgba(255,255,255,0.7)' : '#989695' }}>R</span>
          </button>
        </div>
      </div>

      {/* Font size */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <p className="text-[10px] font-semibold uppercase tracking-widest opacity-40">Size</p>
          <span className="text-[11px] opacity-40 tabular-nums">{appearance.fontSize}px</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => onChange({ fontSize: Math.max(14, appearance.fontSize - 1) })}
            disabled={appearance.fontSize <= 14}
            className="p-1 rounded-lg border border-border/60 opacity-55 hover:opacity-90 disabled:opacity-20">
            <Minus size={13} />
          </button>
          <Slider value={[appearance.fontSize]} min={14} max={22} step={1}
            onValueChange={(val) => onChange({ fontSize: Array.isArray(val) ? val[0] : (val as number) })}
            className="flex-1" />
          <button onClick={() => onChange({ fontSize: Math.min(22, appearance.fontSize + 1) })}
            disabled={appearance.fontSize >= 22}
            className="p-1 rounded-lg border border-border/60 opacity-55 hover:opacity-90 disabled:opacity-20">
            <Plus size={13} />
          </button>
        </div>
      </div>

      {/* Line spacing */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <p className="text-[10px] font-semibold uppercase tracking-widest opacity-40">Spacing</p>
          <span className="text-[11px] opacity-40 tabular-nums">{appearance.lineHeight.toFixed(1)}×</span>
        </div>
        <Slider value={[Math.round(appearance.lineHeight * 10)]} min={15} max={22} step={1}
          onValueChange={(val) => onChange({ lineHeight: (Array.isArray(val) ? val[0] : (val as number)) / 10 })} />
      </div>

      {/* Width */}
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-widest opacity-40 mb-1">Width</p>
        <div className="flex gap-1.5">
          {(['narrow', 'balanced', 'wide'] as const).map((w) => (
            <button key={w} onClick={() => onChange({ width: w })}
              className={cn('flex-1 py-2 rounded-lg border text-xs font-medium capitalize transition-all',
                appearance.width === w ? 'border-primary bg-primary text-white shadow-sm' : 'border-border/60 opacity-55 hover:opacity-90')}>
              {w}
            </button>
          ))}
        </div>
      </div>

      {/* Layout: continuous scroll vs paginated page-turn */}
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-widest opacity-40 mb-1">Layout</p>
        <div className="flex gap-1.5">
          {([
            { id: 'continuous' as const, label: 'Continuous', Icon: Rows3 },
            { id: 'paginated' as const, label: 'Paginated', Icon: BookOpen },
          ]).map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => onChange({ layout: id })}
              className={cn(
                'flex-1 py-2 rounded-lg border text-xs font-medium transition-all flex items-center justify-center gap-1.5',
                appearance.layout === id
                  ? 'border-primary bg-primary text-white shadow-sm'
                  : 'border-border/60 opacity-55 hover:opacity-90',
              )}
            >
              <Icon size={13} />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Align + Theme on same row */}
      <div className="flex gap-3 pb-1">
        <div className="flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-widest opacity-40 mb-1">Align</p>
          <div className="flex gap-1">
            {([
              { id: 'left' as const,    Icon: AlignLeft    },
              { id: 'center' as const,  Icon: AlignCenter  },
              { id: 'justify' as const, Icon: AlignJustify },
            ]).map(({ id, Icon }) => (
              <button key={id} onClick={() => onChange({ align: id })}
                className={cn('flex-1 py-2 rounded-lg border flex items-center justify-center transition-all',
                  appearance.align === id ? 'border-primary bg-primary text-white shadow-sm' : 'border-border/60 opacity-55 hover:opacity-90')}>
                <Icon size={14} />
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-widest opacity-40 mb-1">Theme</p>
          <div className="flex gap-1">
            {([
              { id: 'paper' as const, bg: '#fbf8f4', fg: '#1c1c1e', title: 'Cream' },
              { id: 'white' as const, bg: '#eee2c6', fg: '#1f1a14', title: 'Paper' },
              { id: 'dark'  as const, bg: '#1a1a18', fg: '#e8e6e1', title: 'Dark' },
            ]).map(({ id, bg, fg, title }) => (
              <button key={id} onClick={() => onChange({ theme: id })}
                className={cn(
                  'flex-1 py-2 rounded-lg border text-xs font-medium transition-all',
                  id === 'white' && 'reader-theme-kindle',
                  appearance.theme === id ? 'ring-2 ring-primary ring-offset-1' : 'hover:opacity-80',
                )}
                style={{ backgroundColor: bg, color: fg, borderColor: `${fg}22` }}
                title={title}>
                <span className="flex flex-col items-center gap-0.5 leading-none">
                  <span style={{ fontFamily: 'Lora, serif', fontSize: 13 }}>Aa</span>
                  <span className="text-[9px] font-medium tracking-wide opacity-70">{title}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
