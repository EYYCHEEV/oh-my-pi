export const BOUNDED_PROCESS_SUPERVISOR_SOURCE = String.raw`
type StartMessage = {
	type: "start";
	cmd: string[];
	options: Record<string, unknown>;
};

type ControlMessage = StartMessage | { type: "hold" } | { type: "release" };

function send(message: unknown): void {
	if (typeof process.send !== "function") throw new Error("bounded process supervisor requires Bun IPC");
	process.send(message);
}

process.on("SIGTERM", () => {
	// The held sentinel must survive the graceful group signal. A final group
	// SIGKILL intentionally terminates it atomically with the remaining members.
});

const released = Promise.withResolvers<void>();
let started = false;
let targetExitCode = 0;

process.on("message", (raw: unknown) => {
	const message = raw as ControlMessage;
	if (message.type === "hold") {
		send({ type: "held" });
		return;
	}
	if (message.type === "release") {
		released.resolve();
		return;
	}
	if (message.type !== "start" || started) return;
	started = true;
	try {
		const target = Bun.spawn(message.cmd, {
			stdin: "ignore",
			...message.options,
			stdout: "inherit",
			stderr: "inherit",
			detached: false,
		});
		send({ type: "started", pid: target.pid });
		target.exited.then(
			code => {
				targetExitCode = code;
				send({ type: "target-exit", code });
			},
			error => send({ type: "target-error", message: String(error) }),
		);
	} catch (error) {
		send({ type: "target-error", message: String(error) });
	}
});

send({ type: "ready" });
await released.promise;
process.exit(targetExitCode);
`;
