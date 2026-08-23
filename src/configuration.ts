import {
  git,
  parseArtifactsRepository,
  parseGitHubRepository,
  parseOriginRepository,
} from "./repositories.js";
import { z } from "zod";
import type {
  ArtifactsRepository,
  GitHubRepository,
  OriginRepository,
  Repository,
} from "./types.js";

export type GitHubSyncDirection = "github-to-artifacts" | "artifacts-to-github" | "bidirectional";
export type OriginSyncDirection = "origin-to-artifacts" | "artifacts-to-origin" | "bidirectional";
export type SyncDirection = "peer-to-artifacts" | "artifacts-to-peer" | "bidirectional";

type RepositoryInput = `${string}/${string}`;

interface ArtifactsOptions {
  readonly artifacts: string;
  readonly artifactsBinding?: string;
  readonly artifactsRemote?: string;
}

export interface GitHubSyncReposOptions extends ArtifactsOptions {
  readonly github: RepositoryInput;
  readonly origin?: never;
  readonly originInstallationId?: never;
  readonly direction: GitHubSyncDirection;
}

export interface OriginSyncReposOptions extends ArtifactsOptions {
  readonly github?: never;
  readonly origin: RepositoryInput;
  readonly originInstallationId: string;
  readonly direction: OriginSyncDirection;
}

export type SyncReposOptions = GitHubSyncReposOptions | OriginSyncReposOptions;

interface BaseSyncConfiguration {
  readonly id: string;
  readonly artifacts: ArtifactsRepository;
  readonly artifactsBinding: string;
  readonly artifactsRemote?: string;
  readonly direction: SyncDirection;
}

export interface GitHubSyncConfiguration extends BaseSyncConfiguration {
  readonly provider: "github";
  readonly peer: GitHubRepository;
}

export interface OriginSyncConfiguration extends BaseSyncConfiguration {
  readonly provider: "origin";
  readonly peer: OriginRepository;
}

export type SyncConfiguration = GitHubSyncConfiguration | OriginSyncConfiguration;

export interface SyncConfigurationRegistry {
  readonly configurations: readonly SyncConfiguration[];
}

