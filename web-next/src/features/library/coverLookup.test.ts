import { describe, expect, it } from 'vitest'
import { coverSearchTermsForBook } from './coverLookup'

describe('coverSearchTermsForBook', () => {
  it('splits dashed filename titles into title and author candidates', () => {
    expect(coverSearchTermsForBook('the-art-of-seduction-robert-greene')).toContainEqual({
      title: 'the art of seduction',
      author: 'Robert Greene',
    })
  })

  it('uses the original file name as a fallback search source', () => {
    expect(coverSearchTermsForBook('Untitled book', 'Storyworthy-_Matthew_Dicks[1].pdf')).toContainEqual({
      title: 'Storyworthy',
      author: 'Matthew Dicks',
    })
  })
})
