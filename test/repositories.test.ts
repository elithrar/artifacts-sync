import { describe, expect, it, vi } from "vitest";

import {
  createCloudflareResolver,
  git,
  github,
  type ArtifactsBindingLike,
} from "../src/repositories.js";

function bindingWithToken(token: string): ArtifactsBindingLike {
  return {
    get: vi.fn(async () => ({
      remote: "https://artifacts.example/repo.git",
      createToken: vi.fn(async () => ({ plaintext: token })),
    })),
  };
}

describe("repository helpers", () => {
  it("uses HTTP Basic credentials for GitHub Git operations", async () => {
    const resolver = createCloudflareResolver({
      artifacts: bindingWithToken("artifact-token"),
      githubToken: "github-token",
    });

    await expect(resolver.resolve(github("elithrar/example"), "read")).resolves.toMatchObject({
      identity: "github:elithrar/example",
      authorization: `Basic ${btoa("x-access-token:github-token")}`,
    });
  });

  it("uses HTTP Basic credentials for Artifacts Git operations", async () => {
    const resolver = createCloudflareResolver({
      artifacts: bindingWithToken("artifact-token"),
    });

    await expect(
      resolver.resolve({ kind: "artifacts", name: "example" }, "write"),
    ).resolves.toMatchObject({ authorization: `Basic ${btoa("x:artifact-token")}` });
  });

  it("supports per-repository GitHub tokens without runtime type guessing", async () => {
    const githubTokenFor = vi.fn(async () => "installation-token");
    const resolver = createCloudflareResolver({
      artifacts: bindingWithToken("artifact-token"),
      githubTokenFor,
    });

    await resolver.resolve(github("elithrar/example"), "read");
    expect(githubTokenFor).toHaveBeenCalledWith({
      kind: "github",
      owner: "elithrar",
      repo: "example",
    });
  });

  it("creates a missing Artifacts repository only for write access", async () => {
    const binding: ArtifactsBindingLike = {
      get: vi.fn(async () => {
        throw { code: "NOT_FOUND" };
      }),
      create: vi.fn(async () => ({
        remote: "https://artifacts.example/new.git",
        token: "initial-token",
      })),
    };
    const resolver = createCloudflareResolver({
      artifacts: binding,
      createMissingArtifactsRepositories: true,
    });

    await expect(
      resolver.resolve({ kind: "artifacts", name: "new" }, "write"),
    ).resolves.toMatchObject({ authorization: `Basic ${btoa("x:initial-token")}` });
    await expect(resolver.resolve({ kind: "artifacts", name: "new" }, "read")).rejects.toEqual({
      code: "NOT_FOUND",
    });
  });

  it("rejects unsafe remote URLs and invalid token configuration", () => {
    expect(() => github("owner/repo?token=secret")).toThrow('must use the "owner/repo" form');
    expect(() => git("http://example.com/repo.git")).toThrow("must use HTTPS");
    expect(() => git("https://token@example.com/repo.git")).toThrow(
      "Pass Git credentials through authorization",
    );
    expect(() => git("https://example.com/repo.git?token=secret")).toThrow(
      "must not contain query parameters or fragments",
    );
    expect(() => git("https://example.com/repo.git", { authorization: "Basic token\n" })).toThrow(
      "Git authorization must be non-empty and contain no control characters",
    );
    expect(() =>
      createCloudflareResolver({
        artifacts: bindingWithToken("token"),
        artifactTokenTtlSeconds: 59,
      }),
    ).toThrow("between 60 and 31536000");
    expect(() =>
      createCloudflareResolver({
        artifacts: bindingWithToken("token"),
        githubToken: "static",
        githubTokenFor: async () => "dynamic",
      }),
    ).toThrow("githubToken or githubTokenFor");
  });
});
