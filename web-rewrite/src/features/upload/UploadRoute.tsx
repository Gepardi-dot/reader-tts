import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { uploadBook } from '@/shared/api/client'
import styles from './UploadRoute.module.css'

export function UploadRoute() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [title, setTitle] = useState('')
  const [file, setFile] = useState<File | null>(null)

  const uploadMutation = useMutation({
    mutationFn: () => uploadBook(file!, title),
    onSuccess: async (book) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['books'] }),
        queryClient.invalidateQueries({ queryKey: ['learning-home'] }),
      ])
      navigate(`/book/${book.id}`)
    },
  })

  return (
    <section className={styles.layout}>
      <article className={`surface ${styles.panel}`}>
        <div>
          <p className="eyebrow">Upload</p>
          <h2>Bring in a PDF and let the rewrite create the reading loop around it.</h2>
        </div>

        <label className={styles.dropzone}>
          <input
            accept="application/pdf"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            type="file"
          />
          <strong>{file ? file.name : 'Choose a PDF'}</strong>
          <span>{file ? `${Math.round(file.size / 1024 / 1024)} MB selected` : 'Drag, drop, or browse.'}</span>
        </label>

        <label className="field">
          <span>Optional title override</span>
          <input className="input" onChange={(event) => setTitle(event.target.value)} value={title} />
        </label>

        <button
          className="button button--primary"
          disabled={!file || uploadMutation.isPending}
          onClick={() => uploadMutation.mutate()}
          type="button"
        >
          {uploadMutation.isPending ? 'Uploading...' : 'Upload and open'}
        </button>

        {uploadMutation.error ? <p className={styles.error}>{uploadMutation.error.message}</p> : null}
      </article>
    </section>
  )
}
