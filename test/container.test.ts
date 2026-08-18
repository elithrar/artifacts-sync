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
  it("passes credentials through stdin, not the command", async () => {
    const exec = vi.fn<ComputerRuntimeLike["exec"]>(async () => ({
      result: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    }));
    const executor = createComputerContainerExecutor({ runtime: { exec } });

    await executor.execute(plan, context);

    const [command, options] = exec.mock.calls[0] ?? [];
    expect(command).not.toContain("source-secret");
    expect(command).not.toContain("target-secret");
    expect(options?.stdin).toBe(
      "https://source.example/repo.git\nhttps://target.example/repo.git\nBasic source-secret\nBasic target-secret\n",
    );
    expect(command).toContain('GIT_ASKPASS="$askpass"');
    expect(command).toContain("credentials=\"$(printf '%s'");
    expect(options?.backend).toBe("container-shell");
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

  it("leases the observed destination for forced and unknown updates", async () => {
    const exec = vi.fn<ComputerRuntimeLike["exec"]>(async () => ({
      result: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    }));
    const executor = createComputerContainerExecutor({ runtime: { exec } });
    const divergedDestination = { status: "present" as const, oid: "c".repeat(40) };
    const forced = { ...plan.refs[0]!, forced: true, destination: divergedDestination };

    await executor.execute({ ...plan, refs: [forced] }, context);
    expect(exec.mock.calls[0]?.[0]).toContain(
      `'--force-with-lease=refs/heads/main:${"c".repeat(40)}'`,
    );

    const unknown = { ...plan.refs[0]!, forced: null, destination: divergedDestination };
    await executor.execute({ ...plan, refs: [unknown] }, context);
    expect(exec.mock.calls[1]?.[0]).toContain(
      `'--force-with-lease=refs/heads/main:${"c".repeat(40)}'`,
    );
  });

  it("leases the absence of a missing destination ref", async () => {
    const exec = vi.fn<ComputerRuntimeLike["exec"]>(async () => ({
      result: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    }));
    const executor = createComputerContainerExecutor({ runtime: { exec } });
    const creation = {
      ...plan.refs[0]!,
      before: null,
      forced: null,
      destination: { status: "missing" as const },
    };

    await executor.execute({ ...plan, refs: [creation] }, context);

    expect(exec.mock.calls[0]?.[0]).toContain("'--force-with-lease=refs/heads/main:'");
  });

  it("keeps confirmed fast-forward updates non-forced", async () => {
    const exec = vi.fn<ComputerRuntimeLike["exec"]>(async () => ({
      result: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    }));
    const executor = createComputerContainerExecutor({ runtime: { exec } });

    await executor.execute(plan, context);

    expect(exec.mock.calls[0]?.[0]).not.toContain("--force-with-lease");
  });

  it("leases the observed destination when deleting a ref", async () => {
    const exec = vi.fn<ComputerRuntimeLike["exec"]>(async () => ({
      result: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    }));
    const executor = createComputerContainerExecutor({ runtime: { exec } });
    const deletion = {
      ...plan.refs[0]!,
      after: null,
      destination: { status: "present" as const, oid: "c".repeat(40) },
    };

    await executor.execute({ ...plan, refs: [deletion] }, context);

    const command = exec.mock.calls[0]?.[0] ?? "";
    expect(command).toContain("source_git ls-remote --exit-code");
    expect(command).toContain("Source ref moved after sync planning");
    expect(command).toContain(`'--force-with-lease=refs/heads/main:${"c".repeat(40)}'`);
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

  it("requires an observed destination before a forced update", async () => {
    const exec = vi.fn<ComputerRuntimeLike["exec"]>();
    const executor = createComputerContainerExecutor({ runtime: { exec } });
    const unchecked = {
      ...plan.refs[0]!,
      forced: true,
      destination: { status: "unchecked" as const },
    };

    await expect(executor.execute({ ...plan, refs: [unchecked] }, context)).rejects.toThrow(
      "before reading the destination ref",
    );
    expect(exec).not.toHaveBeenCalled();
  });
});
