import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { type DurableObjectStorageLike, Workspace, WorkspaceProxy } from "@cloudflare/computer";
import {
  CloudflareContainerBackend,
  withWorkspaceContainer,
} from "@cloudflare/computer/backends/container";
import { createGitClient } from "@cloudflare/computer/git";
import {
  artifacts,
  createCloudflareResolver,
  createComputerContainerExecutor,
  createComputerWorkspaceExecutor,
  createSyncClient,
  github,
  inspectGitHubPush,
  observeArtifactsPush,
  type ArtifactsPushEvent,
  type GitHubPushPayload,
  type SyncResult,
} from "@elithrar/artifacts-sync";

export { WorkspaceProxy };

interface GitHubJob {
  readonly kind: "github";
  readonly event: GitHubPushPayload;
}

type SyncJob = GitHubJob | (ArtifactsPushEvent & { readonly type: string });

const ContainerBase = withWorkspaceContainer(class extends DurableObject<Env> {});

export class SyncCoordinator extends ContainerBase {
  readonly #backend: CloudflareContainerBackend;
  readonly #workspace: Workspace;
  #tail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
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
      storage: this.ctx.storage as unknown as DurableObjectStorageLike,
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
    let release = (): void => undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.#runSync(job);
    } finally {
      release();
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

    if (isGitHubJob(job)) {
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

export class SyncWorkflow extends WorkflowEntrypoint<Env, SyncJob> {
  override async run(event: WorkflowEvent<SyncJob>, step: WorkflowStep) {
    return step.do(
      "sync repository",
      { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
      async () => {
        const pair = `${this.env.GITHUB_REPOSITORY}->${this.env.ARTIFACTS_REPOSITORY}`;
        return this.env.SYNC_COORDINATOR.getByName(pair).runSync(event.payload);
      },
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/webhooks/github") return new Response("Not found", { status: 404 });
    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }

    const body = new Uint8Array(await request.arrayBuffer());
    const signature = request.headers.get("x-hub-signature-256");
    if (!(await verifyGitHubSignature(body, signature, env.GITHUB_WEBHOOK_SECRET))) {
      return new Response("Invalid signature", { status: 401 });
    }

    const event = JSON.parse(new TextDecoder().decode(body)) as GitHubPushPayload;
    const delivery = request.headers.get("x-github-delivery") ?? crypto.randomUUID();
    await env.SYNC_WORKFLOW.create({
      id: delivery,
      params: { kind: "github", event },
    });
    return Response.json({ accepted: true }, { status: 202 });
  },
} satisfies ExportedHandler<Env>;

function isGitHubJob(job: SyncJob): job is GitHubJob {
  return "kind" in job && job.kind === "github";
}

async function verifyGitHubSignature(
  body: Uint8Array,
  header: string | null,
  secret: string,
): Promise<boolean> {
  if (header === null || !header.startsWith("sha256=")) return false;
  const signature = fromHex(header.slice("sha256=".length));
  if (signature === undefined) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signature, body);
}

function fromHex(value: string): Uint8Array | undefined {
  if (!/^[a-f\d]{64}$/i.test(value)) return undefined;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}
