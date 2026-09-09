/**
 * Shared helpers for the work / templates audit tests (goals/security-audit.md, components 3 and 4).
 *
 * The scenario harness in scenarios/lib.ts throws on the first failed assertion. An audit test must
 * instead complete the adversarial demonstration and print every number before it fails, so the
 * invariants here are "soft": a violation is printed as a FINDING and remembered, and `finish()`
 * turns the recorded violations into a non-zero exit code (a failing test is the finding).
 */

export interface Violation {
  /** Row id in docs/SECURITY_AUDIT.md (e.g. "W-1"). */
  id: string;
  /** The invariant that did not hold, with numbers. */
  message: string;
}

const violations: Violation[] = [];

/**
 * Check one security invariant without aborting the test.
 *
 * Args:
 *   id: Audit row id the invariant belongs to.
 *   condition: The invariant; truthy means it holds.
 *   message: Human-readable statement of the invariant, with the observed numbers.
 *
 * Returns:
 *   Nothing. A violation is printed as `VIOLATED [id]` and recorded for `finish()`.
 */
export function invariant(id: string, condition: unknown, message: string): void {
  if (condition) {
    console.log(`   holds [${id}]: ${message}`);
    return;
  }
  console.log(`   VIOLATED [${id}]: ${message}`);
  violations.push({ id, message });
}

/**
 * Print the verdict block for one audit test and set the process exit code.
 *
 * Args:
 *   name: Test name for the verdict line.
 *
 * Returns:
 *   The recorded violations (empty when every invariant held). Exit code 1 is set when any invariant
 *   was violated, so `npx tsx <test>` fails exactly when it demonstrates a finding.
 */
export function finish(name: string): Violation[] {
  console.log(`\n=== AUDIT TEST ${name}: ${violations.length === 0 ? "ALL INVARIANTS HOLD" : `${violations.length} INVARIANT(S) VIOLATED`} ===`);
  for (const v of violations) console.log(`   ${v.id}: ${v.message}`);
  if (violations.length !== 0) process.exitCode = 1;
  return violations;
}
