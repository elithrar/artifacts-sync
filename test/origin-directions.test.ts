import { describe, expect, it, vi } from "vitest";

import { createConfigurationRegistry, selectSyncRepositories } from "../src/configuration.js";
import { createCloudflareResolver, type ArtifactsBindingLike } from "../src/repositories.js";
import { createSyncClient } from "../src/sync.js";
import type { ChangeObservation, RepositoryResolver, SyncExecutor } from "../src/types.js";

const before = "a".repeat(40);
const after = "b".repeat(40);
const change: ChangeObservation = {
  refs: [
    {
      ref: "refs/heads/main",
      before,
      after,
      destination: { status: "unchecked" },
      commitCount: null,
      estimatedPatchBytes: null,
      forced: null,
    },
  ],
  complete: true,
  sourceSizeBytes: null,
};

describe("Origin sync directions", () => {
  it("resolves Origin for read and Artifacts for write in origin-to-artifacts", async () => {
    const configured = originConfiguration("origin-to-artifacts");
    const [source, destination] = selectSyncRepositories(configured, "peer");
    const setup = createDirectionClient("origin:repo-1");

    await setup.client.plan(source, destination, { change });

    expect(setup.resolveOrigin).toHaveBeenCalledWith(configured.peer, "read");
    expect(setup.createArtifactsToken).toHaveBeenCalledWith("write", 300);
  });

  it("resolves Artifacts for read and Origin for write in artifacts-to-origin", async () => {
    const configured = originConfiguration("artifacts-to-origin");
    const [source, destination] = selectSyncRepositories(configured, "artifacts");
    const setup = createDirectionClient("artifacts:default/project");

    await setup.client.plan(source, destination, { change });

    expect(setup.createArtifactsToken).toHaveBeenCalledWith("read", 300);
    expect(setup.resolveOrigin).toHaveBeenCalledWith(configured.peer, "write");
  });
});

function originConfiguration(direction: "origin-to-artifacts" | "artifacts-to-origin") {
  const registry = createConfigurationRegistry({
    origin: "cursor/project",
    originInstallationId: "installation-1",
    artifacts: "project",
    direction,
  });
  const configured = registry.configurations[0];
  if (configured?.provider !== "origin") throw new Error("Expected an Origin configuration");
  return configured;
}

function createDirectionClient(sourceIdentity: string) {
  const createArtifactsToken = vi.fn(async () => ({ plaintext: "artifacts-token" }));
  const artifacts: ArtifactsBindingLike = {
    get: vi.fn(async () => ({
      remote: "https://artifacts.example/project.git",
      createToken: createArtifactsToken,
    })),
  };
  const resolveOrigin = vi.fn<RepositoryResolver["resolve"]>(async () => ({
    identity: "origin:repo-1",
    url: "https://origin.cursor.com/cursor/project.git",
    authorization: "Basic origin-token",
  }));
  const origin: RepositoryResolver = {
    resolve: resolveOrigin,
  };
  const resolver = createCloudflareResolver({ artifacts, origin });
  const executor: SyncExecutor = {
    execute: vi.fn(async () => ({ refs: ["refs/heads/main"] })),
  };
  const client = createSyncClient({
    resolver,
    refs: {
      read: vi.fn(async (repository) => (repository.identity === sourceIdentity ? after : before)),
    },
    workspace: executor,
    container: executor,
  });
  return { client, createArtifactsToken, resolveOrigin };
}
