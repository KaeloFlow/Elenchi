import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchMaterials,
  uploadMaterial,
  fetchMaterialChunks,
  deleteMaterial,
  fetchChunkLessons,
  prepareChunk,
  createQualityPrep,
  getQualityPrepTask,
  startQualityPrep,
  resumeQualityPrep,
  cancelQualityPrep,
} from "./api.js";

describe("materials api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchMaterials returns the parsed list on success", async () => {
    const body = [{ id: "m1", title: "第一章", chunkCount: 2, createdAt: 1 }];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => body }),
    );

    const result = await fetchMaterials();

    expect(result).toEqual(body);
    expect(fetch).toHaveBeenCalledWith("/api/materials");
  });

  it("fetchMaterials throws on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );

    await expect(fetchMaterials()).rejects.toThrow("HTTP 500");
  });

  it("uploadMaterial posts multipart form data and returns the body", async () => {
    const body = { id: "m1", chunkCount: 4 };
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal("fetch", fetchMock);

    const file = new File(["# t"], "test.md", { type: "text/markdown" });
    const result = await uploadMaterial(file);

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/materials",
      expect.objectContaining({ method: "POST" }),
    );
    const sentForm = fetchMock.mock.calls[0][1].body as FormData;
    expect(sentForm.get("file")).toBe(file);
  });

  it("uploadMaterial throws the backend error detail on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: "invalid", details: "仅支持 .md 文件" }),
      }),
    );

    const file = new File(["x"], "test.txt");
    await expect(uploadMaterial(file)).rejects.toThrow("仅支持 .md 文件");
  });

  it("fetchMaterialChunks returns chunks for a material id", async () => {
    const body = [
      { id: "c1", order: 1, title: "第一章", level: 1, content: "正文" },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchMaterialChunks("m1");

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/materials/m1/chunks");
  });

  it("deleteMaterial sends DELETE and resolves on 204", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteMaterial("m1")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/materials/m1", {
      method: "DELETE",
    });
  });

  it("deleteMaterial throws the backend error on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: "material_not_found" }),
      }),
    );

    await expect(deleteMaterial("m1")).rejects.toThrow("material_not_found");
  });

  it("fetchChunkLessons GETs the lessons endpoint and returns the status body", async () => {
    const body = {
      status: "ready",
      lessons: [
        {
          id: "l1",
          order: 1,
          title: "第 1 课",
          objective: "目标",
          kpCount: 5,
          masteredKpCount: 2,
          status: "active",
        },
      ],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchChunkLessons("c1");

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/chunks/c1/lessons");
  });

  it("prepareChunk POSTs to the prepare endpoint and returns the result", async () => {
    const body = { status: "ready", kpCount: 5, lessonCount: 1, partialSections: 0 };
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal("fetch", fetchMock);

    const result = await prepareChunk("c1");

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/chunks/c1/prepare", {
      method: "POST",
    });
  });

  it("prepareChunk throws the backend error detail on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => ({ error: "prep_failed", details: "抽取失败" }),
      }),
    );

    await expect(prepareChunk("c1")).rejects.toThrow("抽取失败");
  });
});
