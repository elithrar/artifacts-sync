import { describe, expect, it } from "vitest";

import { observeArtifactsPush, type ArtifactsPushEvent } from "../src/artifacts.js";

const event: ArtifactsPushEvent = {
  type: "cf.artifacts.repo.pushed",
  source: "cloudflare.artifacts",
  payload: {
    ref: "refs/heads/main",
    before: "a".repeat(40),
    after: "b".repeat(40),
    totalCommitsCount: 2,
    commitsTruncated: false,
  },
};

describe("observeArtifactsPush", () => {
  it("preserves explicit unknown evidence", () => {
    expect(observeArtifactsPush(event)).toEqual({
      refs: [
        {
          ref: "refs/heads/main",
          before: "a".repeat(40),
          after: "b".repeat(40),
          destination: { status: "unchecked" },
          commitCount: 2,
          estimatedPatchBytes: null,
          forced: null,
        },
      ],
      complete: true,
      sourceSizeBytes: null,
    });
  });

  it("maps zero OIDs to created and deleted ref state", () => {
    const observation = observeArtifactsPush({
      ...event,
      payload: { ...event.payload, before: "0".repeat(40), after: "0".repeat(40) },
    });
    expect(observation.refs[0]).toMatchObject({ before: null, after: null });
  });

  it("rejects invalid numeric evidence", () => {
    expect(() => observeArtifactsPush(event, { estimatedPatchBytes: -1 })).toThrow(
      "estimatedPatchBytes must be a non-negative safe integer",
    );
  });
});
