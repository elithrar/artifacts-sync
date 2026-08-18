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
import {
  artifacts,
  createCloudflareResolver,
  createComputerContainerExecutor,
  createComputerWorkspaceExecutor,
  createSyncClient,
  github,
  githubPushPayloadSchema,
  inspectGitHubPush,
  observeArtifactsPush,
  type ArtifactsPushEvent,
  type GitHubPushPayload,
  type SyncResult,
} from "@elithrar/artifacts-sync";

export { WorkspaceProxy };

const MAX_WEBHOOK_BYTES = 10 * 1024 * 1024;

interface Secrets {
  readonly GITHUB_TOKEN: string;
  readonly GITHUB_WEBHOOK_SECRET: string;
}

type RuntimeEnv = Env & Secrets;

interface GitHubJob {
  readonly kind: "github";
  readonly event: GitHubPushPayload;
}

export type SyncJob = GitHubJob | ArtifactsPushEvent;

const ContainerBase = withWorkspaceContainer(class extends DurableObject<RuntimeEnv> {});

export class SyncCoordinator extends ContainerBase {
  readonly #backend: CloudflareContainerBackend;
  readonly #workspace: Workspace;
  #tail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: RuntimeEnv) {
    super(ctx, env);
    this.#backend = new CloudflareContainerBackend({
      container: () => this,
      workspace: {
        binding: "SYNC_COORDINATOR",
        id: this.ctx.id.toString(),
      },
      egress: { mode: "direct" },
    });
    this.#workspace = new Workspace({
      // SAFETY: Computer only uses the Durable Object storage, sync, and SQL surface.
      // Cloudflare's generic SQL row signature is wider than Computer's local interface.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      storage: this.ctx.storage as DurableObjectStorageLike,
      git: createGitClient(),
      backends: [this.#backend],
    });
  }

  async __getWorkspaceStub() {
    return this.#workspace.stub();
  }

  override async fetch(request: Request): Promise<Response> {
    return this.#backend.handleFetch(request);
  }

  async runSync(job: SyncJob): Promise<SyncResult> {
    const previous = this.#tail;
    const next = Promise.withResolvers<void>();
    this.#tail = next.promise;
    await previous;
    try {
      return await this.#runSync(job);
    } finally {
      next.resolve();
    }
  }

  async #runSync(job: SyncJob): Promise<SyncResult> {
    const client = createSyncClient({
      resolver: createCloudflareResolver({
        artifacts: this.env.ARTIFACTS,
        githubToken: this.env.GITHUB_TOKEN,
      }),
      workspace: createComputerWorkspaceExecutor(this.#workspace),
      container: createComputerContainerExecutor(this.#workspace),
    });

    if ("kind" in job) {
      const change = await inspectGitHubPush(job.event, {
        token: this.env.GITHUB_TOKEN,
      });
      return client.sync(
        github(this.env.GITHUB_REPOSITORY),
        artifacts(this.env.ARTIFACTS_REPOSITORY),
        { change },
      );
    }

    return client.sync(
      artifacts(this.env.ARTIFACTS_REPOSITORY),
      github(this.env.GITHUB_REPOSITORY),
      { change: observeArtifactsPush(job) },
    );
  }
}

export class SyncWorkflow extends WorkflowEntrypoint<RuntimeEnv, SyncJob> {
  override async run(event: WorkflowEvent<SyncJob>, step: WorkflowStep): Promise<void> {
    await step.do(
      "sync repository",
      { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
      async () => {
        const pair = `${this.env.GITHUB_REPOSITORY}->${this.env.ARTIFACTS_REPOSITORY}`;
        const result = await this.env.SYNC_COORDINATOR.getByName(pair).runSync(event.payload);
        return {
          executed: result.executed,
          strategy: result.plan.strategy,
          refs: result.plan.refs.map((change) => change.ref),
        };
      },
    );
  }
}

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/webhooks/github") return new Response("Not found", { status: 404 });
    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }
    if (request.headers.get("x-github-event") !== "push") {
      return new Response("Unsupported GitHub event", { status: 400 });
    }
    const delivery = request.headers.get("x-github-delivery");
    if (delivery === null || delivery.length === 0) {
      return new Response("Missing X-GitHub-Delivery", { status: 400 });
    }
    const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      return new Response("Content-Type must be application/json", { status: 415 });
    }

    const body = await readBoundedBody(request, MAX_WEBHOOK_BYTES);
    if (body === null) return new Response("Webhook payload too large", { status: 413 });
    const signature = request.headers.get("x-hub-signature-256");
    if (!(await verifyGitHubSignature(body, signature, env.GITHUB_WEBHOOK_SECRET))) {
      return new Response("Invalid signature", { status: 401 });
    }

    const event = parseGitHubPush(body);
    if (event === null) return new Response("Invalid GitHub push payload", { status: 400 });

    await env.SYNC_WORKFLOW.createBatch([
      {
        id: delivery,
        params: { kind: "github", event },
      },
    ]);
    return Response.json({ accepted: true }, { status: 202 });
  },
} satisfies ExportedHandler<RuntimeEnv>;

function parseGitHubPush(body: Uint8Array<ArrayBuffer>): GitHubPushPayload | null {
  try {
    const result = githubPushPayloadSchema.safeParse(JSON.parse(new TextDecoder().decode(body)));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const advertised = Number.parseInt(contentLength, 10);
    if (Number.isFinite(advertised) && advertised > maxBytes) return null;
  }
  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for (;;) {
    // This loop consumes a bounded request stream; each read must finish before the next.
    // eslint-disable-next-line no-await-in-loop
    const chunk = await reader.read();
    if (chunk.done) break;
    byteLength += chunk.value.byteLength;
    if (byteLength > maxBytes) {
      // The bounded stream must be cancelled before returning early.
      // eslint-disable-next-line no-await-in-loop
      await reader.cancel("GitHub webhook exceeded MAX_WEBHOOK_BYTES");
      return null;
    }
    chunks.push(chunk.value);
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function verifyGitHubSignature(
  body: Uint8Array<ArrayBuffer>,
  header: string | null,
  secret: string,
): Promise<boolean> {
  if (header === null || !header.startsWith("sha256=")) return false;
  const signature = fromHex(header.slice("sha256=".length));
  if (signature === null) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signature, body);
}

function fromHex(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[a-f\d]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}
