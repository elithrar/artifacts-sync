import { z } from "zod";

import { githubPushPayloadSchema, type GitHubPushPayload } from "./schemas.js";
import type { ChangeObservation, RefChange } from "./types.js";

const MAX_COMPARE_BYTES = 20 * 1024 * 1024;
const MAX_COMPARE_FILES = 300;
const MAX_WEBHOOK_BYTES = 10 * 1024 * 1024;
const GITHUB_WEBHOOK_PATH = "/webhooks/github";
const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_USER_AGENT = "artifacts-sync";

const compareFileSchema = z.object({
  status: z.string().optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  patch: z.string().optional(),
});

const compareResponseSchema = z.object({
  total_commits: z.number().int().nonnegative().optional(),
  files: z.array(compareFileSchema).optional(),
});

type CompareFile = z.infer<typeof compareFileSchema>;

interface PatchEstimate {
  readonly complete: boolean;
  readonly patchBytes: number | null;
}

export interface InspectGitHubPushOptions {
  readonly token?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly apiUrl?: string;
  readonly maxResponseBytes?: number;
}

interface HandleGitHubWebhookOptions {
  readonly secret: string;
  readonly route: (repository: string) => string | undefined;
  readonly enqueue: (
    delivery: string,
    configurationId: string,
    event: GitHubPushPayload,
  ) => Promise<string>;
}

export async function handleGitHubWebhook(
  request: Request,
  options: HandleGitHubWebhookOptions,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== GITHUB_WEBHOOK_PATH) return new Response("Not found", { status: 404 });
  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return new Response("Content-Type must be application/json", { status: 415 });
  }
  const delivery = request.headers.get("x-github-delivery");
  if (delivery === null || delivery.length === 0) {
    return new Response("Missing X-GitHub-Delivery", { status: 400 });
  }

  const body = await readBoundedBody(request, MAX_WEBHOOK_BYTES);
  if (body === null) return new Response("Webhook payload too large", { status: 413 });
  if (options.secret.length === 0) throw new Error("GITHUB_WEBHOOK_SECRET must be configured");
  const valid = await verifyGitHubSignature(
    body,
    request.headers.get("x-hub-signature-256"),
    options.secret,
  );
  if (!valid) return new Response("Invalid signature", { status: 401 });

  const eventName = request.headers.get("x-github-event");
  if (eventName === "ping") return new Response(null, { status: 204 });
  if (eventName !== "push") {
    return new Response("Unsupported GitHub event", { status: 400 });
  }

  const event = parseGitHubPush(body);
  if (event === null) return new Response("Invalid GitHub push payload", { status: 400 });
  const configurationId = options.route(event.repository.full_name);
  if (configurationId === undefined) {
    return new Response("Repository is not configured", { status: 404 });
  }

  const id = await options.enqueue(delivery, configurationId, event);
  return Response.json({ accepted: true, id }, { status: 202 });
}

export async function inspectGitHubPush(
  payload: GitHubPushPayload,
  options: InspectGitHubPushOptions = {},
): Promise<ChangeObservation> {
  githubPushPayloadSchema.parse(payload);
  const maxResponseBytes = options.maxResponseBytes ?? MAX_COMPARE_BYTES;
  assertPositiveInteger(maxResponseBytes, "maxResponseBytes");
  const sourceSizeBytes =
    payload.repository.size === undefined ? null : payload.repository.size * 1024;

  if (payload.deleted) return createObservation(payload, sourceSizeBytes, true, 0, 0);

  if (payload.created || isZeroOid(payload.before)) {
    return createObservation(
      payload,
      sourceSizeBytes,
      false,
      payload.commits?.length ?? null,
      null,
    );
  }

  if (!payload.ref.startsWith("refs/heads/") || payload.forced) {
    return incompleteObservation(payload, sourceSizeBytes);
  }

  const fetcher = options.fetch ?? globalThis.fetch;
  const base = options.apiUrl ?? "https://api.github.com";
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "User-Agent": GITHUB_USER_AGENT,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  });
  if (options.token !== undefined) headers.set("Authorization", `Bearer ${options.token}`);

  const response = await fetcher(
    `${base}/repos/${payload.repository.full_name}/compare/${payload.before}...${payload.after}`,
    { headers },
  );

  if (!response.ok) throw new Error(`GitHub compare failed with HTTP ${response.status}`);

  const text = await readBoundedText(response, maxResponseBytes);
  if (text === null) return incompleteObservation(payload, sourceSizeBytes);

  const comparison = compareResponseSchema.parse(JSON.parse(text));
  const estimate = estimatePatchBytes(comparison.files);
  const commitCount = comparison.total_commits ?? payload.commits?.length ?? null;
  return createObservation(
    payload,
    sourceSizeBytes,
    estimate.complete,
    commitCount,
    estimate.patchBytes,
  );
}

function createObservation(
  payload: GitHubPushPayload,
  sourceSizeBytes: number | null,
  complete: boolean,
  commitCount: number | null,
  estimatedPatchBytes: number | null,
): ChangeObservation {
  return {
    refs: [createRefChange(payload, commitCount, estimatedPatchBytes)],
    complete,
    sourceSizeBytes,
  };
}

function createRefChange(
  payload: GitHubPushPayload,
  commitCount: number | null,
  estimatedPatchBytes: number | null,
): RefChange {
  return {
    ref: payload.ref,
    before: isZeroOid(payload.before) ? null : payload.before,
    after: isZeroOid(payload.after) ? null : payload.after,
    destination: { status: "unchecked" },
    commitCount,
    estimatedPatchBytes,
    forced: payload.forced,
  };
}

function incompleteObservation(
  payload: GitHubPushPayload,
  sourceSizeBytes: number | null,
): ChangeObservation {
  return createObservation(payload, sourceSizeBytes, false, payload.commits?.length ?? null, null);
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string | null> {
  const contentLength = parseContentLength(response.headers.get("content-length"));
  if (contentLength !== null && contentLength > maxBytes) return null;
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for (;;) {
    // This loop consumes a bounded response stream; each read must finish before the next.
    // eslint-disable-next-line no-await-in-loop
    const chunk = await reader.read();
    if (chunk.done) break;
    byteLength += chunk.value.byteLength;
    if (byteLength > maxBytes) {
      // The bounded stream must be cancelled before returning early.
      // eslint-disable-next-line no-await-in-loop
      await reader.cancel("GitHub compare response exceeded maxResponseBytes");
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
  return new TextDecoder().decode(body);
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

function parseGitHubPush(body: Uint8Array<ArrayBuffer>): GitHubPushPayload | null {
  try {
    const result = githubPushPayloadSchema.safeParse(JSON.parse(new TextDecoder().decode(body)));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function estimatePatchBytes(files: readonly CompareFile[] | undefined): PatchEstimate {
  if (files === undefined || files.length >= MAX_COMPARE_FILES) {
    return { complete: false, patchBytes: null };
  }

  let patchBytes = 0;
  for (const file of files) {
    if (file.status === "removed") continue;
    if (file.patch === undefined || !patchHasAllChanges(file)) {
      return { complete: false, patchBytes: null };
    }
    patchBytes += new TextEncoder().encode(file.patch).byteLength;
  }
  return { complete: true, patchBytes };
}

function patchHasAllChanges(file: CompareFile): boolean {
  if (file.additions === undefined || file.deletions === undefined || file.patch === undefined) {
    return false;
  }
  let additions = 0;
  let deletions = 0;
  for (const line of file.patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return additions >= file.additions && deletions >= file.deletions;
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isZeroOid(oid: string): boolean {
  return /^0+$/.test(oid);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

export type { GitHubPushPayload };
