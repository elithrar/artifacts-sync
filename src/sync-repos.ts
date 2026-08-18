import { type DurableObjectStorageLike, Workspace, WorkspaceProxy } from "@cloudflare/computer";
import {
  CloudflareContainerBackend,
  withWorkspaceContainer,
} from "@cloudflare/computer/backends/container";
import { createGitClient } from "@cloudflare/computer/git";
import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";

import { artifactsPushEventSchema, observeArtifactsPush } from "./artifacts.js";
import {
  allowsDirection,
  createConfigurationRegistry,
  findConfigurationById,
  findConfigurationForArtifacts,
  findConfigurationForGitHub,
  type SyncConfiguration,
  type SyncConfigurationRegistry,
  type SyncReposOptions,
} from "./configuration.js";
import { createComputerContainerExecutor } from "./executors/computer-container.js";
import { createComputerWorkspaceExecutor } from "./executors/computer-workspace.js";
import { handleGitHubWebhook, inspectGitHubPush } from "./github.js";
import { createCloudflareResolver } from "./repositories.js";
import { githubPushPayloadSchema } from "./schemas.js";
import { createSyncClient } from "./sync.js";
import type { ArtifactsBindingLike } from "./repositories.js";
import type { ArtifactsPushEvent } from "./artifacts.js";
import type { GitHubPushPayload } from "./schemas.js";
import type { PlannedStrategy, SyncClient, SyncResult } from "./types.js";

export interface SyncResultSummary {
  readonly pair: string | null;
  readonly executed: boolean;
  readonly strategy: PlannedStrategy;
  readonly refs: readonly string[];
  readonly reason: string;
}

export interface SyncReposWorker {
  fetch(request: Request, env: SyncRuntimeEnv): Promise<Response>;
}

interface GitHubSyncJob {
  readonly kind: "github";
  readonly configurationId: string;
  readonly event: GitHubPushPayload;
}

interface RoutedArtifactsSyncJob {
  readonly kind: "artifacts";
  readonly configurationId: string;
  readonly event: ArtifactsPushEvent;
}

type SyncJob = GitHubSyncJob | ArtifactsPushEvent;
type RoutedSyncJob = GitHubSyncJob | RoutedArtifactsSyncJob;
type RuntimeBinding =
  | string
  | ArtifactsBindingLike
  | DurableObjectNamespace<SyncCoordinator>
  | Workflow<SyncJob>;

interface SyncRuntimeEnv {
  readonly [binding: string]: RuntimeBinding;
  readonly GITHUB_TOKEN: string;
  readonly GITHUB_WEBHOOK_SECRET: string;
  readonly SYNC_COORDINATOR: DurableObjectNamespace<SyncCoordinator>;
  readonly SYNC_WORKFLOW: Workflow<SyncJob>;
}

const githubSyncJobSchema = z.object({
  kind: z.literal("github"),
  configurationId: z.string().min(1),
  event: githubPushPayloadSchema,
});
const artifactsBindingSchema = z.object({
  get: z.function(),
  create: z.function().optional(),
});
const MAX_WORKFLOW_INSTANCE_ID_LENGTH = 100;
const PAIR_SUFFIX_LENGTH = 17;
const MAX_PRESERVED_DELIVERY_ID_LENGTH = MAX_WORKFLOW_INSTANCE_ID_LENGTH - PAIR_SUFFIX_LENGTH;

// This immutable deployment configuration is created during module evaluation. It never holds
// request state, credentials, bindings, or promises from a request.
let configurationRegistry: SyncConfigurationRegistry | undefined;

class SyncCoordinatorBase extends DurableObject<SyncRuntimeEnv> {}

const ContainerBase = withWorkspaceContainer(SyncCoordinatorBase);

