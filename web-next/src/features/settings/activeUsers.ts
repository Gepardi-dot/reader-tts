export const ACTIVE_USERS_FLOOR = 13

/** Floor of 13, then +1 for each real account after the snapshot baseline. */
export function displayedActiveUsers(
  realCount: number,
  baseline: number,
  floor = ACTIVE_USERS_FLOOR,
): number {
  const real = Number.isFinite(realCount) ? Math.max(0, Math.floor(realCount)) : 0
  const base = Number.isFinite(baseline) ? Math.max(0, Math.floor(baseline)) : real
  return floor + Math.max(0, real - base)
}
