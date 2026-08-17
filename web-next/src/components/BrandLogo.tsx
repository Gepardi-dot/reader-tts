import higgsReadLogo from '@/assets/higgsread-logo.png'
import { cn } from '@/lib/utils'

/** A hair darker/warmer than app #F7F7F5 so the plate reads as a raised drop. */
const CANVAS_FILL = '#EEECE6'
const CANVAS_FRAME = 'rgba(120, 116, 108, 0.42)'

type BrandLogoProps = {
  className?: string
}

export function BrandLogo({ className }: BrandLogoProps) {
  return (
    <div
      className={cn('inline-flex shrink-0 select-none', className)}
      style={{
        backgroundColor: CANVAS_FILL,
        border: `1px solid ${CANVAS_FRAME}`,
        boxShadow: [
          '0 1px 2px rgba(55, 53, 47, 0.10)',
          '0 3px 8px rgba(55, 53, 47, 0.06)',
          'inset 0 1px 0 rgba(255, 255, 255, 0.72)',
          'inset 0 -1px 0 rgba(55, 53, 47, 0.06)',
        ].join(', '),
      }}
    >
      <img
        src={higgsReadLogo}
        alt="HiggsRead"
        className="block h-full w-auto max-w-full"
        draggable={false}
      />
    </div>
  )
}
