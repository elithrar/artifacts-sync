import { describe, expect, it, vi } from "vitest";

import { inspectGitHubPush, type GitHubPushPayload } from "../src/github.js";

const payload: GitHubPushPayload = {
  ref: "refs/heads/main",
  before: "a".repeat(40),
  after: "b".repeat(40),
  forced: false,
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
    const observation = await inspectGitHubPush(payload, { fetch: fetcher });
    expect(observation.truncated).toBeUndefined();
    expect(observation.refs[0]).toMatchObject({
      commitCount: 1,
      forced: false,
    });
    expect(observation.refs[0]?.estimatedBytes).toBeGreaterThan(0);
    expect(observation.sourceSizeBytes).toBe(12 * 1024);
  });

  it("marks a binary comparison as incomplete", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        total_commits: 1,
        files: [{ status: "modified", additions: 0, deletions: 0 }],
      }),
    );
    const observation = await inspectGitHubPush(payload, { fetch: fetcher });
    expect(observation.truncated).toBe(true);
    expect(observation.refs[0]?.estimatedBytes).toBeUndefined();
  });

  it("does not call compare for a deleted ref", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const observation = await inspectGitHubPush(
      { ...payload, after: "0".repeat(40), deleted: true },
      { fetch: fetcher },
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(observation.refs[0]?.after).toBeUndefined();
    expect(observation.refs[0]).toMatchObject({ commitCount: 0, estimatedBytes: 0 });
  });
});