export class SyncCoordinator extends ContainerBase {
  readonly #backend: CloudflareContainerBackend;
  readonly #workspace: Workspace;
  #tail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: SyncRuntimeEnv) {
    super(ctx, env);
    requireConfigurationRegistry();
    this.#backend = new CloudflareContainerBackend({
      container: () => this,
      workspace: {
        binding: "SYNC_COORDINATOR",
        id: this.ctx.id.toString(),
      },
      egress: { mode: "direct" },
    });
    try {
      this.#workspace = new Workspace({
        // SAFETY: Computer only uses the Durable Object storage, sync, and SQL surface.
        // Cloudflare's generic SQL row signature is wider than Computer's local interface.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        storage: this.ctx.storage as DurableObjectStorageLike,
        git: createGitClient(),
        backends: [this.#backend],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`initialize sync workspace: ${message}`, { cause: error });
    }
  }

  async __getWorkspaceStub() {
    return this.#workspace.stub();
  }

  override async fetch(request: Request): Promise<Response> {
    return this.#backend.handleFetch(request);
  }

  async runSync(job: RoutedSyncJob): Promise<SyncResultSummary> {
    const previous = this.#tail;
    const next = Promise.withResolvers<void>();
    this.#tail = next.promise;
    await previous;
    try {
      return summarizeResult(job.configurationId, await this.#runSync(job));
    } finally {
      next.resolve();
    }
  }

  async #runSync(job: RoutedSyncJob): Promise<SyncResult> {
    const configured = requireConfiguration(job.configurationId);
    const client = this.#createClient(configured);
    if (job.kind === "github") {
      requireDirection(configured, "github-to-artifacts");
      assertGitHubRepository(job.event, configured);
      const change = await inspectGitHubPush(job.event, {
        token: requiredSecret(this.env.GITHUB_TOKEN, "GITHUB_TOKEN"),
      });
      return client.sync(configured.github, configured.artifacts, { change });
    }

    requireDirection(configured, "artifacts-to-github");
    assertArtifactsRepository(job.event, configured);
    return client.sync(configured.artifacts, configured.github, {
      change: observeArtifactsPush(job.event),
    });
  }

  #createClient(configured: SyncConfiguration): SyncClient {
    return createSyncClient({
      resolver: createCloudflareResolver({
        artifacts: requiredArtifactsBinding(this.env, configured.artifactsBinding),
        artifactsRemoteFor: () => configured.artifactsRemote,
        githubToken: requiredSecret(this.env.GITHUB_TOKEN, "GITHUB_TOKEN"),
      }),
      workspace: createComputerWorkspaceExecutor(this.#workspace),
      container: createComputerContainerExecutor(this.#workspace),
    });
  }
}

export class SyncWorkflow extends WorkflowEntrypoint<SyncRuntimeEnv, SyncJob> {
  override async run(
    event: Readonly<WorkflowEvent<SyncJob>>,
    step: WorkflowStep,
  ): Promise<SyncResultSummary> {
    const parsed = parseSyncJob(event.payload);
    const job = routeSyncJob(parsed);
    if (job === undefined) return ignoredArtifactsEvent(parsed);

    return step.do(
      "sync repository",
      { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
      async () => {
        const result = await this.env.SYNC_COORDINATOR.getByName(job.configurationId).runSync(job);
        return copySummary(result);
      },
    );
  }
}

export { WorkspaceProxy };

export function syncRepos(
  options: SyncReposOptions | readonly SyncReposOptions[],
): SyncReposWorker {
  if (configurationRegistry !== undefined) {
    throw new Error("Call syncRepos only once per Worker module");
  }
  const registry = createConfigurationRegistry(options);
  configurationRegistry = registry;

  return Object.freeze({
    async fetch(request: Request, env: SyncRuntimeEnv): Promise<Response> {
      return receiveGitHubWebhook(request, env, registry);
    },
  });
}

function requireConfigurationRegistry(): SyncConfigurationRegistry {
  if (configurationRegistry === undefined) {
    throw new Error("Call syncRepos before Cloudflare creates runtime entrypoints");
  }
  return configurationRegistry;
}

function requireConfiguration(id: string): SyncConfiguration {
  const configured = findConfigurationById(requireConfigurationRegistry(), id);
  if (configured === undefined) {
    throw new NonRetryableError("Sync job references an unknown repository pair");
  }
  return configured;
}

async function receiveGitHubWebhook(
  request: Request,
  env: SyncRuntimeEnv,
  registry: SyncConfigurationRegistry,
): Promise<Response> {
  const hasGitHubSource = registry.configurations.some((configuration) =>
    allowsDirection(configuration.direction, "github-to-artifacts"),
  );
  if (!hasGitHubSource) return new Response("Not found", { status: 404 });

  return handleGitHubWebhook(request, {
    secret: requiredSecret(env.GITHUB_WEBHOOK_SECRET, "GITHUB_WEBHOOK_SECRET"),
    route(repository): string | undefined {
      return findConfigurationForGitHub(registry, repository)?.id;
    },
    async enqueue(delivery, configurationId, event): Promise<string> {
      const id = await workflowInstanceId(delivery, configurationId);
      await env.SYNC_WORKFLOW.createBatch([
        {
          id,
          params: { kind: "github", configurationId, event },
        },
      ]);
      return id;
    },
  });
}

function parseSyncJob(job: SyncJob): SyncJob {
  const githubDiscriminator = z.object({ kind: z.literal("github") }).safeParse(job);
  const result = githubDiscriminator.success
    ? githubSyncJobSchema.safeParse(job)
    : artifactsPushEventSchema.safeParse(job);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    const record = z.record(z.string(), z.unknown()).safeParse(job);
    const fields = record.success
      ? `keys=${Object.keys(record.data).toSorted().slice(0, 10).join(",")}`
      : "not-an-object";
    throw new NonRetryableError(`Invalid repository push event (${fields}): ${issues}`);
  }
  return result.data;
}

