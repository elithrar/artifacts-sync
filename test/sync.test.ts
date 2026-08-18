import { describe, expect, it, vi } from "vitest";

import { createSyncClient } from "../src/sync.js";
import type {
  ChangeObservation,
  RepositoryResolver,
  ResolvedRepository,
  SyncExecutor,
} from "../src/types.js";

const source: ResolvedRepository = {
  identity: "github:elithrar/source",
  url: "https://github.com/elithrar/source.git",
  authorization: "Basic source-secret",
};
const target: ResolvedRepository = {
  identity: "artifacts:source",
  url: "https://example.artifacts.cloudflare.net/git/default/source.git",
  authorization: "Basic target-secret",
};
const from = { kind: "git", url: source.url, identity: source.identity } as const;
const to = { kind: "git", url: target.url, identity: target.identity } as const;
const change: ChangeObservation = {
  refs: [
    {
      ref: "refs/heads/main",
      before: "a".repeat(40),
      after: "b".repeat(40),
      destination: { status: "unchecked" },
      commitCount: 1,
      estimatedPatchBytes: 100,
      forced: false,
    },
  ],
  complete: true,
  sourceSizeBytes: null,
};

function setup(targetOid: string | null, sourceOid: string | null = change.refs[0]!.after) {
  const resolver: RepositoryResolver = {
    resolve: vi.fn(async (repository) =>
      repository.kind === "git" && repository.identity === source.identity ? source : target,
    ),
  };
  const workspaceExecute = vi.fn<SyncExecutor["execute"]>(async (plan) => ({
    refs: plan.refs.map((item) => item.ref),
  }));
  const containerExecute = vi.fn<SyncExecutor["execute"]>(async () => ({ refs: [] }));
  const hasCache = vi.fn<NonNullable<SyncExecutor["hasCache"]>>(async () => true);
  const client = createSyncClient({
    resolver,
    refs: {
      read: vi.fn(async (repository) =>
        repository.identity === source.identity ? sourceOid : targetOid,
      ),
    },
    workspace: {
      hasCache,
      execute: workspaceExecute,
    },
    container: { execute: containerExecute },
  });
  return { client, workspaceExecute, containerExecute, hasCache };
}

describe("createSyncClient", () => {
  it("suppresses a reverse-sync loop when the destination already matches", async () => {
    const { client, workspaceExecute, containerExecute } = setup("b".repeat(40));
    const result = await client.sync(from, to, { change });

    expect(result.executed).toBe(false);
    expect(result.plan.strategy).toBe("noop");
    expect(result.plan.refs[0]?.before).toBe("a".repeat(40));
    expect(result.plan.refs[0]?.destination).toEqual({
      status: "present",
      oid: "b".repeat(40),
    });
    expect(workspaceExecute).not.toHaveBeenCalled();
    expect(containerExecute).not.toHaveBeenCalled();
  });

  it("uses the Workspace executor for a bounded cached change", async () => {
    const { client, workspaceExecute, hasCache } = setup("a".repeat(40));
    const result = await client.sync(from, to, { change });

    expect(result.executed).toBe(true);
    expect(result.plan.strategy).toBe("workspace");
    if (!result.executed) throw new Error("Expected sync execution");
    expect(result.result.refs).toEqual(["refs/heads/main"]);
    expect(workspaceExecute).toHaveBeenCalledOnce();
    expect(hasCache).toHaveBeenCalledWith(expect.any(String), [
      expect.objectContaining({ before: "a".repeat(40), after: "b".repeat(40) }),
    ]);
  });

  it("runs a destructive mirror only when explicitly requested", async () => {
    const { client, containerExecute } = setup(null);
    const result = await client.sync(from, to, { mode: "mirror" });
    expect(result.plan).toMatchObject({ strategy: "container", mode: "mirror" });
    expect(containerExecute).toHaveBeenCalledOnce();
  });

  it("rejects syncing a repository to the same identity", async () => {
    const { client } = setup(null);
    await expect(client.sync(from, from, { mode: "mirror" })).rejects.toThrow(
      "Source and destination repositories must be different",
    );
  });

  it("drops a stale event instead of regressing a ref after a newer push", async () => {
    const { client, workspaceExecute, containerExecute, hasCache } = setup(
      "a".repeat(40),
      "c".repeat(40),
    );

    const result = await client.sync(from, to, { change });

    expect(result).toMatchObject({
      executed: false,
      plan: { strategy: "noop", reason: "No current ref changes remain", refs: [] },
    });
    expect(hasCache).not.toHaveBeenCalled();
    expect(workspaceExecute).not.toHaveBeenCalled();
    expect(containerExecute).not.toHaveBeenCalled();
  });
});
