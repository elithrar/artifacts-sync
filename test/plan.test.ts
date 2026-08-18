import { describe, expect, it } from "vitest";

import { planSync } from "../src/plan.js";
import type { ChangeObservation, RefChange } from "../src/types.js";

const smallRef: RefChange = {
  ref: "refs/heads/main",
  before: "a".repeat(40),
  after: "b".repeat(40),
  destination: { status: "present", oid: "a".repeat(40) },
  commitCount: 2,
  estimatedPatchBytes: 1024,
  forced: false,
};

const smallChange: ChangeObservation = {
  refs: [smallRef],
  complete: true,
  sourceSizeBytes: 1024,
};

describe("planSync", () => {
  it("uses a warm Workspace for a bounded fast-forward change", () => {
    const plan = planSync({
      change: smallChange,
      mode: "push",
      strategy: "auto",
      cacheWarm: true,
    });

    expect(plan.strategy).toBe("workspace");
    expect(plan.estimate).toMatchObject({ refs: 1, commits: 2, patchBytes: 1024 });
  });

  it("allows a cold Workspace only when the whole source is small", () => {
    expect(
      planSync({
        change: smallChange,
        mode: "push",
        strategy: "auto",
        cacheWarm: false,
      }).strategy,
    ).toBe("workspace");

    expect(
      planSync({
        change: { ...smallChange, sourceSizeBytes: 32 * 1024 * 1024 },
        mode: "push",
        strategy: "auto",
        cacheWarm: false,
      }).strategy,
    ).toBe("container");
  });

  it("routes incomplete or unsafe evidence to the container", () => {
    const changes: ChangeObservation[] = [
      { ...smallChange, refs: [{ ...smallRef, estimatedPatchBytes: null }] },
      { ...smallChange, refs: [{ ...smallRef, forced: true }] },
      { ...smallChange, complete: false },
    ];
    for (const change of changes) {
      const plan = planSync({
        change,
        mode: "push",
        strategy: "auto",
        cacheWarm: true,
      });
      expect(plan.strategy).toBe("container");
    }
  });

  it("always uses native Git for a mirror", () => {
    const plan = planSync({
      mode: "mirror",
      strategy: "auto",
      cacheWarm: true,
    });
    expect(plan.strategy).toBe("container");
  });

  it("routes deletions through native Git for compare-and-swap protection", () => {
    const deletion: ChangeObservation = {
      refs: [
        {
          ...smallRef,
          after: null,
          destination: { status: "present", oid: "b".repeat(40) },
          commitCount: 0,
          estimatedPatchBytes: 0,
        },
      ],
      complete: true,
      sourceSizeBytes: null,
    };
    const plan = planSync({
      change: deletion,
      mode: "push",
      strategy: "auto",
      cacheWarm: false,
    });
    expect(plan).toMatchObject({
      strategy: "container",
      reason: "Ref deletions require native Git compare-and-swap protection",
    });
  });

  it("rejects an explicit Workspace mirror", () => {
    expect(() => planSync({ mode: "mirror", strategy: "workspace", cacheWarm: false })).toThrow(
      "workspace strategy cannot mirror",
    );
  });

  it("rejects unsafe explicit Workspace overrides", () => {
    const deletion = {
      ...smallChange,
      refs: [{ ...smallRef, after: null }],
    };
    const uncertain = {
      ...smallChange,
      refs: [{ ...smallRef, forced: null }],
    };

    expect(() =>
      planSync({ change: deletion, mode: "push", strategy: "workspace", cacheWarm: true }),
    ).toThrow("cannot safely delete refs");
    expect(() =>
      planSync({ change: uncertain, mode: "push", strategy: "workspace", cacheWarm: true }),
    ).toThrow("requires a confirmed fast-forward");
  });

  it("detects a no-op from destination state without overwriting source history", () => {
    const change: ChangeObservation = {
      ...smallChange,
      refs: [
        {
          ...smallRef,
          destination: { status: "present", oid: "b".repeat(40) },
        },
      ],
    };
    const plan = planSync({ change, mode: "push", strategy: "auto", cacheWarm: true });

    expect(plan.strategy).toBe("noop");
    expect(plan.refs[0]?.before).toBe("a".repeat(40));
  });

  it("treats an empty current observation as a no-op", () => {
    const plan = planSync({
      change: { ...smallChange, refs: [] },
      mode: "push",
      strategy: "auto",
      cacheWarm: false,
    });

    expect(plan).toMatchObject({
      strategy: "noop",
      reason: "No current ref changes remain",
      refs: [],
    });
  });

  it("rejects invalid limits and duplicate refs", () => {
    expect(() =>
      planSync({
        change: smallChange,
        mode: "push",
        strategy: "auto",
        limits: { refs: 0 },
        cacheWarm: true,
      }),
    ).toThrow("limits.refs must be a positive safe integer");

    expect(() =>
      planSync({
        change: { ...smallChange, refs: [smallRef, smallRef] },
        mode: "push",
        strategy: "auto",
        cacheWarm: true,
      }),
    ).toThrow("Duplicate ref change");

    expect(() =>
      planSync({
        change: { ...smallChange, refs: [{ ...smallRef, ref: "refs/heads/.hidden" }] },
        mode: "push",
        strategy: "auto",
        cacheWarm: true,
      }),
    ).toThrow("Invalid Git ref");

    expect(() =>
      planSync({
        change: { ...smallChange, refs: [{ ...smallRef, after: "0".repeat(40) }] },
        mode: "push",
        strategy: "auto",
        cacheWarm: true,
      }),
    ).toThrow("use null");
  });

  it("routes SHA-256 repositories to native Git", () => {
    const change: ChangeObservation = {
      ...smallChange,
      refs: [
        {
          ...smallRef,
          before: "a".repeat(64),
          after: "b".repeat(64),
          destination: { status: "present", oid: "a".repeat(64) },
        },
      ],
    };

    expect(planSync({ change, mode: "push", strategy: "auto", cacheWarm: true })).toMatchObject({
      strategy: "container",
      reason: "SHA-256 object IDs require native Git",
    });
    expect(() =>
      planSync({ change, mode: "push", strategy: "workspace", cacheWarm: true }),
    ).toThrow("supports SHA-1 repositories only");
  });
});
