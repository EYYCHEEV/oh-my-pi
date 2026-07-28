import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { PassThrough } from "node:stream";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";

class FakeStdin extends PassThrough {
	readonly fd = 0;
	readonly isTTY = true;
	isRaw = false;

	setRawMode(mode: boolean): this {
		this.isRaw = mode;
		return this;
	}
}

const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function restoreStdoutIsTty(): void {
	if (stdoutIsTtyDescriptor) {
		Object.defineProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		return;
	}
	Reflect.deleteProperty(process.stdout, "isTTY");
}

describe("ProcessTerminal stdin recovery", () => {
	let previousHeadless: boolean;
	let terminal: ProcessTerminal | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		previousHeadless = setTerminalHeadless(false);
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		vi.spyOn(process, "kill").mockReturnValue(true);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		terminal?.stop();
		terminal = undefined;
		setTerminalHeadless(previousHeadless);
		vi.restoreAllMocks();
		vi.useRealTimers();
		restoreStdoutIsTty();
	});

	it("reopens a Bun-destroyed TTY read stream and delivers the next input", () => {
		const failed = new FakeStdin();
		const replacement = new FakeStdin();
		const reopenStdin = vi.fn(() => replacement as unknown as NodeJS.ReadStream);
		const inputs: string[] = [];
		terminal = new ProcessTerminal({
			stdin: failed as unknown as NodeJS.ReadStream,
			reopenStdin,
		});
		terminal.start(
			data => inputs.push(data),
			() => {},
		);

		const interruptedRead = Object.assign(new Error("interrupted system call"), {
			code: "EINTR",
			syscall: "read",
			fd: 25,
			errno: -4,
		});
		failed.destroy();
		failed.emit("error", interruptedRead);
		replacement.write("q");
		vi.advanceTimersByTime(75);

		expect(reopenStdin).toHaveBeenCalledTimes(1);
		expect(failed.destroyed).toBe(true);
		expect(replacement.destroyed).toBe(false);
		expect(replacement.isRaw).toBe(true);
		expect(inputs).toEqual(["q"]);

		terminal.stop();
		terminal = undefined;
		expect(replacement.isRaw).toBe(false);
		expect(replacement.listenerCount("error")).toBe(0);
	});

	it("keeps an active input drain on the replacement stream", async () => {
		const failed = new FakeStdin();
		const replacement = new FakeStdin();
		terminal = new ProcessTerminal({
			stdin: failed as unknown as NodeJS.ReadStream,
			reopenStdin: () => replacement as unknown as NodeJS.ReadStream,
		});
		terminal.start(
			() => {},
			() => {},
		);

		let settled = false;
		const drain = terminal.drainInput(200, 50).then(() => {
			settled = true;
		});
		const interruptedRead = Object.assign(new Error("interrupted system call"), {
			code: "EINTR",
			syscall: "read",
		});
		failed.destroy();
		failed.emit("error", interruptedRead);

		vi.advanceTimersByTime(40);
		replacement.write("x");
		vi.advanceTimersByTime(10);
		await Promise.resolve();
		expect(settled).toBe(false);

		vi.advanceTimersByTime(40);
		replacement.write("y");
		vi.advanceTimersByTime(10);
		await Promise.resolve();
		expect(settled).toBe(false);

		vi.advanceTimersByTime(50);
		await Promise.resolve();
		await drain;
		expect(settled).toBe(true);
	});

	it("keeps unrelated stdin errors fatal", () => {
		const stdin = new FakeStdin();
		const reopenStdin = vi.fn(() => new FakeStdin() as unknown as NodeJS.ReadStream);
		terminal = new ProcessTerminal({
			stdin: stdin as unknown as NodeJS.ReadStream,
			reopenStdin,
		});
		terminal.start(
			() => {},
			() => {},
		);
		const failure = Object.assign(new Error("device failure"), { code: "EIO", syscall: "read" });

		expect(() => stdin.emit("error", failure)).toThrow(failure);
		expect(reopenStdin).not.toHaveBeenCalled();
	});
});
