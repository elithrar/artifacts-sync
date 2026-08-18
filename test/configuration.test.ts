import { describe, expect, it } from "vitest";

import {
  createConfigurationRegistry,
  findConfigurationById,
  findConfigurationForArtifacts,
  findConfigurationForGitHub,
} from "../src/configuration.js";

describe("syncRepos configuration", () => {
  it("normalizes the default namespace and binding", () => {
    const registry = createConfigurationRegistry({
      github: "elithrar/project",
      artifacts: "project",
      direction: "bidirectional",
    });

    expect(registry.configurations).toEqual([
      {
        id: "github:elithrar/project|artifacts:default/project",
        github: { kind: "github", owner: "elithrar", repo: "project" },
        artifacts: { kind: "artifacts", namespace: "default", name: "project" },
        artifactsBinding: "ARTIFACTS",
        direction: "bidirectional",
      },
    ]);
  });

  it("routes multiple pairs by GitHub slug and Artifacts namespace", () => {
    const registry = createConfigurationRegistry([
      {
        github: "elithrar/project-a",
        artifacts: "project-a",
        direction: "bidirectional",
      },
      {
        github: "elithrar/project-b",
        artifacts: "staging/project-b",
        artifactsBinding: "STAGING_ARTIFACTS",
        direction: "bidirectional",
      },
    ]);

    const github = findConfigurationForGitHub(registry, "ELITHRAR/PROJECT-B");
    const artifacts = findConfigurationForArtifacts(registry, "staging", "project-b");
    expect(github?.id).toBe("github:elithrar/project-b|artifacts:staging/project-b");
    expect(artifacts?.id).toBe(github?.id);
    expect(findConfigurationById(registry, github?.id ?? "")).toBe(github);
  });

  it("routes only from sources allowed by the configured direction", () => {
    const registry = createConfigurationRegistry([
      {
        github: "elithrar/from-github",
        artifacts: "from-github",
        direction: "github-to-artifacts",
      },
      {
        github: "elithrar/from-artifacts",
        artifacts: "from-artifacts",
        direction: "artifacts-to-github",
      },
    ]);

    expect(findConfigurationForGitHub(registry, "elithrar/from-github")).toBeDefined();
    expect(findConfigurationForArtifacts(registry, "default", "from-github")).toBeUndefined();
    expect(findConfigurationForGitHub(registry, "elithrar/from-artifacts")).toBeUndefined();
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
    expect(() =>
      createConfigurationRegistry({
        github: "elithrar/project",
        artifacts: "project",
        // @ts-expect-error Runtime validation must reject JavaScript callers with invalid values.
        direction: "both",
      }),
    ).toThrow("Invalid syncRepos direction");
  });

  it("rejects duplicate pairs and inconsistent namespace bindings", () => {
    expect(() =>
      createConfigurationRegistry([
        {
          github: "elithrar/project",
          artifacts: "project",
          direction: "github-to-artifacts",
        },
        {
          github: "ELITHRAR/PROJECT",
          artifacts: "project",
          direction: "artifacts-to-github",
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
          github: "elithrar/project-b",
          artifacts: "staging/project-b",
          artifactsBinding: "STAGING_B",
          direction: "bidirectional",
        },
      ]),
    ).toThrow("uses conflicting Worker bindings");

    expect(() =>
      createConfigurationRegistry([
        {
          github: "elithrar/project-a",
          artifacts: "staging/project-a",
          artifactsBinding: "SHARED_ARTIFACTS",
          direction: "bidirectional",
        },
        {
          github: "elithrar/project-b",
          artifacts: "production/project-b",
          artifactsBinding: "SHARED_ARTIFACTS",
          direction: "bidirectional",
        },
      ]),
    ).toThrow("cannot refer to multiple namespaces");
  });

  it("rejects fan-out in either direction", () => {
    expect(() =>
      createConfigurationRegistry([
        {
          github: "elithrar/source",
          artifacts: "target-a",
          direction: "github-to-artifacts",
        },
        {
          github: "elithrar/source",
          artifacts: "target-b",
          direction: "bidirectional",
        },
      ]),
    ).toThrow("Fan-out from GitHub repository elithrar/source is not supported");

    expect(() =>
      createConfigurationRegistry([
        {
          github: "elithrar/target-a",
          artifacts: "source",
          direction: "artifacts-to-github",
        },
        {
          github: "elithrar/target-b",
          artifacts: "source",
          direction: "bidirectional",
        },
      ]),
    ).toThrow("Fan-out from Artifacts repository default/source is not supported");
  });
});
