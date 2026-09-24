/**
 * Single owner of OAuth account auto-selection policy.
 *
 * Two operator controls decide whether a stored credential may be picked by
 * any automatic reader (ranking, round-robin, stickiness, rotation, usage
 * fan-out, reset sweeps, health):
 *
 * - **Pause**: persisted per credential row (`auth_credential_pauses`), held by
 *   each {@link CredentialPool} and passed in as `pausedIds`.
 * - **Exact-account restriction**: process-wide, set once at launch
 *   (`--oauth-account <provider>:<id>`). Module state so every `AuthStorage`
 *   in the process (subagents, web search fallback stores) honors it.
 *
 * The restriction target wins over a pause so a paused account can be probed
 * for recovery; every other row of a restricted provider is ineligible.
 */

/** Provider -> durable credential row id the process is restricted to. */
const restrictions = new Map<string, number>();

/** Restrict automatic selection for `provider` to exactly one stored credential row. */
export function setOAuthAccountRestriction(provider: string, credentialId: number): void {
	restrictions.set(provider, credentialId);
}

/** The credential row id `provider` is restricted to in this process, if any. */
export function oauthAccountRestriction(provider: string): number | undefined {
	return restrictions.get(provider);
}

/** Test seam: drop every process-wide restriction. */
export function resetOAuthAccountRestrictions(): void {
	restrictions.clear();
}

/**
 * Whether credential `credentialId` of `provider` may be picked automatically.
 * A restriction admits only its target (even when paused); otherwise a paused
 * row is excluded.
 */
export function isEligible(
	provider: string,
	credentialId: number,
	pausedIds: ReadonlySet<number> | ReadonlyMap<number, unknown>,
): boolean {
	const restricted = restrictions.get(provider);
	if (restricted !== undefined) return restricted === credentialId;
	return !pausedIds.has(credentialId);
}
