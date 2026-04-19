export function formatDate(value: string | null | undefined) {
  if (!value) {
    return 'Unknown'
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(new Date(value))
}

export function formatRelativeDate(value: string | null | undefined) {
  if (!value) {
    return 'Not yet'
  }

  const date = new Date(value)
  const hours = Math.round((date.getTime() - Date.now()) / (1000 * 60 * 60))
  if (Math.abs(hours) < 24) {
    return hours >= 0 ? `in ${hours || 1}h` : `${Math.abs(hours)}h ago`
  }
  const days = Math.round(hours / 24)
  return days >= 0 ? `in ${days}d` : `${Math.abs(days)}d ago`
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value)
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}