function routeSyncJob(job: SyncJob): RoutedSyncJob | undefined {
  if ("kind" in job) {
    const configured = requireConfiguration(job.configurationId);
    requireDirection(configured, "github-to-artifacts");
    assertGitHubRepository(job.event, configured);
    return job;
  }

  const configured = findConfigurationForArtifacts(
    requireConfigurationRegistry(),
    job.source.namespace,
    job.source.repoName,
  );
  if (configured === undefined) return undefined;
  return { kind: "artifacts", configurationId: configured.id, event: job };
}

function summarizeResult(pair: string, result: SyncResult): SyncResultSummary {
  return {
    pair,
    executed: result.executed,
    strategy: result.plan.strategy,
    refs: result.plan.refs.map((change) => change.ref),
    reason: result.plan.reason,
  };
}

function copySummary(result: SyncResultSummary): SyncResultSummary {
  return {
    pair: result.pair,
    executed: result.executed,
    strategy: result.strategy,
    refs: [...result.refs],
    reason: result.reason,
  };
}

function ignoredArtifactsEvent(job: SyncJob): SyncResultSummary {
  if ("kind" in job) {
    throw new NonRetryableError("GitHub sync job could not be routed");
  }
  return {
    pair: null,
    executed: false,
    strategy: "noop",
    refs: [],
    reason: `No sync configured from artifacts:${job.source.namespace}/${job.source.repoName}`,
  };
}

function requireDirection(
  configured: SyncConfiguration,
  required: Exclude<SyncConfiguration["direction"], "bidirectional">,
): void {
  if (!allowsDirection(configured.direction, required)) {
    throw new NonRetryableError(`Sync direction does not allow ${required}`);
  }
}

function assertGitHubRepository(event: GitHubPushPayload, configured: SyncConfiguration): void {
  const expected = `${configured.github.owner}/${configured.github.repo}`;
  if (event.repository.full_name.toLowerCase() !== expected.toLowerCase()) {
    throw new NonRetryableError("GitHub repository does not match sync configuration");
  }
}

function assertArtifactsRepository(event: ArtifactsPushEvent, configured: SyncConfiguration): void {
  if (
    event.source.namespace !== configured.artifacts.namespace ||
    event.source.repoName !== configured.artifacts.name
  ) {
    throw new NonRetryableError("Artifacts repository does not match sync configuration");
  }
}

function requiredArtifactsBinding(env: SyncRuntimeEnv, name: string): ArtifactsBindingLike {
  const binding = env[name];
  if (!artifactsBindingSchema.safeParse(binding).success) {
    throw new Error(`Artifacts binding ${name} is not configured`);
  }
  // SAFETY: The binding was validated against the runtime methods used by the resolver. Return
  // the original binding so Cloudflare's method receiver and proxy identity remain intact.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return binding as ArtifactsBindingLike;
}

function requiredSecret(value: string, name: string): string {
  if (value.length === 0) throw new Error(`${name} must be configured as a Worker secret`);
  return value;
}

async function workflowInstanceId(delivery: string, configurationId: string): Promise<string> {
  const encoder = new TextEncoder();
  const [configurationDigest, deliveryDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(configurationId)),
    delivery.length > MAX_PRESERVED_DELIVERY_ID_LENGTH
      ? crypto.subtle.digest("SHA-256", encoder.encode(delivery))
      : undefined,
  ]);
  const prefix = Array.from(new Uint8Array(configurationDigest).slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const deliveryId =
    deliveryDigest === undefined
      ? delivery
      : Array.from(new Uint8Array(deliveryDigest).slice(0, 16), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
  return `${deliveryId}-${prefix}`;
}
