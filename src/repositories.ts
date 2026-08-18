import { z } from "zod";

import type {
  ArtifactsRepository,
  GitHubRepository,
  GitRepository,
  Repository,
  RepositoryAccess,
  RepositoryResolver,
  ResolvedRepository,
} from "./types.js";

interface ArtifactsToken {
  readonly plaintext: string;
}

interface ArtifactsRepo {
  readonly remote: string;
  createToken(scope?: "write" | "read", ttl?: number): Promise<ArtifactsToken>;
}

interface ArtifactsCreateResult {
  readonly remote: string;
  readonly token: string;
}

type ResolvedArtifactsRepo =
  | { readonly kind: "existing"; readonly repo: ArtifactsRepo }
  | { readonly kind: "created"; readonly result: ArtifactsCreateResult };

export interface ArtifactsBindingLike {
  get(name: string): Promise<ArtifactsRepo>;
  create?(
    name: string,
    options?: {
      description?: string;
      readOnly?: boolean;
      setDefaultBranch?: string;
    },
  ): Promise<ArtifactsCreateResult>;
}

export interface CloudflareResolverOptions {
  readonly artifacts: ArtifactsBindingLike;
  readonly githubToken?: string;
  readonly githubTokenFor?: (repository: GitHubRepository) => Promise<string>;
  readonly artifactsRemoteFor?: (repository: ArtifactsRepository) => string | undefined;
  readonly artifactTokenTtlSeconds?: number;
  readonly createMissingArtifactsRepositories?: boolean;
}

const githubRepositorySchema = z
  .string()
  .regex(
    /^[A-Za-z\d](?:[A-Za-z\d-]{0,37}[A-Za-z\d])?\/[A-Za-z\d._-]+$/,
    'GitHub repository must use the "owner/repo" form',
  )
  .transform((slug): GitHubRepository => {
    const separator = slug.indexOf("/");
    return {
      kind: "github",
      owner: slug.slice(0, separator),
      repo: slug.slice(separator + 1),
    };
  });
const artifactsRepositorySchema = z
  .string()
  .regex(
    /^(?:[A-Za-z\d][A-Za-z\d._-]*\/)?[A-Za-z\d][A-Za-z\d._-]*$/,
    'Artifacts repository must use the "repo" or "namespace/repo" form',
  )
  .transform((value): ArtifactsRepository => {
    const separator = value.indexOf("/");
    if (separator === -1) return { kind: "artifacts", namespace: "default", name: value };
    return {
      kind: "artifacts",
      namespace: value.slice(0, separator),
      name: value.slice(separator + 1),
    };
  });

export function parseGitHubRepository(slug: string): GitHubRepository {
  const result = githubRepositorySchema.safeParse(slug);
  if (!result.success) {
    throw new Error(
      result.error.issues[0]?.message ?? 'GitHub repository must use the "owner/repo" form',
    );
  }
  return result.data;
}

export function parseArtifactsRepository(value: string): ArtifactsRepository {
  const result = artifactsRepositorySchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      result.error.issues[0]?.message ??
        'Artifacts repository must use the "repo" or "namespace/repo" form',
    );
  }
  return result.data;
}

export function git(
  url: string,
  options: { identity?: string; authorization?: string } = {},
): GitRepository {
  assertSafeRemoteUrl(url);
  if (options.identity !== undefined) validateOpaqueValue(options.identity, "Git identity");
  if (options.authorization !== undefined) {
    validateOpaqueValue(options.authorization, "Git authorization");
  }
  return createGitRepository(url, options.identity, options.authorization);
}

