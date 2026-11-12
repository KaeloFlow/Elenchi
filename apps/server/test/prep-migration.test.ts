import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { materials, prepTasks, prepCheckpoints } from "../src/db/schema.js";

describe("durable prep migration", () => {
  it("persists checkpoints across reopen and enforces identities without deleting material", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "elenchi-prep-migration-"));
    let handle = createDb(dir, { migrate: true });
    try {
      const now = new Date();
      handle.db.insert(materials).values({ id: "m", title: "保留教材", sourcePath: "source.md", createdAt: now }).run();
      const task = { id: "t", chunkId: "c", inputHash: "h", rulesVersion: "1", status: "queued" as const, budget: JSON.stringify({ maxCalls: 20 }), createdAt: now, updatedAt: now };
      handle.db.insert(prepTasks).values(task).run();
      expect(() => handle.db.insert(prepTasks).values({ ...task, id: "duplicate" }).run()).toThrow();
      const checkpoint = { id: "cp", taskId: "t", unitKey: "section-1", inputHash: "u", payload: "{}", createdAt: now };
      handle.db.insert(prepCheckpoints).values(checkpoint).run();
      expect(() => handle.db.insert(prepCheckpoints).values({ ...checkpoint, id: "duplicate" }).run()).toThrow();
      handle.close();
      handle = createDb(dir, { migrate: true });
      expect(handle.db.select().from(prepTasks).all()).toHaveLength(1);
      expect(handle.db.select().from(prepCheckpoints).all()).toHaveLength(1);
      expect(handle.db.select().from(materials).all()[0]?.title).toBe("保留教材");
    } finally {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