const artifactsOptionFields = {
  artifacts: z.string(),
  artifactsBinding: z.string().optional(),
  artifactsRemote: z.string().optional(),
};
const githubOptionsSchema = z.strictObject({
  ...artifactsOptionFields,
  github: z.string(),
  direction: z.enum(["github-to-artifacts", "artifacts-to-github", "bidirectional"]),
});
const originOptionsSchema = z.strictObject({
  ...artifactsOptionFields,
  origin: z.string(),
  originInstallationId: z.string().min(1),
  direction: z.enum(["origin-to-artifacts", "artifacts-to-origin", "bidirectional"]),
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
): GitHubSyncConfiguration | undefined {
  const key = slug.toLowerCase();
  return registry.configurations.find(
    (configuration): configuration is GitHubSyncConfiguration =>
      configuration.provider === "github" &&
      allowsDirection(configuration.direction, "peer-to-artifacts") &&
      peerKey(configuration) === key,
  );
}

export function findConfigurationForOrigin(
  registry: SyncConfigurationRegistry,
  installationId: string,
  owner: string,
  name: string,
): OriginSyncConfiguration | undefined {
  const key = `${owner}/${name}`.toLowerCase();
  return registry.configurations.find(
    (configuration): configuration is OriginSyncConfiguration =>
      configuration.provider === "origin" &&
      allowsDirection(configuration.direction, "peer-to-artifacts") &&
      configuration.peer.installationId === installationId &&
      peerKey(configuration) === key,
  );
}

export function findConfigurationForArtifacts(
  registry: SyncConfigurationRegistry,
  namespace: string,
  name: string,
): SyncConfiguration | undefined {
  return registry.configurations.find(
    (configuration) =>
      allowsDirection(configuration.direction, "artifacts-to-peer") &&
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

/** @internal Selects the ordered repositories after a job's direction has been authorized. */
export function selectSyncRepositories<Configuration extends SyncConfiguration>(
  configuration: Configuration,
  source: "peer",
): readonly [Configuration["peer"], ArtifactsRepository];
export function selectSyncRepositories<Configuration extends SyncConfiguration>(
  configuration: Configuration,
  source: "artifacts",
): readonly [ArtifactsRepository, Configuration["peer"]];
export function selectSyncRepositories(
  configuration: SyncConfiguration,
  source: "peer" | "artifacts",
): readonly [Repository, Repository] {
  return source === "peer"
    ? [configuration.peer, configuration.artifacts]
    : [configuration.artifacts, configuration.peer];
}

function validateConfiguration(options: SyncReposOptions): SyncConfiguration {
  const isOrigin = "origin" in options;
  const result = isOrigin
    ? originOptionsSchema.safeParse(options)
    : githubOptionsSchema.safeParse(options);
  if (!result.success) throwConfigurationError(result.error);
  const parsed = result.data;
  const artifacts = Object.freeze(parseArtifactsRepository(parsed.artifacts));
  const artifactsBinding = resolveArtifactsBinding(artifacts, parsed.artifactsBinding);
  const artifactsRemote =
    parsed.artifactsRemote === undefined ? undefined : git(parsed.artifactsRemote).url;
  const remoteConfiguration = artifactsRemote === undefined ? {} : { artifactsRemote };

  if (isOrigin) {
    const originParsed = originOptionsSchema.parse(parsed);
    const peer = Object.freeze(
      parseOriginRepository(originParsed.origin, originParsed.originInstallationId),
    );
    return freezeConfiguration({
      id: configurationId("origin", originKey(peer), artifacts),
      provider: "origin",
      peer,
      artifacts,
      artifactsBinding,
      ...remoteConfiguration,
      direction: normalizeOriginDirection(originParsed.direction),
    });
  }

  const githubParsed = githubOptionsSchema.parse(parsed);
  const peer = Object.freeze(parseGitHubRepository(githubParsed.github));
  return freezeConfiguration({
    id: configurationId("github", githubKey(peer), artifacts),
    provider: "github",
    peer,
    artifacts,
    artifactsBinding,
    ...remoteConfiguration,
    direction: normalizeGitHubDirection(githubParsed.direction),
  });
}

function throwConfigurationError(error: z.ZodError): never {
  const issue = error.issues[0];
  const field = issue?.path[0];
  const location = field === undefined ? "configuration" : String(field);
  throw new Error(`Invalid syncRepos ${location}: ${issue?.message ?? "validation failed"}`, {
    cause: error,
  });
}

function freezeConfiguration<Configuration extends SyncConfiguration>(
  configuration: Configuration,
): Configuration {
  return Object.freeze(configuration);
}

function normalizeGitHubDirection(direction: GitHubSyncDirection): SyncDirection {
  if (direction === "github-to-artifacts") return "peer-to-artifacts";
  if (direction === "artifacts-to-github") return "artifacts-to-peer";
  return direction;
}

function normalizeOriginDirection(direction: OriginSyncDirection): SyncDirection {
  if (direction === "origin-to-artifacts") return "peer-to-artifacts";
  if (direction === "artifacts-to-origin") return "artifacts-to-peer";
  return direction;
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
  if (left.id === right.id) throw new Error(`Duplicate repository pair: ${left.id}`);
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
    left.provider === right.provider &&
    allowsDirection(left.direction, "peer-to-artifacts") &&
    allowsDirection(right.direction, "peer-to-artifacts") &&
    peerKey(left) === peerKey(right)
  ) {
    throw new Error(
      `Fan-out from ${providerName(left)} repository ${peerSlug(left)} is not supported`,
    );
  }
  if (
    allowsDirection(left.direction, "artifacts-to-peer") &&
    allowsDirection(right.direction, "artifacts-to-peer") &&
    artifactsKey(left.artifacts) === artifactsKey(right.artifacts)
  ) {
    throw new Error(
      `Fan-out from Artifacts repository ${artifactsKey(left.artifacts)} is not supported`,
    );
  }
}

function configurationId(
  provider: SyncConfiguration["provider"],
  peer: string,
  artifacts: ArtifactsRepository,
): string {
  return `${provider}:${peer}|artifacts:${artifactsKey(artifacts)}`;
}

function peerKey(configuration: SyncConfiguration): string {
  return configuration.provider === "github"
    ? githubKey(configuration.peer)
    : originKey(configuration.peer);
}

function githubKey(repository: GitHubRepository): string {
  return `${repository.owner}/${repository.repo}`.toLowerCase();
}

function originKey(repository: OriginRepository): string {
  return `${repository.owner}/${repository.repo}`.toLowerCase();
}

function peerSlug(configuration: SyncConfiguration): string {
  return `${configuration.peer.owner}/${configuration.peer.repo}`;
}

function providerName(configuration: SyncConfiguration): "GitHub" | "Origin" {
  return configuration.provider === "github" ? "GitHub" : "Origin";
}

function artifactsKey(repository: ArtifactsRepository): string {
  return `${repository.namespace}/${repository.name}`;
}
