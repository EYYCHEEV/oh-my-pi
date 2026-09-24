import type { OAuthAccountSummary } from "../../session/auth-storage";
import { formatActiveAccountLabel } from "./active-oauth-account";

import type { SessionPinAccount } from "@oh-my-pi/pi-tui/overlays/session-account-selector";

/** Stable user-facing label for one stored OAuth account (shared by `/session pin`, `/login manage`, `omp auth`). */
export function oauthAccountLabel(account: OAuthAccountSummary): string {
	return (
		(formatActiveAccountLabel(account) ?? account.enterpriseUrl?.trim()) ||
		`OAuth credential #${account.credentialId}`
	);
}

/** Add stable user-facing labels to provider account summaries. */
export function toSessionPinAccounts(accounts: readonly OAuthAccountSummary[]): SessionPinAccount[] {
	return accounts.map(account => ({ ...account, label: oauthAccountLabel(account) }));
}

/** The `/session pin` refusal for an account the operator paused. */
export function pausedPinMessage(label: string): string {
	return `${label} is paused; resume it with /login manage first.`;
}

/** Match a `/session pin` selector by 1-based position or exact account identity. */
export function matchSessionPinAccounts(accounts: readonly SessionPinAccount[], selector: string): SessionPinAccount[] {
	const wanted = selector.trim().toLowerCase();
	if (!wanted) return [];
	if (wanted === "active") return accounts.filter(account => account.active);

	if (/^\d+$/.test(wanted)) {
		const position = Number(wanted) - 1;
		const positioned = accounts.find(account => account.position === position);
		if (positioned) return [positioned];
	}

	return accounts.filter(account =>
		[
			account.label,
			account.email,
			account.accountId,
			account.projectId,
			account.enterpriseUrl,
			account.orgId,
			account.orgName,
			`OAuth credential #${account.credentialId}`,
		].some(value => value?.trim().toLowerCase() === wanted),
	);
}
