import { assertEvaluationTool, getEvaluationPolicy } from "@oh-my-pi/pi-utils/evaluation-policy";

const restricted = getEvaluationPolicy() !== undefined;
assertEvaluationTool("fixture");
let denied = false;
try {
	assertEvaluationTool("unadmitted");
} catch (error) {
	if (!(error instanceof Error) || !error.message.includes("tool is not admitted")) throw error;
	denied = true;
}
process.stdout.write(
	JSON.stringify({ restricted, denied, dotenv: process.env.COMPILED_EVALUATION_DOTENV_CANARY ?? null }),
);
