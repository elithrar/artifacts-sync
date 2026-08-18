import { describe, expect, it, vi } from "vitest";

import { createSyncClient } from "../src/sync.js";
import type { RepositoryResolver, ResolvedRepository, SyncExecutor } from "../src/types.js";

const source: ResolvedRepository = {
  identity: "github:elithrar/source",
  url: "https://github.com/elithrar/source.git",
  authorization: "Bearer source-secret",
};
const target: ResolvedRepository = {
  identity: "artifacts:source",
  url: "https://example.artifacts.cloudflare.net/git/default/source.git",
  authorization: "Bearer target-secret",
};
const from = { kind: "git", url: source.url, identity: source.identity } as const;
const to = { kind: "git", url: target.url, identity: target.identity } as const;
const change = {
  refs: [
    {
      ref: "refs/heads/main",
      before: "a".repeat(40),
      after: "b".repeat(40),
      commitCount: 1,
      estimatedBytes: 100,
      forced: false,
    },
  ],
} as const;

function setup(targetOid: string | undefined) {
  const resolver: RepositoryResolver = {
    resolve: vi.fn(async (repository) =>
      repository.identity === source.identity ? source : target,
    ),
  };
  const workspaceExecute = vi.fn<SyncExecutor["execute"]>(async (plan) => ({
    refs: plan.refs.map((item) => item.ref),
  }));
  const containerExecute = vi.fn<SyncExecutor["execute"]>(async () => ({ refs: [] }));
  const client = createSyncClient({
    resolver,
    refs: { read: vi.fn(async () => targetOid) },
    workspace: {
      hasCache: vi.fn(async () => true),
      execute: workspaceExecute,
    },
    container: { execute: containerExecute },
  });
  return { client, workspaceExecute, containerExecute };
}

describe("createSyncClient", () => {
  it("suppresses a reverse-sync loop when the destination already matches", async () => {
    const { client, workspaceExecute, containerExecute } = setup("b".repeat(40));
    const result = await client.sync(from, to, { change });
    expect(result.executed).toBe(false);
    expect(result.plan.strategy).toBe("noop");
    expect(workspaceExecute).not.toHaveBeenCalled();
    expect(containerExecute).not.toHaveBeenCalled();
  });

  it("uses the Workspace executor for a bounded cached change", async () => {
    const { client, workspaceExecute } = setup("a".repeat(40));
    const result = await client.sync(from, to, { change });
    expect(result.plan.strategy).toBe("workspace");
    expect(workspaceExecute).toHaveBeenCalledOnce();
  });

  it("uses the container for sync(from, to) without a push observation", async () => {
    const { client, containerExecute } = setup(undefined);
    const result = await client.sync(from, to);
    expect(result.plan).toMatchObject({ strategy: "container", mode: "mirror" });
    expect(containerExecute).toHaveBeenCalledOnce();
  });
});
