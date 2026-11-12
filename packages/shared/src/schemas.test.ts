import { describe, it, expect } from "vitest";
import { HealthResponseSchema } from "./health.js";
import {
  LlmSettingsInputSchema,
  LlmSettingsResponseSchema,
  TestConnectionInputSchema,
  TestConnectionResultSchema,
  UpdateLlmSettingsInputSchema,
} from "./settings.js";
import {
  MaterialSummarySchema,
  MaterialChunkSchema,
  ImportMaterialResponseSchema,
} from "./materials.js";
import {
  CreateSessionInputSchema,
  SessionSchema,
  CreateSessionResponseSchema,
  MessageSchema,
  SendMessageInputSchema,
  DialogueStreamEventSchema,
} from "./dialogue.js";
import {
  ChunkLessonsResponseSchema,
  PrepareChunkResponseSchema,
  SessionMisconceptionsResponseSchema,
} from "./lessons.js";
import {
  FlashcardSchema,
  GenerateFlashcardsResponseSchema,
  UpdateFlashcardInputSchema,
  ExtractedFlashcardSchema,
  ExtractedFlashcardsSchema,
} from "./flashcards.js";

describe("SessionMisconceptionsResponseSchema", () => {
  it("accepts only structured lifecycle statuses", () => {
    expect(SessionMisconceptionsResponseSchema.parse({ sessionId: "s", records: [{ label: "误解", kpId: "k", status: "resolved" }] }).records[0]?.status).toBe("resolved");
    expect(() => SessionMisconceptionsResponseSchema.parse({ sessionId: "s", records: [{ label: "误解", kpId: "k", status: "open" }] })).toThrow();
  });
});

describe("HealthResponseSchema", () => {
  it("accepts a well-formed health response", () => {
    const parsed = HealthResponseSchema.parse({
      status: "ok",
      version: "0.1.0",
      dataDir: "/tmp/elenchi-data",
    });
    expect(parsed.status).toBe("ok");
  });

  it("rejects a status other than ok", () => {
    expect(() =>
      HealthResponseSchema.parse({
        status: "down",
        version: "0.1.0",
        dataDir: "/tmp/elenchi-data",
      }),
    ).toThrow();
  });
});

describe("LlmSettingsInputSchema", () => {
  it("accepts a valid baseUrl, apiKey, and model", () => {
    const parsed = LlmSettingsInputSchema.parse({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
    });
    expect(parsed.apiKey).toBe("sk-test");
    expect(parsed.model).toBe("gpt-4o-mini");
  });

  it("rejects an invalid baseUrl", () => {
    expect(() =>
      LlmSettingsInputSchema.parse({
        baseUrl: "not-a-url",
        apiKey: "sk-test",
        model: "gpt-4o-mini",
      }),
    ).toThrow();
  });

  it("rejects an empty apiKey", () => {
    expect(() =>
      LlmSettingsInputSchema.parse({
        baseUrl: "https://api.example.com/v1",
        apiKey: "",
        model: "gpt-4o-mini",
      }),
    ).toThrow();
  });

  it("rejects an empty model", () => {
    expect(() =>
      LlmSettingsInputSchema.parse({
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-test",
        model: "",
      }),
    ).toThrow();
  });
});

describe("UpdateLlmSettingsInputSchema", () => {
  it("accepts an update without apiKey (keep-the-stored-key semantics)", () => {
    const parsed = UpdateLlmSettingsInputSchema.parse({
      baseUrl: "https://api.example.com/v1",
      model: "gpt-4o-mini",
    });
    expect(parsed.apiKey).toBeUndefined();
  });

  it("accepts a full payload including apiKey", () => {
    const parsed = UpdateLlmSettingsInputSchema.parse({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
    });
    expect(parsed.apiKey).toBe("sk-test");
  });

  it("rejects an invalid baseUrl or an empty model", () => {
    expect(() =>
      UpdateLlmSettingsInputSchema.parse({ baseUrl: "not-a-url", model: "m" }),
    ).toThrow();
    expect(() =>
      UpdateLlmSettingsInputSchema.parse({
        baseUrl: "https://api.example.com/v1",
        model: "",
      }),
    ).toThrow();
  });
});

describe("LlmSettingsResponseSchema", () => {
  it("accepts an unconfigured response with null fields", () => {
    const parsed = LlmSettingsResponseSchema.parse({
      configured: false,
      baseUrl: null,
      apiKeyPreview: null,
      model: null,
    });
    expect(parsed.configured).toBe(false);
  });
});

