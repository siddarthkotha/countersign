// scripts/critique/spendGuard.ts
// Per-run spend guard: caps the number of provider calls at --max-calls (default 20,
// scripts/critique/critique.config.json), and prints a per-call token estimate so a founder
// watching the terminal can see spend accruing in real time. The token estimate is always
// labeled ESTIMATE -- it is characters/4, never a provider's own token count (providers
// aren't asked to report one before the call happens).
export function tokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

export class SpendGuard {
  private used = 0;
  constructor(public readonly maxCalls: number) {}

  get remaining(): number {
    return Math.max(0, this.maxCalls - this.used);
  }

  canSpend(): boolean {
    return this.used < this.maxCalls;
  }

  /** Records one call and prints the guard's line. Throws if called past the cap -- callers
   *  must check canSpend() first; this is the backstop, not the primary gate. */
  spend(label: string, promptText: string): void {
    if (!this.canSpend()) throw new Error(`spend guard: max-calls (${this.maxCalls}) already reached, refusing "${label}"`);
    this.used += 1;
    const chars = promptText.length;
    const tokens = tokenEstimate(promptText);
    console.log(`[critique] call ${this.used}/${this.maxCalls} ${label} prompt_chars=${chars} token_estimate(ESTIMATE, chars/4)=${tokens}`);
  }
}
