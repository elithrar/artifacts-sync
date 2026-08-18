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
  readonly githubToken?: string | ((repository: GitHubRepository) => Promise<string>);
  readonly artifactTokenTtlSeconds?: number;
  readonly createMissingArtifactsRepositories?: boolean;
}

export function github(slug: string): GitHubRepository {
  const parts = slug.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`GitHub repository must be "owner/repo"; received ${slug}`);
  }
  return { kind: "github", owner: parts[0], repo: parts[1] };
}

export function artifacts(name: string): ArtifactsRepository {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`Invalid Artifacts repository name: ${name}`);
  }
  return { kind: "artifacts", name };
}

export function git(
  url: string,
  options: { identity?: string; authorization?: string } = {},
): GitRepository {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Git remotes must use HTTP or HTTPS");
  }
  return {
    kind: "git",
    url,
    ...(options.identity === undefined ? {} : { identity: options.identity }),
    ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
  };
}

export function createCloudflareResolver(options: CloudflareResolverOptions): RepositoryResolver {
  const ttl = options.artifactTokenTtlSeconds ?? 300;

  return {
    async resolve(repository: Repository, access: RepositoryAccess): Promise<ResolvedRepository> {
      switch (repository.kind) {
        case "github": {
          const token = await resolveGitHubToken(options.githubToken, repository);
          return {
            identity: `github:${repository.owner}/${repository.repo}`,
            url: `https://github.com/${repository.owner}/${repository.repo}.git`,
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          };
        }
        case "artifacts": {
          const resolved = await resolveArtifactsRepo(options, repository.name, access);
          if ("token" in resolved) {
            return {
              identity: `artifacts:${repository.name}`,
              url: resolved.remote,
              authorization: `Bearer ${resolved.token}`,
            };
          }
          const token = await resolved.createToken(access, ttl);
          return {
            identity: `artifacts:${repository.name}`,
            url: resolved.remote,
            authorization: `Bearer ${token.plaintext}`,
          };
        }
        case "git":
          return {
            identity: repository.identity ?? `git:${repository.url}`,
            url: repository.url,
            ...(repository.authorization === undefined
              ? {}
              : { authorization: repository.authorization }),
          };
        default:
          return assertNever(repository);
      }
    },
  };
}

function assertNever(value: never): never {
  throw new Error(`Unsupported repository: ${JSON.stringify(value)}`);
}

async function resolveGitHubToken(
  configured: CloudflareResolverOptions["githubToken"],
  repository: GitHubRepository,
): Promise<string | undefined> {
  if (typeof configured === "function") {
    return configured(repository);
  }
  return configured;
}

async function resolveArtifactsRepo(
  options: CloudflareResolverOptions,
  name: string,
  access: RepositoryAccess,
): Promise<ArtifactsRepo | ArtifactsCreateResult> {
  try {
    return await options.artifacts.get(name);
  } catch (error) {
    if (access !== "write" || !options.createMissingArtifactsRepositories || !isNotFound(error)) {
      throw error;
    }
    if (options.artifacts.create === undefined) {
      throw new Error("Artifacts binding cannot create a missing repository", {
        cause: error,
      });
    }
    return options.artifacts.create(name);
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === "NOT_FOUND"
  );
}