describe("TestConnectionInputSchema", () => {
  it("accepts baseUrl and apiKey without requiring model", () => {
    const parsed = TestConnectionInputSchema.parse({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
    });
    expect(parsed.apiKey).toBe("sk-test");
  });
});

describe("TestConnectionResultSchema", () => {
  it("accepts a successful result", () => {
    const parsed = TestConnectionResultSchema.parse({
      ok: true,
      message: "connected",
    });
    expect(parsed.ok).toBe(true);
  });
});

describe("MaterialSummarySchema", () => {
  it("accepts a valid material summary", () => {
    const parsed = MaterialSummarySchema.parse({
      id: "m1",
      title: "第一章",
      chunkCount: 4,
      createdAt: Date.now(),
    });
    expect(parsed.chunkCount).toBe(4);
  });
});

describe("MaterialChunkSchema", () => {
  it("accepts a valid chunk", () => {
    const parsed = MaterialChunkSchema.parse({
      id: "c1",
      order: 1,
      title: "1.1 数列极限",
      level: 2,
      content: "正文内容",
    });
    expect(parsed.level).toBe(2);
  });
});

describe("ImportMaterialResponseSchema", () => {
  it("accepts a valid import response", () => {
    const parsed = ImportMaterialResponseSchema.parse({
      id: "m1",
      chunkCount: 4,
    });
    expect(parsed.id).toBe("m1");
  });
});

describe("CreateSessionInputSchema", () => {
  it("accepts a non-empty lessonId", () => {
    const parsed = CreateSessionInputSchema.parse({ lessonId: "l1" });
    expect(parsed.lessonId).toBe("l1");
  });

  it("rejects an empty lessonId", () => {
    expect(() => CreateSessionInputSchema.parse({ lessonId: "" })).toThrow();
  });
});

describe("SessionSchema", () => {
  it("accepts a valid lesson-anchored session", () => {
    const parsed = SessionSchema.parse({
      id: "s1",
      materialId: "m1",
      chunkId: "c1",
      lessonId: "l1",
      startedAt: Date.now(),
    });
    expect(parsed.id).toBe("s1");
  });

  it("accepts a legacy session with null lessonId", () => {
    const parsed = SessionSchema.parse({
      id: "s1",
      materialId: "m1",
      chunkId: "c1",
      lessonId: null,
      startedAt: Date.now(),
    });
    expect(parsed.lessonId).toBeNull();
  });
});

describe("CreateSessionResponseSchema", () => {
  it("accepts a response with an opening message", () => {
    const parsed = CreateSessionResponseSchema.parse({
      id: "s1",
      materialId: "m1",
      chunkId: "c1",
      lessonId: "l1",
      startedAt: Date.now(),
      openingMessage: {
        id: "msg1",
        sessionId: "s1",
        role: "assistant",
        content: "欢迎。上节课我们掌握了……",
        createdAt: Date.now(),
      },
    });
    expect(parsed.openingMessage?.role).toBe("assistant");
  });

  it("accepts a reuse response without an opening message", () => {
    const parsed = CreateSessionResponseSchema.parse({
      id: "s1",
      materialId: "m1",
      chunkId: "c1",
      lessonId: "l1",
      startedAt: Date.now(),
    });
    expect(parsed.openingMessage).toBeUndefined();
  });
});

