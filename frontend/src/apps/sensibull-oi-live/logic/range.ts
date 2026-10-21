// Sensibull sends ATM ± R strikes ("ATM strike selection"); Dhan sends the whole chain. Cut the live snapshot to the
// same shape so the window list, the default selection and the strike blocks behave like the paste version.
import type { SbSnapshot } from '../../sensibull-oi/logic/sensibull';

/** R strikes below ATM, the ATM strike and R strikes above (fewer near the edge of the chain). */
export function limitRange(snap: SbSnapshot, r: number): SbSnapshot {
  const atm = snap.strikes.findIndex((s) => s.strike === snap.atmStrike);
  if (atm < 0) return snap;
  return { ...snap, strikes: snap.strikes.slice(Math.max(0, atm - r), atm + r + 1) };
}
