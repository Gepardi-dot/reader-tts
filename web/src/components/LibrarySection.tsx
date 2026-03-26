import type { CSSProperties, ReactNode } from 'react'

type LibrarySectionProps = {
  eyebrow: string
  title: string
  description: string
  count?: number
  delay?: number
  children: ReactNode
}

export function LibrarySection({
  eyebrow,
  title,
  description,
  count,
  delay = 0,
  children,
}: LibrarySectionProps) {
  return (
    <section
      className="library-section"
      style={{ '--library-section-delay': `${delay}ms` } as CSSProperties}
    >
      <div className="library-section__header">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
        </div>
        {typeof count === 'number' ? <span className="library-section__count">{count}</span> : null}
      </div>
      <p className="library-section__description">{description}</p>
      {children}
    </section>
  )
}
