import { z } from "zod";

import { githubPushPayloadSchema, type GitHubPushPayload } from "./schemas.js";
import type { ChangeObservation, RefChange } from "./types.js";

const MAX_COMPARE_BYTES = 20 * 1024 * 1024;
const MAX_COMPARE_FILES = 300;

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

  const fetcher = options.fetch ?? globalThis.fetch;
  const base = options.apiUrl ?? "https://api.github.com";
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
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
