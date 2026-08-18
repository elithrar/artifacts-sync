import { describe, expect, it } from "vitest";

import { planSync } from "../src/plan.js";

const smallChange = {
  refs: [
    {
      ref: "refs/heads/main",
      before: "a".repeat(40),
      after: "b".repeat(40),
      commitCount: 2,
      estimatedBytes: 1024,
      forced: false,
    },
  ],
  sourceSizeBytes: 1024,
} as const;

describe("planSync", () => {
  it("uses a warm Workspace for a bounded fast-forward change", () => {
    const plan = planSync({
      change: smallChange,
      mode: "push",
      strategy: "auto",
      cacheWarm: true,
    });
    expect(plan.strategy).toBe("workspace");
    expect(plan.estimate).toMatchObject({ refs: 1, commits: 2, bytes: 1024 });
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

  it.each([
    [
      "missing bytes",
      {
        ...smallChange,
        refs: [
          {
            ref: smallChange.refs[0].ref,
            before: smallChange.refs[0].before,
            after: smallChange.refs[0].after,
            commitCount: smallChange.refs[0].commitCount,
            forced: smallChange.refs[0].forced,
          },
        ],
      },
    ],
    ["forced update", { ...smallChange, refs: [{ ...smallChange.refs[0], forced: true }] }],
    ["truncated inspection", { ...smallChange, truncated: true }],
  ])("routes %s to the container", (_name, change) => {
    const plan = planSync({
      change,
      mode: "push",
      strategy: "auto",
      cacheWarm: true,
    });
    expect(plan.strategy).toBe("container");
  });

  it("always uses native Git for a mirror", () => {
    const plan = planSync({
      mode: "mirror",
      strategy: "auto",
      cacheWarm: true,
    });
    expect(plan.strategy).toBe("container");
  });

  it("respects an explicit strategy override", () => {
    const plan = planSync({
      mode: "mirror",
      strategy: "workspace",
      cacheWarm: false,
    });
    expect(plan.strategy).toBe("workspace");
    expect(plan.overridden).toBe(true);
  });
});
