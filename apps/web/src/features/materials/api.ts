import {
  QualityPrepTaskResponseSchema,
  QualityPrepTaskStatusSchema,
  QualityPrepChunkTaskSchema,
  type MaterialSummary,
  type MaterialChunkDto,
  type ImportMaterialResponse,
  type ChunkLessonsResponse,
  type PrepareChunkResponse,
  type PrepBudget,
} from "@elenchi/shared";

export async function fetchMaterials(): Promise<MaterialSummary[]> {
  const res = await fetch("/api/materials");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function uploadMaterial(
  file: File,
): Promise<ImportMaterialResponse> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/materials", { method: "POST", body: form });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body.details ?? body.error ?? `HTTP ${res.status}`);
  }
  return body;
}

export async function fetchMaterialChunks(
  materialId: string,
): Promise<MaterialChunkDto[]> {
  const res = await fetch(`/api/materials/${materialId}/chunks`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function deleteMaterial(id: string): Promise<void> {
  const res = await fetch(`/api/materials/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    throw new Error((body.error as string) ?? `HTTP ${res.status}`);
  }
}

/** Lesson list + prep status of a chapter chunk (not_prepared if never run). */
export async function fetchChunkLessons(
  chunkId: string,
): Promise<ChunkLessonsResponse> {
  const res = await fetch(`/api/chunks/${chunkId}/lessons`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    throw new Error((body.error as string) ?? `HTTP ${res.status}`);
  }
  return res.json();
}

/** Triggers (or re-runs after failure) the prep pipeline for a chunk. */
export type QualityPrepTask = ReturnType<typeof QualityPrepTaskStatusSchema.parse>;
export type QualityPrepTaskResponse = ReturnType<typeof QualityPrepTaskResponseSchema.parse>;
async function qualityJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init); const body = await res.json();
  if (!res.ok) throw new Error(body.details ?? body.error ?? `HTTP ${res.status}`);
  return body as T;
}
export async function createQualityPrep(chunkId: string, budget?: PrepBudget): Promise<QualityPrepTaskResponse> {
  return QualityPrepTaskResponseSchema.parse(await qualityJson(`/api/chunks/${chunkId}/quality-prep`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(budget ? { budget } : {}) }));
}
export async function getQualityPrepTask(taskId: string): Promise<QualityPrepTask> { return QualityPrepTaskStatusSchema.parse(await qualityJson(`/api/quality-prep/tasks/${taskId}`)); }
export async function getQualityPrepTaskForChunk(chunkId: string): Promise<QualityPrepTask | null> { return QualityPrepChunkTaskSchema.parse(await qualityJson(`/api/chunks/${chunkId}/quality-prep/task`)); }
export async function startQualityPrep(taskId: string): Promise<QualityPrepTaskResponse> { return QualityPrepTaskResponseSchema.parse(await qualityJson(`/api/quality-prep/tasks/${taskId}/start`, { method: "POST" })); }
export async function resumeQualityPrep(taskId: string): Promise<QualityPrepTaskResponse> { return QualityPrepTaskResponseSchema.parse(await qualityJson(`/api/quality-prep/tasks/${taskId}/resume`, { method: "POST" })); }
export async function cancelQualityPrep(taskId: string): Promise<QualityPrepTaskResponse> { return QualityPrepTaskResponseSchema.parse(await qualityJson(`/api/quality-prep/tasks/${taskId}/cancel`, { method: "POST" })); }

export async function prepareChunk(
  chunkId: string,
): Promise<PrepareChunkResponse> {
  const res = await fetch(`/api/chunks/${chunkId}/prepare`, {
    method: "POST",
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body.details ?? body.error ?? `HTTP ${res.status}`);
  }
  return body;
}
