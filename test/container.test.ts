import { describe, expect, it, vi } from "vitest";

import {
  createComputerContainerExecutor,
  type ComputerRuntimeLike,
} from "../src/executors/computer-container.js";
import type { ExecutionContext, SyncPlan } from "../src/types.js";

describe("createComputerContainerExecutor", () => {
  it("passes credentials through the exec environment, not the command", async () => {
    const exec = vi.fn<ComputerRuntimeLike["exec"]>(async () => ({
      result: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    }));
    const executor = createComputerContainerExecutor({ runtime: { exec } });
    const plan: SyncPlan = {
      strategy: "container",
      mode: "push",
      reason: "test",
      refs: [
        {
          ref: "refs/heads/main",
          before: "a".repeat(40),
          after: "b".repeat(40),
          commitCount: 1,
          estimatedBytes: 1,
          forced: false,
        },
      ],
      estimate: { cacheWarm: false },
      limits: { refs: 3, commits: 50, bytes: 1, coldSourceBytes: 1 },
      overridden: false,
    };
    const context: ExecutionContext = {
      pairKey: "pair",
      from: {
        identity: "source",
        url: "https://source.example/repo.git",
        authorization: "Bearer source-secret",
      },
      to: {
        identity: "target",
        url: "https://target.example/repo.git",
        authorization: "Bearer target-secret",
      },
    };

    await executor.execute(plan, context);

    const [command, options] = exec.mock.calls[0] ?? [];
    expect(command).not.toContain("source-secret");
    expect(command).not.toContain("target-secret");
    expect(options?.env).toMatchObject({
      SYNC_SOURCE_AUTHORIZATION: "Bearer source-secret",
      SYNC_TARGET_AUTHORIZATION: "Bearer target-secret",
    });
  });
});
