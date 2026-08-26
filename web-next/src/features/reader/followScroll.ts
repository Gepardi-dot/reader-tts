/** Critically damped follow for continuous TTS — settle in ~400ms, no ease restart. */
export const CONTINUOUS_FOLLOW_OMEGA = 10.4

export type FollowScrollSpring = {
  y: number
  v: number
}

export function stepFollowScrollSpring(
  state: FollowScrollSpring,
  target: number,
  dtSec: number,
  omega = CONTINUOUS_FOLLOW_OMEGA,
): FollowScrollSpring {
  if (!Number.isFinite(state.y) || !Number.isFinite(state.v) || !Number.isFinite(target)) {
    return { y: Number.isFinite(state.y) ? state.y : 0, v: 0 }
  }
  const dt = Math.min(0.048, Math.max(0, dtSec))
  if (dt === 0 || omega <= 0) return state
  const accel = omega * omega * (target - state.y) - 2 * omega * state.v
  const v = state.v + accel * dt
  const y = state.y + v * dt
  return { y, v }
}

export function followScrollSettled(
  state: FollowScrollSpring,
  target: number,
  posEps = 0.75,
  velEps = 14,
): boolean {
  return Math.abs(state.y - target) < posEps && Math.abs(state.v) < velEps
}