describe("ChunkLessonsResponseSchema", () => {
  it("accepts a not_prepared response", () => {
    const parsed = ChunkLessonsResponseSchema.parse({ status: "not_prepared" });
    expect(parsed.lessons).toBeUndefined();
  });

  it("accepts a ready response with lessons", () => {
    const parsed = ChunkLessonsResponseSchema.parse({
      status: "ready",
      partialSections: 0,
      lessons: [
        {
          id: "l1",
          order: 1,
          title: "第 1 课 极限的引入",
          objective: "理解极限的直观定义",
          kpCount: 5,
          masteredKpCount: 2,
          status: "active",
          locked: false,
        },
      ],
    });
    expect(parsed.lessons).toHaveLength(1);
    expect(parsed.lessons![0]!.kpCount).toBe(5);
    expect(parsed.lessons![0]!.locked).toBe(false);
  });

  it("requires the locked flag on lessons", () => {
    expect(() =>
      ChunkLessonsResponseSchema.parse({
        status: "ready",
        lessons: [
          {
            id: "l1",
            order: 1,
            title: "t",
            objective: "o",
            kpCount: 1,
            masteredKpCount: 0,
            status: "active",
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts a failed response with an error", () => {
    const parsed = ChunkLessonsResponseSchema.parse({
      status: "failed",
      error: "抽取失败：LLM 未返回合法 JSON",
    });
    expect(parsed.status).toBe("failed");
  });
});

describe("PrepareChunkResponseSchema", () => {
  it("accepts a successful prep response", () => {
    const parsed = PrepareChunkResponseSchema.parse({
      status: "ready",
      kpCount: 12,
      lessonCount: 3,
      partialSections: 1,
    });
    expect(parsed.kpCount).toBe(12);
  });

  it("accepts a failed prep response", () => {
    const parsed = PrepareChunkResponseSchema.parse({
      status: "failed",
      error: "备课失败",
    });
    expect(parsed.error).toBe("备课失败");
  });
});

describe("MessageSchema", () => {
  it("accepts a valid user message", () => {
    const parsed = MessageSchema.parse({
      id: "msg1",
      sessionId: "s1",
      role: "user",
      content: "0.999... 不可能等于 1 吧",
      createdAt: Date.now(),
    });
    expect(parsed.role).toBe("user");
  });

  it("rejects an invalid role", () => {
    expect(() =>
      MessageSchema.parse({
        id: "msg1",
        sessionId: "s1",
        role: "system",
        content: "x",
        createdAt: Date.now(),
      }),
    ).toThrow();
  });
});

describe("SendMessageInputSchema", () => {
  it("rejects empty content", () => {
    expect(() => SendMessageInputSchema.parse({ content: "" })).toThrow();
  });
});

describe("DialogueStreamEventSchema", () => {
  it("accepts a delta event", () => {
    const parsed = DialogueStreamEventSchema.parse({ delta: "先别急。" });
    expect(parsed).toEqual({ delta: "先别急。" });
  });

  it("accepts a done event", () => {
    const parsed = DialogueStreamEventSchema.parse({
      done: true,
      messageId: "msg1",
      userMessageId: "msg0",
      createdAt: Date.now(),
    });
    expect("done" in parsed && parsed.done).toBe(true);
    if ("done" in parsed) {
      expect(parsed.userMessageId).toBe("msg0");
    }
  });

  it("rejects a done event missing userMessageId", () => {
    expect(() =>
      DialogueStreamEventSchema.parse({
        done: true,
        messageId: "msg1",
        createdAt: Date.now(),
      }),
    ).toThrow();
  });

  it("accepts an error event", () => {
    const parsed = DialogueStreamEventSchema.parse({ error: "连接失败" });
    expect(parsed).toEqual({ error: "连接失败" });
  });
});

describe("FlashcardSchema", () => {
  it("accepts a flashcard with options", () => {
    const parsed = FlashcardSchema.parse({
      id: "f1",
      sessionId: "s1",
      question: "0.999... 等于多少？",
      options: ["0.999...", "1", "无法确定"],
      answer: "1",
      explanation: "⅓ × 3 = 1，而 ⅓ = 0.333...，所以 0.999... = 1。",
      createdAt: Date.now(),
    });
    expect(parsed.answer).toBe("1");
  });

  it("accepts a flashcard without options or explanation", () => {
    const parsed = FlashcardSchema.parse({
      id: "f1",
      sessionId: "s1",
      question: "极限的定义是什么？",
      options: null,
      answer: "当自变量趋近某值时函数值的趋近值",
      explanation: null,
      createdAt: Date.now(),
    });
    expect(parsed.options).toBeNull();
  });
});

describe("GenerateFlashcardsResponseSchema", () => {
  it("accepts a response with an empty flashcards array", () => {
    const parsed = GenerateFlashcardsResponseSchema.parse({ flashcards: [] });
    expect(parsed.flashcards).toEqual([]);
  });
});

describe("UpdateFlashcardInputSchema", () => {
  it("accepts a partial update", () => {
    const parsed = UpdateFlashcardInputSchema.parse({ answer: "更新后的答案" });
    expect(parsed.answer).toBe("更新后的答案");
  });

  it("rejects an empty question when provided", () => {
    expect(() => UpdateFlashcardInputSchema.parse({ question: "" })).toThrow();
  });
});

describe("ExtractedFlashcardSchema", () => {
  it("accepts a minimal extracted card", () => {
    const parsed = ExtractedFlashcardSchema.parse({
      question: "q",
      answer: "a",
    });
    expect(parsed.question).toBe("q");
  });

  it("rejects a card missing an answer", () => {
    expect(() => ExtractedFlashcardSchema.parse({ question: "q" })).toThrow();
  });
});

describe("ExtractedFlashcardsSchema", () => {
  it("accepts a wrapped array of extracted cards", () => {
    const parsed = ExtractedFlashcardsSchema.parse({
      flashcards: [{ question: "q1", answer: "a1" }],
    });
    expect(parsed.flashcards).toHaveLength(1);
  });
});
