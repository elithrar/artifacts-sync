import { describe, expect, it, vi } from "vitest";

import { inspectGitHubPush } from "../src/github.js";
import type { GitHubPushPayload } from "../src/schemas.js";

const payload: GitHubPushPayload = {
  ref: "refs/heads/main",
  before: "a".repeat(40),
  after: "b".repeat(40),
  forced: false,
  created: false,
  deleted: false,
  commits: [{ id: "b".repeat(40) }],
  repository: { full_name: "elithrar/example", size: 12 },
};

describe("inspectGitHubPush", () => {
  it("estimates a complete textual patch", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        total_commits: 1,
        files: [
          {
            status: "modified",
            additions: 1,
            deletions: 1,
            patch: "@@ -1 +1 @@\n-old\n+new",
          },
        ],
      }),
    );
    const observation = await inspectGitHubPush(payload, { fetch: fetcher, token: "secret" });

    expect(observation.complete).toBe(true);
    expect(observation.refs[0]).toMatchObject({
      before: payload.before,
      after: payload.after,
      destination: { status: "unchecked" },
      commitCount: 1,
      forced: false,
    });
    expect(observation.refs[0]?.estimatedPatchBytes).toBeGreaterThan(0);
    expect(observation.sourceSizeBytes).toBe(12 * 1024);
    const requestHeaders = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(requestHeaders.get("authorization")).toBe("Bearer secret");
  });

  it("marks a comparison without complete patches as incomplete", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        total_commits: 1,
        files: [{ status: "modified", additions: 0, deletions: 0 }],
      }),
    );
    const observation = await inspectGitHubPush(payload, { fetch: fetcher });

    expect(observation.complete).toBe(false);
    expect(observation.refs[0]?.estimatedPatchBytes).toBeNull();
  });

  it("bounds the streamed response even without Content-Length", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("12345"));
    const observation = await inspectGitHubPush(payload, {
      fetch: fetcher,
      maxResponseBytes: 4,
    });

    expect(observation.complete).toBe(false);
    expect(observation.refs[0]?.estimatedPatchBytes).toBeNull();
  });

  it("does not call compare for a deleted ref", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const observation = await inspectGitHubPush(
      { ...payload, after: "0".repeat(40), deleted: true },
      { fetch: fetcher },
    );

    expect(fetcher).not.toHaveBeenCalled();
    expect(observation.complete).toBe(true);
    expect(observation.refs[0]).toMatchObject({
      after: null,
      commitCount: 0,
      estimatedPatchBytes: 0,
    });
  });

  it("rejects malformed compare responses", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ total_commits: "one", files: [] }));
    await expect(inspectGitHubPush(payload, { fetch: fetcher })).rejects.toThrow();
  });

  it("validates its response byte limit", async () => {
    await expect(inspectGitHubPush(payload, { maxResponseBytes: 0 })).rejects.toThrow(
      "maxResponseBytes must be a positive safe integer",
    );
  });

  it("rejects push flags that disagree with the before and after OIDs", async () => {
    await expect(inspectGitHubPush({ ...payload, created: true })).rejects.toThrow(
      "created must match the before OID",
    );
    await expect(inspectGitHubPush({ ...payload, deleted: true })).rejects.toThrow(
      "deleted must match the after OID",
    );
  });
});
