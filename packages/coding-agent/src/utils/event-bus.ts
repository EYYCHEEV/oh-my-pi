import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "@oh-my-pi/pi-utils";

/**
 * Methods are bound arrow fields: upstream Pi's `createEventBus()` returns
 * closures, so extensions (e.g. `pi-gemini-acp`) detach `pi.events.on` and
 * `pi.events.emit` and call them without a receiver.
 */
export class EventBus {
	readonly #listeners = new Map<string, Set<(data: unknown) => void>>();
	readonly #subscriptionOwner = new AsyncLocalStorage<object>();
	readonly #ownedSubscriptions = new WeakMap<object, Set<() => void>>();
	readonly #disposedSubscriptionOwners = new WeakSet<object>();
	readonly #presenceWatchers = new Map<string, Set<(present: boolean) => void>>();

	#notifyPresence(channel: string, present: boolean): void {
		const watchers = this.#presenceWatchers.get(channel);
		if (!watchers) return;
		for (const watcher of watchers) {
			try {
				watcher(present);
			} catch (err) {
				logger.error("Event listener presence watcher error", { channel, error: String(err) });
			}
		}
	}

	emit = (channel: string, data: unknown): void => {
		const handlers = this.#listeners.get(channel);
		if (handlers) {
			for (const handler of handlers) {
				handler(data);
			}
		}
	};

	on = (channel: string, handler: (data: unknown) => void): (() => void) => {
		let handlers = this.#listeners.get(channel);
		if (!handlers) {
			handlers = new Set();
			this.#listeners.set(channel, handlers);
		}
		const owner = this.#subscriptionOwner.getStore();
		const safeHandler = async (data: unknown) => {
			try {
				if (owner) await this.#subscriptionOwner.run(owner, () => handler(data));
				else await handler(data);
			} catch (err) {
				logger.error("Event handler error", { channel, error: String(err) });
			}
		};
		if (owner && this.#disposedSubscriptionOwners.has(owner)) return () => {};
		let active = true;
		const dispose = (): boolean => {
			if (!active) return false;
			active = false;
			const current = this.#listeners.get(channel);
			const removed = current?.delete(safeHandler) === true;
			if (removed && current?.size === 0) this.#notifyPresence(channel, false);
			if (owner) this.#ownedSubscriptions.get(owner)?.delete(dispose);
			return removed;
		};
		handlers.add(safeHandler);
		if (handlers.size === 1) this.#notifyPresence(channel, true);
		if (owner) {
			let subscriptions = this.#ownedSubscriptions.get(owner);
			if (!subscriptions) {
				subscriptions = new Set();
				this.#ownedSubscriptions.set(owner, subscriptions);
			}
			subscriptions.add(dispose);
		}
		return dispose;
	};

	runWithSubscriptionOwner = async <T>(owner: object, callback: () => T | Promise<T>): Promise<T> => {
		return await this.#subscriptionOwner.run(owner, callback);
	};

	disposeSubscriptions = (owner: object): void => {
		this.#disposedSubscriptionOwners.add(owner);
		for (const dispose of this.#ownedSubscriptions.get(owner) ?? []) dispose();
		this.#ownedSubscriptions.delete(owner);
	};

	/** Whether `channel` has at least one listener. */
	hasListeners = (channel: string): boolean => (this.#listeners.get(channel)?.size ?? 0) > 0;

	/**
	 * Calls `onChange` whenever `channel` gains its first listener (`true`) or loses its last
	 * (`false`), so a forwarding emitter on another thread can drop frames nobody reads.
	 * Returns the unsubscribe.
	 */
	watchListeners = (channel: string, onChange: (present: boolean) => void): (() => void) => {
		let watchers = this.#presenceWatchers.get(channel);
		if (!watchers) {
			watchers = new Set();
			this.#presenceWatchers.set(channel, watchers);
		}
		watchers.add(onChange);
		return () => {
			const current = this.#presenceWatchers.get(channel);
			current?.delete(onChange);
			if (current?.size === 0) this.#presenceWatchers.delete(channel);
		};
	};

	clear = (): void => {
		const channels = Array.from(this.#listeners.keys()).filter(channel => this.hasListeners(channel));
		this.#listeners.clear();
		for (const channel of channels) this.#notifyPresence(channel, false);
	};
}

/**
 * Publishes a subagent frame on the session bus and the observability bus.
 * SDK embedders may pass the same EventBus for both slots; the identity check
 * skips the aliased re-emit so listeners never see duplicate frames.
 */
export function emitSubagentFrame(
	eventBus: EventBus | undefined,
	subagentEventBus: EventBus | undefined,
	channel: string,
	payload: unknown,
): void {
	eventBus?.emit(channel, payload);
	if (subagentEventBus && subagentEventBus !== eventBus) {
		subagentEventBus.emit(channel, payload);
	}
}
