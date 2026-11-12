import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { sql } from "drizzle-orm";
import { createDb, type DbHandle } from "../src/db/client.js";
import {
  insertFlashcards,
  listFlashcards,
  getFlashcard,
  updateFlashcard,
  deleteFlashcard,
  deleteFlashcardsForSessions,
} from "../src/flashcards/store.js";

describe("flashcards store", () => {
  let tmpDir: string;
  let handle: DbHandle;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "elenchi-flashcards-"));
    handle = createDb(tmpDir);
    handle.db.run(sql`
      CREATE TABLE flashcards (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        question TEXT NOT NULL,
        options TEXT,
        answer TEXT NOT NULL,
        explanation TEXT,
        created_at INTEGER NOT NULL
      );
    `);
  });

  afterEach(() => {
    handle.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("inserts extracted flashcards and round-trips options as a real array", () => {
    const saved = insertFlashcards(handle.db, "s1", [
      {
        question: "0.999... 等于多少？",
        options: ["0.999...", "1"],
        answer: "1",
        explanation: "⅓ × 3 = 1",
      },
    ]);

    expect(saved).toHaveLength(1);
    expect(saved[0].options).toEqual(["0.999...", "1"]);

    const fetched = getFlashcard(handle.db, saved[0].id);
    expect(fetched?.options).toEqual(["0.999...", "1"]);
  });

  it("stores null options and explanation as null, not the string 'null'", () => {
    const saved = insertFlashcards(handle.db, "s1", [
      { question: "极限是什么？", answer: "趋近值" },
    ]);

    expect(saved[0].options).toBeNull();
    expect(saved[0].explanation).toBeNull();
  });

  it("lists flashcards for a session in creation order", () => {
    insertFlashcards(handle.db, "s1", [
      { question: "q1", answer: "a1" },
      { question: "q2", answer: "a2" },
    ]);

    const list = listFlashcards(handle.db, "s1");
    expect(list).toHaveLength(2);
    expect(list[0].question).toBe("q1");
    expect(list[1].question).toBe("q2");
  });

  it("does not return flashcards belonging to a different session", () => {
    insertFlashcards(handle.db, "s1", [{ question: "q1", answer: "a1" }]);
    insertFlashcards(handle.db, "s2", [{ question: "q2", answer: "a2" }]);

    expect(listFlashcards(handle.db, "s1")).toHaveLength(1);
    expect(listFlashcards(handle.db, "s2")).toHaveLength(1);
  });

  it("updates a flashcard's fields and preserves unspecified ones", () => {
    const [card] = insertFlashcards(handle.db, "s1", [
      { question: "q1", answer: "a1", explanation: "e1" },
    ]);

    const updated = updateFlashcard(handle.db, card.id, { answer: "a1-fixed" });

    expect(updated?.answer).toBe("a1-fixed");
    expect(updated?.question).toBe("q1");
    expect(updated?.explanation).toBe("e1");
  });

  it("updateFlashcard returns undefined for an unknown id", () => {
    expect(updateFlashcard(handle.db, "does-not-exist", { answer: "x" })).toBeUndefined();
  });

  it("deletes a flashcard and reports success/failure correctly", () => {
    const [card] = insertFlashcards(handle.db, "s1", [
      { question: "q1", answer: "a1" },
    ]);

    expect(deleteFlashcard(handle.db, card.id)).toBe(true);
    expect(getFlashcard(handle.db, card.id)).toBeUndefined();
    expect(deleteFlashcard(handle.db, card.id)).toBe(false);
  });

  it("deletes flashcards for the given sessions and leaves others intact", () => {
    insertFlashcards(handle.db, "s1", [{ question: "q1", answer: "a1" }]);
    insertFlashcards(handle.db, "s2", [{ question: "q2", answer: "a2" }]);

    handle.db.transaction((tx) => deleteFlashcardsForSessions(tx, ["s1"]));

    expect(listFlashcards(handle.db, "s1")).toHaveLength(0);
    expect(listFlashcards(handle.db, "s2")).toHaveLength(1);
  });
});
