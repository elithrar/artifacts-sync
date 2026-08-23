import { describe, expect, it } from "vitest";

import {
  createConfigurationRegistry,
  findConfigurationById,
  findConfigurationForArtifacts,
  findConfigurationForGitHub,
  findConfigurationForOrigin,
  selectSyncRepositories,
  type SyncReposOptions,
} from "../src/configuration.js";

interface InvalidSyncReposOptions {
  readonly github?: string;
  readonly origin?: string;
  readonly originInstallationId?: string;
  readonly artifacts?: string;
  readonly artifactsBinding?: string;
  readonly artifactsRemote?: string;
  readonly direction: string;
}

describe("syncRepos configuration", () => {
  it("normalizes a GitHub pair", () => {
    const registry = createConfigurationRegistry({
      github: "elithrar/project",
      artifacts: "project",
      direction: "bidirectional",
    });

    expect(registry.configurations).toEqual([
      {
        id: "github:elithrar/project|artifacts:default/project",
        provider: "github",
        peer: { kind: "github", owner: "elithrar", repo: "project" },
        artifacts: { kind: "artifacts", namespace: "default", name: "project" },
        artifactsBinding: "ARTIFACTS",
        direction: "bidirectional",
      },
    ]);
  });

  it("normalizes and routes an Origin pair", () => {
    const registry = createConfigurationRegistry({
      origin: "cursor/project",
      originInstallationId: "installation-1",
      artifacts: "project",
      direction: "origin-to-artifacts",
    });

    expect(registry.configurations).toEqual([
      {
        id: "origin:cursor/project|artifacts:default/project",
        provider: "origin",
        peer: {
          kind: "origin",
          owner: "cursor",
          repo: "project",
          installationId: "installation-1",
        },
        artifacts: { kind: "artifacts", namespace: "default", name: "project" },
        artifactsBinding: "ARTIFACTS",
        direction: "peer-to-artifacts",
      },
    ]);
    expect(findConfigurationForOrigin(registry, "installation-1", "CURSOR", "PROJECT")).toBe(
      registry.configurations[0],
    );
    expect(findConfigurationForArtifacts(registry, "default", "project")).toBeUndefined();
  });

  it("orders repositories correctly for both one-way Origin directions", () => {
    const originToArtifactsRegistry = createConfigurationRegistry({
      origin: "cursor/source",
      originInstallationId: "installation-1",
      artifacts: "destination",
      direction: "origin-to-artifacts",
    });
    const artifactsToOriginRegistry = createConfigurationRegistry({
      origin: "cursor/destination",
      originInstallationId: "installation-1",
      artifacts: "source",
      direction: "artifacts-to-origin",
    });
    const originToArtifacts = originToArtifactsRegistry.configurations[0]!;
    const artifactsToOrigin = artifactsToOriginRegistry.configurations[0]!;

    expect(selectSyncRepositories(originToArtifacts, "peer")).toEqual([
      originToArtifacts.peer,
      originToArtifacts.artifacts,
    ]);
    expect(selectSyncRepositories(artifactsToOrigin, "artifacts")).toEqual([
      artifactsToOrigin.artifacts,
      artifactsToOrigin.peer,
    ]);
    expect(
      findConfigurationForOrigin(originToArtifactsRegistry, "installation-1", "cursor", "source"),
    ).toBe(originToArtifacts);
    expect(findConfigurationForArtifacts(artifactsToOriginRegistry, "default", "source")).toBe(
      artifactsToOrigin,
    );
  });

  it("routes multiple providers and Artifacts namespaces", () => {
    const registry = createConfigurationRegistry([
      {
        github: "elithrar/project-a",
        artifacts: "project-a",
        direction: "bidirectional",
      },
      {
        origin: "cursor/project-b",
        originInstallationId: "installation-2",
        artifacts: "staging/project-b",
        artifactsBinding: "STAGING_ARTIFACTS",
        direction: "bidirectional",
      },
    ]);

    const github = findConfigurationForGitHub(registry, "ELITHRAR/PROJECT-A");
    const origin = findConfigurationForOrigin(registry, "installation-2", "cursor", "project-b");
    const artifacts = findConfigurationForArtifacts(registry, "staging", "project-b");
    expect(origin?.id).toBe("origin:cursor/project-b|artifacts:staging/project-b");
    expect(artifacts).toBe(origin);
    expect(findConfigurationById(registry, github?.id ?? "")).toBe(github);
  });

  it("routes only from sources allowed by each provider direction", () => {
    const registry = createConfigurationRegistry([
      {
        github: "elithrar/from-github",
        artifacts: "from-github",
        direction: "github-to-artifacts",
      },
      {
        origin: "cursor/from-artifacts",
        originInstallationId: "installation-1",
        artifacts: "from-artifacts",
        direction: "artifacts-to-origin",
      },
    ]);

    expect(findConfigurationForGitHub(registry, "elithrar/from-github")).toBeDefined();
    expect(findConfigurationForArtifacts(registry, "default", "from-github")).toBeUndefined();
    expect(
      findConfigurationForOrigin(registry, "installation-1", "cursor", "from-artifacts"),
    ).toBeUndefined();
    expect(findConfigurationForArtifacts(registry, "default", "from-artifacts")).toBeDefined();
  });

  it("requires valid strings and an explicit binding for named namespaces", () => {
    expect(() => createConfigurationRegistry([])).toThrow("at least one repository pair");
    expect(() =>
      createConfigurationRegistry({
        github: "elithrar/project/extra",
        artifacts: "project",
        direction: "bidirectional",
      }),
    ).toThrow('GitHub repository must use the "owner/repo" form');
    expectInvalidConfiguration(
      {
        origin: "project",
        originInstallationId: "installation-1",
        artifacts: "project",
        direction: "bidirectional",
      },
      'Origin repository must use the "owner/repo" form',
    );
    expect(() =>
      createConfigurationRegistry({
        origin: "cursor/project",
        originInstallationId: "",
        artifacts: "project",
        direction: "bidirectional",
      }),
    ).toThrow("Invalid syncRepos originInstallationId");
    expect(() =>
      createConfigurationRegistry({
        github: "elithrar/project",
        artifacts: "staging/project",
        direction: "bidirectional",
      }),
    ).toThrow("artifactsBinding is required");
    expect(() =>
      createConfigurationRegistry({
        github: "elithrar/project",
        artifacts: "staging/project",
        artifactsBinding: "not-a-binding",
        direction: "bidirectional",
      }),
    ).toThrow("valid Worker binding name");
    expectInvalidConfiguration(
      {
        github: "elithrar/project",
        artifacts: "project",
        direction: "both",
      },
      "Invalid syncRepos direction",
    );
  });

  it("rejects pairs with both peers or no Artifacts repository", () => {
    expectInvalidConfiguration(
      {
        github: "elithrar/project",
        origin: "cursor/project",
        originInstallationId: "installation-1",
        artifacts: "project",
        direction: "bidirectional",
      },
      "Invalid syncRepos configuration",
    );
    expectInvalidConfiguration(
      {
        origin: "cursor/project",
        originInstallationId: "installation-1",
        direction: "bidirectional",
      },
      "Invalid syncRepos artifacts",
    );
  });

  it("rejects duplicate pairs and inconsistent namespace bindings", () => {
    expect(() =>
      createConfigurationRegistry([
        {
          origin: "cursor/project",
          originInstallationId: "installation-1",
          artifacts: "project",
          direction: "origin-to-artifacts",
        },
        {
          origin: "CURSOR/PROJECT",
          originInstallationId: "installation-1",
          artifacts: "project",
          direction: "artifacts-to-origin",
        },
      ]),
    ).toThrow("Duplicate repository pair");

    expect(() =>
      createConfigurationRegistry([
        {
          github: "elithrar/project-a",
          artifacts: "staging/project-a",
          artifactsBinding: "STAGING_A",
          direction: "bidirectional",
        },
        {
          origin: "cursor/project-b",
          originInstallationId: "installation-1",
          artifacts: "staging/project-b",
          artifactsBinding: "STAGING_B",
          direction: "bidirectional",
        },
      ]),
    ).toThrow("uses conflicting Worker bindings");
  });

  it("rejects fan-out from either peer and across Artifacts peer providers", () => {
    expect(() =>
      createConfigurationRegistry([
        {
          origin: "cursor/source",
          originInstallationId: "installation-1",
          artifacts: "target-a",
          direction: "origin-to-artifacts",
        },
        {
          origin: "cursor/source",
          originInstallationId: "installation-1",
          artifacts: "target-b",
          direction: "bidirectional",
        },
      ]),
    ).toThrow("Fan-out from Origin repository cursor/source is not supported");

    expect(() =>
      createConfigurationRegistry([
        {
          github: "elithrar/target-a",
          artifacts: "source",
          direction: "artifacts-to-github",
        },
        {
          origin: "cursor/target-b",
          originInstallationId: "installation-1",
          artifacts: "source",
          direction: "bidirectional",
        },
      ]),
    ).toThrow("Fan-out from Artifacts repository default/source is not supported");
  });
});

function expectInvalidConfiguration(configuration: InvalidSyncReposOptions, message: string): void {
  expect(() => {
    // SAFETY: These test cases intentionally bypass the public type to exercise runtime validation.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    createConfigurationRegistry(configuration as SyncReposOptions);
  }).toThrow(message);
}
