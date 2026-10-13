/** Converte Retry-After (delta-seconds ou HTTP-date) em espera limitada. */
export function parseRetryAfterMs(
  value: string | null,
  nowMs: number = Date.now(),
): number | null {
  if (!value?.trim()) return null;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  let delayMs: number;
  if (Number.isFinite(seconds) && seconds >= 0) {
    delayMs = seconds * 1000;
  } else {
    const dateMs = Date.parse(trimmed);
    if (!Number.isFinite(dateMs)) return null;
    delayMs = dateMs - nowMs;
  }
  // Evita loop em zero e não permite manter um job preso por prazo arbitrário.
  return Math.min(7 * 24 * 60 * 60 * 1000, Math.max(1000, Math.ceil(delayMs)));
}
