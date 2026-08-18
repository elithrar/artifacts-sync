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

  it("does not retry ref updates that already match the destination", async () => {
    const exec = vi.fn<ComputerRuntimeLike["exec"]>(async () => ({
      result: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    }));
    const executor = createComputerContainerExecutor({ runtime: { exec } });
    const noOpDeletion = {
      ...plan.refs[0]!,
      ref: "refs/heads/obsolete",
      after: null,
      destination: { status: "missing" as const },
    };

    const result = await executor.execute({ ...plan, refs: [...plan.refs, noOpDeletion] }, context);

    expect(result.refs).toEqual(["refs/heads/main"]);
    expect(exec.mock.calls[0]?.[0]).not.toContain("refs/heads/obsolete");
  });

  it("verifies the fetched source object before pushing", async () => {
    const exec = vi.fn<ComputerRuntimeLike["exec"]>(async () => ({
      result: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    }));
    const executor = createComputerContainerExecutor({ runtime: { exec } });

    await executor.execute(plan, context);

    const command = exec.mock.calls[0]?.[0] ?? "";
    expect(command).toContain(
      `source_oid="$(git -C "$workdir/repo.git" rev-parse 'refs/heads/main')"`,
    );
    expect(command).toContain(`if [ "$source_oid" != '${"b".repeat(40)}' ]`);
  });

  it("uses force-with-lease for forced updates and deletions", async () => {
    const exec = vi.fn<ComputerRuntimeLike["exec"]>(async () => ({
      result: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    }));
    const executor = createComputerContainerExecutor({ runtime: { exec } });
    const forced = { ...plan.refs[0]!, forced: true };

    await executor.execute({ ...plan, refs: [forced] }, context);
    expect(exec.mock.calls[0]?.[0]).toContain(
      `'--force-with-lease=refs/heads/main:${"a".repeat(40)}'`,
    );

    const deletion = { ...plan.refs[0]!, after: null };
    await executor.execute({ ...plan, refs: [deletion] }, context);
    const deletionCommand = exec.mock.calls[1]?.[0] ?? "";
    expect(deletionCommand).toContain("source_git ls-remote --exit-code");
    expect(deletionCommand).toContain("Source ref moved after sync planning");
    expect(deletionCommand).toContain(`'--force-with-lease=refs/heads/main:${"a".repeat(40)}'`);
  });

  it("shell-quotes source refs in diagnostics", async () => {
    const exec = vi.fn<ComputerRuntimeLike["exec"]>(async () => ({
      result: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    }));
    const executor = createComputerContainerExecutor({ runtime: { exec } });
    const ref = "refs/heads/$(id)";
    const deletion = { ...plan.refs[0]!, ref, after: null };

    await executor.execute({ ...plan, refs: [deletion] }, context);

    const command = exec.mock.calls[0]?.[0] ?? "";
    expect(command).toContain(`echo 'Source ref moved after sync planning: ${ref}' >&2`);
    expect(command).not.toContain(`echo "Source ref moved after sync planning: ${ref}"`);
  });

  it("refuses to overwrite an already-diverged destination", async () => {
    const exec = vi.fn<ComputerRuntimeLike["exec"]>();
    const executor = createComputerContainerExecutor({ runtime: { exec } });
    const diverged = {
      ...plan.refs[0]!,
      forced: true,
      destination: { status: "present" as const, oid: "c".repeat(40) },
    };

    await expect(executor.execute({ ...plan, refs: [diverged] }, context)).rejects.toThrow(
      "Cannot destructively update diverged destination ref",
    );
    expect(exec).not.toHaveBeenCalled();
  });
});
