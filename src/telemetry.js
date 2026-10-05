import { z } from 'zod';

// Monetary values never enter this module. Lap times are converted to integer
// microseconds so equality and minimum selection also avoid binary float drift.
const decimal = /^-?\d{1,5}(?:\.\d{1,6})?$/;
export function secondsToMicros(value) {
  const text = String(value);
  if (!decimal.test(text)) throw new Error('invalid_seconds_precision');
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace(/^-/, '').split('.');
  const result = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  return negative ? -result : result;
}
export function microsToSeconds(micros) {
  return `${micros / 1_000_000n}.${String(micros % 1_000_000n).padStart(6, '0')}`;
}
const seconds = z.union([z.number(), z.string()]).refine(value => {
  try { const us = secondsToMicros(value); return us >= -86_400_000_000n && us <= 86_400_000_000n; }
  catch { return false; }
}, 'lap_time_seconds must be finite, <=86400 in magnitude, and have <=6 decimal places');
const lap = z.discriminatedUnion('is_clean', [
  z.object({ is_clean: z.literal(true), lap_time_seconds: seconds }).strict(),
  // A dirty lap contributes nothing. Its absent/malformed time cannot suppress
  // a driver's other valid clean laps or force the whole event to be rejected.
  z.object({ is_clean: z.literal(false), lap_time_seconds: z.unknown().optional() }).strict()
]);
const driver = z.object({
  user_id: z.uuid(),
  laps: z.array(lap).max(10000)
}).strict();
export const Telemetry = z.object({
  event_id: z.uuid(),
  challenge_id: z.uuid(),
  session_id: z.uuid(),
  challenger_id: z.uuid(),
  opponent_id: z.uuid(),
  final: z.literal(true),
  race_status: z.enum(['completed', 'network_drop']),
  drivers: z.array(driver).length(2)
}).strict().superRefine((value, ctx) => {
  if (value.challenger_id === value.opponent_id ||
    new Set(value.drivers.map(d => d.user_id)).size !== 2 ||
    !value.drivers.some(d => d.user_id === value.challenger_id) ||
    !value.drivers.some(d => d.user_id === value.opponent_id)) {
    ctx.addIssue({ code: 'custom', message: 'drivers must match the two distinct competitors' });
  }
});
export function bestCleanLap(laps) {
  let best = null;
  for (const lap of laps) {
    // Dirty, negative and zero-time laps NEVER contribute to an outcome.
    if (!lap.is_clean) continue;
    const time = secondsToMicros(lap.lap_time_seconds);
    if (time <= 0n) continue;
    if (best === null || time < best) best = time;
  }
  return best;
}
export function decide(payload) {
  const challenger = bestCleanLap(payload.drivers.find(d => d.user_id === payload.challenger_id).laps);
  const opponent = bestCleanLap(payload.drivers.find(d => d.user_id === payload.opponent_id).laps);
  const summary = {
    challengerBest: challenger === null ? null : microsToSeconds(challenger),
    opponentBest: opponent === null ? null : microsToSeconds(opponent),
    winnerId: null
  };
  if (payload.race_status === 'network_drop') return { ...summary, resolution: 'network_drop' };
  if (challenger === null && opponent === null) return { ...summary, resolution: 'no_clean_laps' };
  if (challenger !== null && challenger === opponent) return { ...summary, resolution: 'tie' };
  return { ...summary, resolution: 'winner',
    winnerId: opponent === null || (challenger !== null && challenger < opponent)
      ? payload.challenger_id : payload.opponent_id };
}
