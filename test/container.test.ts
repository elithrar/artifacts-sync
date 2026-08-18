import { describe, expect, it, vi } from "vitest";

import {
  createComputerContainerExecutor,
  type ComputerRuntimeLike,
} from "../src/executors/computer-container.js";
import type { ExecutionContext, SyncPlan } from "../src/types.js";

const plan: SyncPlan = {
  strategy: "container",
  mode: "push",
  reason: "test",
  refs: [
    {
      ref: "refs/heads/main",
      before: "a".repeat(40),
      after: "b".repeat(40),
      destination: { status: "present", oid: "a".repeat(40) },
      commitCount: 1,
      estimatedPatchBytes: 1,
      forced: false,
    },
  ],
  estimate: { refs: 1, commits: 1, patchBytes: 1, sourceBytes: 1, cacheWarm: false },
  limits: { refs: 3, commits: 50, patchBytes: 1, coldSourceBytes: 1 },
  overridden: false,
};

const context: ExecutionContext = {
  pairKey: "pair",
  from: {
    identity: "source",
    url: "https://source.example/repo.git",
    authorization: "Basic source-secret",
  },
  to: {
    identity: "target",
    url: "https://target.example/repo.git",
    authorization: "Basic target-secret",
  },
};

describe("createComputerContainerExecutor", () => {
  it("passes credentials through the exec environment, not the command", async () => {
    const exec = vi.fn<ComputerRuntimeLike["exec"]>(async () => ({
      result: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    }));
    const executor = createComputerContainerExecutor({ runtime: { exec } });

    await executor.execute(plan, context);

    const [command, options] = exec.mock.calls[0] ?? [];
    expect(command).not.toContain("source-secret");
    expect(command).not.toContain("target-secret");
    expect(options?.env).toMatchObject({
      SYNC_SOURCE_AUTHORIZATION: "Basic source-secret",
      SYNC_TARGET_AUTHORIZATION: "Basic target-secret",
    });
  });

  it("reports native Git failures without exposing the command environment", async () => {
    const exec = vi.fn<ComputerRuntimeLike["exec"]>(async () => ({
      result: async () => ({ exitCode: 1, stdout: "", stderr: "push rejected" }),
    }));
    const executor = createComputerContainerExecutor({ runtime: { exec } });

    await expect(executor.execute(plan, context)).rejects.toThrow(
      "Native Git sync failed: push rejected",
    );
  });

  it("rejects invalid executor limits at construction", () => {
    const exec = vi.fn<ComputerRuntimeLike["exec"]>();
    expect(() => createComputerContainerExecutor({ runtime: { exec } }, { timeoutMs: 0 })).toThrow(
      "timeoutMs must be a positive safe integer",
    );
    expect(() => createComputerContainerExecutor({ runtime: { exec } }, { backend: "" })).toThrow(
      "backend must be non-empty",
    );
  });
});
