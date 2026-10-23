/**
 * A bot that retains a fact must be able to edit or forget exactly that fact later, so `retain` returns
 * the ids of what it stored, in the order of the items, in both its text and its details.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { MemoryEditTool } from "@oh-my-pi/pi-coding-agent/tools/memory-edit";
import { MemoryRetainTool } from "@oh-my-pi/pi-coding-agent/tools/memory-retain";
import { closeMnemopiStates, startMnemopiState } from "./helpers/mnemopi-state";

afterEach(closeMnemopiStates);

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(part => part.text ?? "").join("\n");
}

describe("retain returns the stored ids", () => {
	it("names the id of a single memory in the text and the details", async () => {
		const { state, tools } = startMnemopiState();
		const result = await MemoryRetainTool.createIf(tools)!.execute("call-retain-id-1", {
			items: [{ content: "the staging database is called nimbus" }],
		});

		expect(result.details?.count).toBe(1);
		expect(result.details?.ids).toHaveLength(1);
		const [id] = result.details!.ids!;
		expect(textOf(result)).toContain("1 memory stored.");
		expect(textOf(result)).toContain(`id: ${id}`);
		expect((await state.recallResultsScoped("staging database")).map(memory => memory.id)).toContain(id);
	});

	it("returns one id per item, in item order, all distinct", async () => {
		const { tools } = startMnemopiState();
		const result = await MemoryRetainTool.createIf(tools)!.execute("call-retain-id-3", {
			items: [
				{ content: "alpha fact about the build cache" },
				{ content: "bravo fact about the release train" },
				{ content: "charlie fact about the pager rota" },
			],
		});

		const ids = result.details?.ids ?? [];
		expect(result.details?.count).toBe(3);
		expect(ids).toHaveLength(3);
		expect(new Set(ids).size).toBe(3);
		expect(textOf(result)).toContain("3 memories stored.");
		expect(textOf(result)).toContain(`ids: ${ids.join(", ")}`);
	});

	it("lets memory_edit forget exactly the memory the id names, and update another", async () => {
		const { state, tools } = startMnemopiState();
		const retained = await MemoryRetainTool.createIf(tools)!.execute("call-retain-id-edit", {
			items: [
				{ content: "alpha fact about the build cache" },
				{ content: "bravo fact about the release train" },
				{ content: "charlie fact about the pager rota" },
			],
		});
		const ids = retained.details!.ids!;
		const edit = MemoryEditTool.createIf(tools)!;

		const forgotten = await edit.execute("call-edit-forget", { op: "forget", id: ids[1]! });
		expect(textOf(forgotten)).toContain("deleted");
		const updated = await edit.execute("call-edit-update", {
			op: "update",
			id: ids[2]!,
			content: "charlie fact about the pager rota, now weekly",
		});
		expect(textOf(updated)).toContain("updated");

		const contents = (await state.recallResultsScoped("fact")).map(memory => memory.content);
		expect(contents).toContain("alpha fact about the build cache");
		expect(contents).not.toContain("bravo fact about the release train");
		expect(contents).toContain("charlie fact about the pager rota, now weekly");
	});

	it("returns no ids when the batch is rejected", async () => {
		const { tools } = startMnemopiState();
		await expect(
			MemoryRetainTool.createIf(tools)!.execute("call-retain-id-bad", {
				items: [{ content: "never stored", expires: "not-a-date" }],
			}),
		).rejects.toThrow("Nothing was stored");
	});
});
