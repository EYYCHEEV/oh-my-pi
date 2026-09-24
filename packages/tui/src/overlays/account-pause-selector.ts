import { Container, matchesKey, ScrollView, TruncatedText } from "../index";
import { theme } from "../theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { OverlayPanel } from "../chrome/overlay-box";
import { MenuSelection } from "../components/menu-selection";
import { centeredViewportRange } from "../components/scroll-viewport";

const ACCOUNT_PAUSE_SELECTOR_MAX_VISIBLE = 10;

/** One stored OAuth account row in the `/login manage` overlay. */
export interface AccountPauseRow {
	credentialId: number;
	label: string;
	/** Pre-formatted state, e.g. `Active` or `Paused since <local time>`. */
	status: string;
	paused: boolean;
	/** True when this account serves the current session. */
	current: boolean;
}

/** Account list for `/login manage`: Enter toggles Active/Paused in place, Esc closes. */
export class AccountPauseSelectorComponent extends OverlayPanel {
	#listContainer: Container;
	#menu: MenuSelection<AccountPauseRow>;
	#onToggle: (row: AccountPauseRow) => void;
	#onCancel: () => void;

	constructor(
		providerName: string,
		rows: readonly AccountPauseRow[],
		onToggle: (row: AccountPauseRow) => void,
		onCancel: () => void,
	) {
		super(`Pause or resume ${providerName} accounts`);
		this.#onToggle = onToggle;
		this.#onCancel = onCancel;
		const current = rows.find(row => row.current);
		this.#menu = new MenuSelection<AccountPauseRow>(
			rows,
			{
				getKey: row => String(row.credentialId),
				getSearchText: row => `${row.label} ${row.status}`,
			},
			current ? String(current.credentialId) : undefined,
		);
		this.#listContainer = new Container();
		this.addChild(this.#listContainer);
		this.#updateList();
	}

	/** Replace the rows after a toggle, keeping the selected account. */
	setAccounts(rows: readonly AccountPauseRow[]): void {
		this.#menu.setItems(rows);
		this.#updateList();
	}

	#updateList(): void {
		this.#listContainer.clear();
		const items = this.#menu.visibleItems;
		const total = items.length;
		const { start, end } = centeredViewportRange(this.#menu.selectedIndex, total, ACCOUNT_PAUSE_SELECTOR_MAX_VISIBLE);
		const rows: string[] = [];
		for (let i = start; i < end; i++) {
			const row = items[i];
			if (!row) continue;
			const status = theme.fg(row.paused ? "warning" : "success", row.status);
			const currentTag = row.current ? theme.fg("muted", " (this session)") : "";
			const text = `${row.label} · ${status}${currentTag}`;
			rows.push(
				i === this.#menu.selectedIndex ? `${theme.fg("accent", `${theme.nav.cursor} `)}${text}` : `  ${text}`,
			);
		}
		if (rows.length > 0) {
			const view = new ScrollView(rows, {
				height: rows.length,
				scrollbar: "auto",
				totalRows: total,
				theme: { track: text => theme.fg("muted", text), thumb: text => theme.fg("accent", text) },
			});
			view.setScrollOffset(start);
			this.#listContainer.addChild(view);
		}
		if (total === 0) {
			this.#listContainer.addChild(new TruncatedText(theme.fg("muted", "No stored OAuth accounts"), 0, 0));
		}
		this.#listContainer.addChild(
			new TruncatedText(theme.fg("muted", "↑/↓ select · ↵ pause/resume · Esc close"), 0, 0),
		);
	}

	handleInput(keyData: string): void {
		if (matchesSelectCancel(keyData)) {
			this.#onCancel();
			return;
		}
		if (matchesSelectUp(keyData)) {
			this.#menu.move(-1, true);
			this.#updateList();
		} else if (matchesSelectDown(keyData)) {
			this.#menu.move(1, true);
			this.#updateList();
		} else if (matchesKey(keyData, "pageUp")) {
			this.#menu.move(-ACCOUNT_PAUSE_SELECTOR_MAX_VISIBLE, false);
			this.#updateList();
		} else if (matchesKey(keyData, "pageDown")) {
			this.#menu.move(ACCOUNT_PAUSE_SELECTOR_MAX_VISIBLE, false);
			this.#updateList();
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const row = this.#menu.selectedItem;
			if (row) this.#onToggle(row);
		}
	}
}
