import type { AccountPauseRow } from "@oh-my-pi/pi-tui/overlays/account-pause-selector";
import type { OAuthAccountSummary } from "../../session/auth-storage";
import { oauthAccountLabel } from "./session-pin";

/** Shown by every pause surface when the credential store is an auth broker. */
export const ACCOUNT_PAUSE_BROKER_MESSAGE =
	"OAuth account pause is not supported with an auth broker. Manage accounts on the broker host.";

/** Appended to login success output when the re-logged-in account is still paused. */
export const LOGIN_PAUSED_NOTICE = "This account is paused; resume it with /login manage.";

/** Build `/login manage` rows: `label · Active` or `label · Paused since <local time>`. */
export function toAccountPauseRows(
	accounts: readonly OAuthAccountSummary[],
	formatTime: (ms: number) => string = ms => new Date(ms).toLocaleString(),
): AccountPauseRow[] {
	return accounts.map(account => {
		const paused = account.paused === true;
		return {
			credentialId: account.credentialId,
			label: oauthAccountLabel(account),
			status: paused
				? account.pausedAtMs === undefined
					? "Paused"
					: `Paused since ${formatTime(account.pausedAtMs)}`
				: "Active",
			paused,
			current: account.active,
		};
	});
}

/**
 * Warnings after pausing `credentialId`, computed from the post-pause account
 * list: the account was serving this session, and/or no active account remains.
 */
export function pauseWarnings(
	provider: string,
	accounts: readonly OAuthAccountSummary[],
	credentialId: number,
): string[] {
	const warnings: string[] = [];
	const target = accounts.find(account => account.credentialId === credentialId);
	if (!target?.paused) return warnings;
	if (accounts.every(account => account.paused)) {
		warnings.push(`Every ${provider} account is now paused; requests fail until you resume one with /login manage.`);
	} else if (target.active) {
		warnings.push(
			`${oauthAccountLabel(target)} was serving this session; the next ${provider} request switches to another account.`,
		);
	}
	return warnings;
}
