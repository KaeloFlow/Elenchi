import { describe, it, expect } from "vitest";
import { transcriptMarkdownUrl } from "./api.js";

describe("transcriptMarkdownUrl", () => {
  it("builds the relative export endpoint URL for a session", () => {
    expect(transcriptMarkdownUrl("s1")).toBe("/api/sessions/s1/export.md");
  });
});
