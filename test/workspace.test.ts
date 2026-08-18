import { describe, expect, it, vi } from "vitest";

import {
  createComputerWorkspaceExecutor,
  type ComputerWorkspaceLike,
} from "../src/executors/computer-workspace.js";
import type { ExecutionContext, SyncPlan } from "../src/types.js";

const after = "b".repeat(40);
const plan: SyncPlan = {
  strategy: "workspace",
  mode: "push",
  reason: "test",
  refs: [
    {
      ref: "refs/heads/main",
      before: "a".repeat(40),
      after,
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
  from: { identity: "source", url: "https://source.example/repo.git" },
  to: { identity: "target", url: "https://target.example/repo.git" },
};

function fakeWorkspace(fetchHead: string | null) {
  const stat = vi.fn<ComputerWorkspaceLike["fs"]["stat"]>(async () => {
    throw { code: "ENOENT" };
  });
  const mkdir = vi.fn<ComputerWorkspaceLike["fs"]["mkdir"]>(async () => undefined);
  const init = vi.fn<ComputerWorkspaceLike["git"]["init"]>(async () => undefined);
  const remoteAdd = vi.fn<ComputerWorkspaceLike["git"]["remoteAdd"]>(async () => undefined);
  const fetch = vi.fn<ComputerWorkspaceLike["git"]["fetch"]>(async () => ({
    defaultBranch: null,
    fetchHead,
  }));
  const updateRef = vi.fn<ComputerWorkspaceLike["git"]["updateRef"]>(async () => undefined);
  const push = vi.fn<ComputerWorkspaceLike["git"]["push"]>(async () => ({
    ok: true,
    error: null,
    refs: {},
  }));
  const catFile = vi.fn<ComputerWorkspaceLike["git"]["catFile"]>();
  const workspace: ComputerWorkspaceLike = {
    fs: { stat, mkdir },
    git: { init, remoteAdd, fetch, updateRef, push, catFile },
  };
  return { workspace, fetch, updateRef, push };
}

describe("createComputerWorkspaceExecutor", () => {
  it("fetches the observed object and materializes the local ref before pushing", async () => {
    const { workspace, fetch, updateRef, push } = fakeWorkspace(after);
    const executor = createComputerWorkspaceExecutor(workspace);

    await executor.execute(plan, context);

    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({ remoteRef: after, singleBranch: true }),
    );
    const fetchCall = fetch.mock.calls[0];
    const fetchOptions = fetchCall?.[0];
    if (fetchOptions?.ref === undefined) {
      throw new Error("Expected fetch to receive a local ref");
    }
    const localRef = fetchOptions.ref;
    expect(updateRef).toHaveBeenCalledWith({
      dir: "/artifacts-sync/pair",
      ref: localRef,
      value: after,
      force: true,
    });
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ ref: localRef }));
  });

  it("fails closed when the source does not return the observed object", async () => {
    const { workspace, updateRef, push } = fakeWorkspace("c".repeat(40));
    const executor = createComputerWorkspaceExecutor(workspace);

    await expect(executor.execute(plan, context)).rejects.toThrow(
      "Source did not return the observed object",
    );
    expect(updateRef).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("skips a deletion when the destination ref is already absent", async () => {
    const { workspace, fetch, push } = fakeWorkspace(after);
    const executor = createComputerWorkspaceExecutor(workspace);
    const deletion: SyncPlan = {
      ...plan,
      refs: [
        {
          ...plan.refs[0]!,
          after: null,
          destination: { status: "missing" },
        },
      ],
    };

    await expect(executor.execute(deletion, context)).resolves.toMatchObject({ refs: [] });
    expect(fetch).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("rejects pending deletions and unconfirmed force-push state", async () => {
    const { workspace, push } = fakeWorkspace(after);
    const executor = createComputerWorkspaceExecutor(workspace);
    const deletion: SyncPlan = {
      ...plan,
      refs: [{ ...plan.refs[0]!, after: null }],
    };
    const uncertain: SyncPlan = {
      ...plan,
      refs: [{ ...plan.refs[0]!, forced: null }],
    };

    await expect(executor.execute(deletion, context)).rejects.toThrow("cannot safely delete refs");
    await expect(executor.execute(uncertain, context)).rejects.toThrow(
      "requires a confirmed fast-forward",
    );
    expect(push).not.toHaveBeenCalled();
  });
});
