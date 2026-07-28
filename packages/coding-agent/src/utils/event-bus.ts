import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "@oh-my-pi/pi-utils";

export class EventBus {
	readonly #listeners = new Map<string, Set<(data: unknown) => void>>();
	readonly #subscriptionOwner = new AsyncLocalStorage<object>();
	readonly #ownedSubscriptions = new WeakMap<object, Set<() => void>>();
	readonly #disposedSubscriptionOwners = new WeakSet<object>();

	emit(channel: string, data: unknown): void {
		const handlers = this.#listeners.get(channel);
		if (handlers) {
			for (const handler of handlers) {
				handler(data);
			}
		}
	}

	on(channel: string, handler: (data: unknown) => void): () => void {
		if (!this.#listeners.has(channel)) {
			this.#listeners.set(channel, new Set());
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
		const dispose = (): void => {
			if (!active) return;
			active = false;
			this.#listeners.get(channel)?.delete(safeHandler);
			if (owner) this.#ownedSubscriptions.get(owner)?.delete(dispose);
		};
		this.#listeners.get(channel)!.add(safeHandler);
		if (owner) {
			let subscriptions = this.#ownedSubscriptions.get(owner);
			if (!subscriptions) {
				subscriptions = new Set();
				this.#ownedSubscriptions.set(owner, subscriptions);
			}
			subscriptions.add(dispose);
		}
		return dispose;
	}

	async runWithSubscriptionOwner<T>(owner: object, callback: () => T | Promise<T>): Promise<T> {
		return await this.#subscriptionOwner.run(owner, callback);
	}

	disposeSubscriptions(owner: object): void {
		this.#disposedSubscriptionOwners.add(owner);
		for (const dispose of this.#ownedSubscriptions.get(owner) ?? []) dispose();
		this.#ownedSubscriptions.delete(owner);
	}

	clear(): void {
		this.#listeners.clear();
	}
}