export function createCloudflareResolver(options: CloudflareResolverOptions): RepositoryResolver {
  const ttl = options.artifactTokenTtlSeconds ?? 300;
  if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 31_536_000) {
    throw new RangeError("artifactTokenTtlSeconds must be an integer between 60 and 31536000");
  }
  if (options.githubToken !== undefined && options.githubTokenFor !== undefined) {
    throw new Error("Set githubToken or githubTokenFor, not both");
  }

  return {
    async resolve(repository: Repository, access: RepositoryAccess): Promise<ResolvedRepository> {
      switch (repository.kind) {
        case "github": {
          const token = await resolveGitHubToken(options, repository);
          return createResolvedRepository(
            `github:${repository.owner}/${repository.repo}`,
            `https://github.com/${repository.owner}/${repository.repo}.git`,
            token === undefined ? undefined : basicAuthorization("x-access-token", token),
          );
        }
        case "artifacts": {
          const resolved = await resolveArtifactsRepo(options, repository.name, access);
          if (resolved.kind === "created") {
            return {
              identity: artifactsIdentity(repository),
              url: resolved.result.remote,
              authorization: artifactsAuthorization(resolved.result.token),
            };
          }
          const token = await runRepositoryStage("create Artifacts repository token", () =>
            resolved.repo.createToken(access, ttl),
          );
          return createResolvedRepository(
            artifactsIdentity(repository),
            options.artifactsRemoteFor?.(repository) ?? resolved.repo.remote,
            artifactsAuthorization(token.plaintext),
          );
        }
        case "git":
          return createResolvedRepository(
            repository.identity ?? `git:${repository.url}`,
            repository.url,
            repository.authorization,
          );
        default:
          return assertNever(repository);
      }
    },
  };
}

function artifactsIdentity(repository: ArtifactsRepository): string {
  return `artifacts:${repository.namespace}/${repository.name}`;
}

function assertNever(_value: never): never {
  throw new Error("Unsupported repository type");
}

async function resolveGitHubToken(
  options: CloudflareResolverOptions,
  repository: GitHubRepository,
): Promise<string | undefined> {
  if (options.githubTokenFor !== undefined) return options.githubTokenFor(repository);
  return options.githubToken;
}

async function resolveArtifactsRepo(
  options: CloudflareResolverOptions,
  name: string,
  access: RepositoryAccess,
): Promise<ResolvedArtifactsRepo> {
  try {
    return { kind: "existing", repo: await options.artifacts.get(name) };
  } catch (error) {
    const notFound = z.object({ code: z.literal("NOT_FOUND") }).safeParse(error).success;
    if (access !== "write" || !options.createMissingArtifactsRepositories || !notFound) {
      if (!notFound) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`get Artifacts repository: ${message}`, { cause: error });
      }
      throw error;
    }
    if (options.artifacts.create === undefined) {
      throw new Error("Artifacts binding cannot create a missing repository", {
        cause: error,
      });
    }
    return { kind: "created", result: await options.artifacts.create(name) };
  }
}

function createGitRepository(
  url: string,
  identity: string | undefined,
  authorization: string | undefined,
): GitRepository {
  if (identity === undefined) {
    if (authorization === undefined) return { kind: "git", url };
    return { kind: "git", url, authorization };
  }
  if (authorization === undefined) return { kind: "git", url, identity };
  return { kind: "git", url, identity, authorization };
}

function createResolvedRepository(
  identity: string,
  url: string,
  authorization: string | undefined,
): ResolvedRepository {
  assertSafeRemoteUrl(url);
  validateOpaqueValue(identity, "Repository identity");
  if (authorization !== undefined) validateOpaqueValue(authorization, "Git authorization");
  if (authorization === undefined) return { identity, url };
  return { identity, url, authorization };
}

function basicAuthorization(username: string, password: string): string {
  if (password.length === 0 || hasControlCharacter(password)) {
    throw new Error("Git credential token must be non-empty and contain no control characters");
  }
  return `Basic ${btoa(`${username}:${password}`)}`;
}

function artifactsAuthorization(token: string): string {
  validateOpaqueValue(token, "Artifacts token");
  const secret = token.split("?expires=", 1)[0];
  if (secret === undefined || secret.length === 0) {
    throw new Error("Artifacts token secret must be non-empty");
  }
  return basicAuthorization("x", secret);
}

async function runRepositoryStage<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${stage}: ${message}`, { cause: error });
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

function assertSafeRemoteUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname.length === 0) {
    throw new Error("Git remotes must use HTTPS");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("Pass Git credentials through authorization, not the remote URL");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error("Git remote URLs must not contain query parameters or fragments");
  }
}

function validateOpaqueValue(value: string, name: string): void {
  if (value.length === 0 || hasControlCharacter(value)) {
    throw new Error(`${name} must be non-empty and contain no control characters`);
  }
}
