import { supabase } from './supabase'

type SupabaseAuthResult<T> = Awaited<T>

let authQueue: Promise<unknown> = Promise.resolve()

function wait(ms: number) {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms)
  })
}

export function isSupabaseAuthLockError(error: unknown) {
  return (
    error instanceof Error &&
    /lock:sb-.*-auth-token|another request stole it|navigator.*lock/i.test(error.message)
  )
}

async function runQueuedAuth<T>(operation: () => Promise<T>): Promise<T> {
  const run = authQueue.then(operation, operation)
  authQueue = run.catch(() => undefined)
  return run
}

async function withLockRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await runQueuedAuth(operation)
    } catch (error) {
      lastError = error
      if (!isSupabaseAuthLockError(error) || attempt === 3) {
        throw error
      }
      await wait(80 * (attempt + 1))
    }
  }
  throw lastError
}

export function getAuthSession() {
  return withLockRetry(() => supabase.auth.getSession())
}

export function refreshAuthSession() {
  return withLockRetry(() => supabase.auth.refreshSession())
}

export type AuthSessionResult = SupabaseAuthResult<ReturnType<typeof getAuthSession>>
