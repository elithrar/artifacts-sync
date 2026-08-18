import { parseArtifactsRepository, parseGitHubRepository } from "./repositories.js";
import { z } from "zod";
import type { ArtifactsRepository, GitHubRepository } from "./types.js";

export type SyncDirection = "github-to-artifacts" | "artifacts-to-github" | "bidirectional";

type GitHubRepositoryInput = `${string}/${string}`;

export interface SyncReposOptions {
  readonly github: GitHubRepositoryInput;
  readonly artifacts: string;
  readonly artifactsBinding?: string;
  readonly direction: SyncDirection;
}

export interface SyncConfiguration {
  readonly id: string;
  readonly github: GitHubRepository;
  readonly artifacts: ArtifactsRepository;
  readonly artifactsBinding: string;
  readonly direction: SyncDirection;
}

export interface SyncConfigurationRegistry {
  readonly configurations: readonly SyncConfiguration[];
}

const syncReposOptionsSchema = z.strictObject({
  github: z.string(),
  artifacts: z.string(),
  artifactsBinding: z.string().optional(),
  direction: z.enum(["github-to-artifacts", "artifacts-to-github", "bidirectional"]),
});

export function createConfigurationRegistry(
  options: SyncReposOptions | readonly SyncReposOptions[],
): SyncConfigurationRegistry {
  const entries = Array.isArray(options) ? options : [options];
  if (entries.length === 0) throw new Error("syncRepos requires at least one repository pair");

  const configurations = entries.map(validateConfiguration);
  validateRelationships(configurations);
  return Object.freeze({ configurations: Object.freeze(configurations) });
}

export function findConfigurationById(
  registry: SyncConfigurationRegistry,
  id: string,
): SyncConfiguration | undefined {
  return registry.configurations.find((configuration) => configuration.id === id);
}

export function findConfigurationForGitHub(
  registry: SyncConfigurationRegistry,
  slug: string,
): SyncConfiguration | undefined {
  const key = slug.toLowerCase();
  return registry.configurations.find(
    (configuration) =>
      allowsDirection(configuration.direction, "github-to-artifacts") &&
      githubKey(configuration.github) === key,
  );
}

export function findConfigurationForArtifacts(
  registry: SyncConfigurationRegistry,
  namespace: string,
  name: string,
): SyncConfiguration | undefined {
  return registry.configurations.find(
    (configuration) =>
      allowsDirection(configuration.direction, "artifacts-to-github") &&
      configuration.artifacts.namespace === namespace &&
      configuration.artifacts.name === name,
  );
}

export function allowsDirection(
  direction: SyncDirection,
  required: Exclude<SyncDirection, "bidirectional">,
): boolean {
  return direction === "bidirectional" || direction === required;
}

function validateConfiguration(options: SyncReposOptions): SyncConfiguration {
  const result = syncReposOptionsSchema.safeParse(options);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path[0];
    const location = field === undefined ? "configuration" : String(field);
    throw new Error(`Invalid syncRepos ${location}: ${issue?.message ?? "validation failed"}`, {
      cause: result.error,
    });
  }
  const parsed = result.data;

  const github = Object.freeze(parseGitHubRepository(parsed.github));
  const artifacts = Object.freeze(parseArtifactsRepository(parsed.artifacts));
  const artifactsBinding = resolveArtifactsBinding(artifacts, parsed.artifactsBinding);
  return Object.freeze({
    id: configurationId(github, artifacts),
    github,
    artifacts,
    artifactsBinding,
    direction: parsed.direction,
  });
}

function resolveArtifactsBinding(
  artifacts: ArtifactsRepository,
  configured: string | undefined,
): string {
  if (configured === undefined) {
    if (artifacts.namespace !== "default") {
      throw new Error("artifactsBinding is required for a non-default Artifacts namespace");
    }
    return "ARTIFACTS";
  }
  if (!/^[A-Za-z_][A-Za-z\d_]*$/.test(configured)) {
    throw new Error("artifactsBinding must be a valid Worker binding name");
  }
  return configured;
}

function validateRelationships(configurations: readonly SyncConfiguration[]): void {
  for (let leftIndex = 0; leftIndex < configurations.length; leftIndex += 1) {
    const left = configurations[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < configurations.length; rightIndex += 1) {
      const right = configurations[rightIndex];
      if (right === undefined) continue;
      validatePair(left, right);
    }
  }
}

function validatePair(left: SyncConfiguration, right: SyncConfiguration): void {
  if (left.id === right.id) {
    throw new Error(`Duplicate repository pair: ${left.id}`);
  }
  if (
    left.artifacts.namespace === right.artifacts.namespace &&
    left.artifactsBinding !== right.artifactsBinding
  ) {
    throw new Error(
      `Artifacts namespace ${left.artifacts.namespace} uses conflicting Worker bindings`,
    );
  }
  if (
    left.artifactsBinding === right.artifactsBinding &&
    left.artifacts.namespace !== right.artifacts.namespace
  ) {
    throw new Error(
      `Artifacts binding ${left.artifactsBinding} cannot refer to multiple namespaces`,
    );
  }
  if (
    allowsDirection(left.direction, "github-to-artifacts") &&
    allowsDirection(right.direction, "github-to-artifacts") &&
    githubKey(left.github) === githubKey(right.github)
  ) {
    throw new Error(`Fan-out from GitHub repository ${githubSlug(left.github)} is not supported`);
  }
  if (
    allowsDirection(left.direction, "artifacts-to-github") &&
    allowsDirection(right.direction, "artifacts-to-github") &&
    artifactsKey(left.artifacts) === artifactsKey(right.artifacts)
  ) {
    throw new Error(
      `Fan-out from Artifacts repository ${artifactsKey(left.artifacts)} is not supported`,
    );
  }
}

function configurationId(github: GitHubRepository, artifacts: ArtifactsRepository): string {
  return `github:${githubKey(github)}|artifacts:${artifactsKey(artifacts)}`;
}

function githubKey(repository: GitHubRepository): string {
  return githubSlug(repository).toLowerCase();
}

function githubSlug(repository: GitHubRepository): string {
  return `${repository.owner}/${repository.repo}`;
}

function artifactsKey(repository: ArtifactsRepository): string {
  return `${repository.namespace}/${repository.name}`;
}
