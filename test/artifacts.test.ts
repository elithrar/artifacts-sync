import { describe, expect, it } from "vitest";

import {
  artifactsPushEventSchema,
  observeArtifactsPush,
  type ArtifactsPushEvent,
} from "../src/artifacts.js";

const event: ArtifactsPushEvent = {
  type: "cf.artifacts.repo.pushed",
  source: {
    type: "artifacts.repo",
    namespace: "default",
    repoName: "example",
  },
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
    const created = observeArtifactsPush({
      ...event,
      payload: { ...event.payload, before: "0".repeat(40) },
    });
    const deleted = observeArtifactsPush({
      ...event,
      payload: { ...event.payload, after: "0".repeat(40) },
    });
    expect(created.refs[0]).toMatchObject({ before: null, after: "b".repeat(40) });
    expect(deleted.refs[0]).toMatchObject({ before: "a".repeat(40), after: null });
  });

  it("rejects the old string source and impossible zero-to-zero pushes", () => {
    expect(
      artifactsPushEventSchema.safeParse({ ...event, source: "cloudflare.artifacts" }).success,
    ).toBe(false);
    expect(() =>
      observeArtifactsPush({
        ...event,
        payload: { ...event.payload, before: "0".repeat(40), after: "0".repeat(40) },
      }),
    ).toThrow("cannot have zero before and after OIDs");
  });

  it("rejects invalid numeric evidence", () => {
    expect(() => observeArtifactsPush(event, { estimatedPatchBytes: -1 })).toThrow(
      "estimatedPatchBytes must be a non-negative safe integer",
    );
  });
});
