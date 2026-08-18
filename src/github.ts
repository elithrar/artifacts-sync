import type { ChangeObservation, RefChange } from "./types.js";

const ZERO_OID = "0000000000000000000000000000000000000000";
const MAX_COMPARE_BYTES = 20 * 1024 * 1024;

export interface GitHubPushPayload {
  readonly ref: string;
  readonly before: string;
  readonly after: string;
  readonly forced: boolean;
  readonly created?: boolean;
  readonly deleted?: boolean;
  readonly commits?: readonly unknown[];
  readonly repository: {
    readonly full_name: string;
    /** GitHub reports this field in KiB. */
    readonly size?: number;
  };
}

export interface InspectGitHubPushOptions {
  readonly token?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly apiUrl?: string;
  readonly maxResponseBytes?: number;
}

interface CompareFile {
  readonly status?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly patch?: string;
}

interface CompareResponse {
  readonly total_commits?: number;
  readonly files?: readonly CompareFile[];
}

export async function inspectGitHubPush(
  payload: GitHubPushPayload,
  options: InspectGitHubPushOptions = {},
): Promise<ChangeObservation> {
  const sourceSizeBytes =
    payload.repository.size === undefined ? undefined : payload.repository.size * 1024;

  if (payload.deleted) {
    return {
      refs: [
        createRefChange(payload, {
          commitCount: 0,
          estimatedBytes: 0,
        }),
      ],
      ...(sourceSizeBytes === undefined ? {} : { sourceSizeBytes }),
    };
  }

  if (payload.created || payload.before === ZERO_OID) {
    const commitEstimate =
      payload.commits === undefined ? {} : { commitCount: payload.commits.length };
    return {
      refs: [createRefChange(payload, commitEstimate)],
      truncated: true,
      ...(sourceSizeBytes === undefined ? {} : { sourceSizeBytes }),
    };
  }

  const fetcher = options.fetch ?? globalThis.fetch;
  const base = options.apiUrl ?? "https://api.github.com";
  const response = await fetcher(
    `${base}/repos/${payload.repository.full_name}/compare/${payload.before}...${payload.after}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
      },
    },
  );

  if (!response.ok) {
    throw new Error(`GitHub compare failed with HTTP ${response.status}`);
  }

  const contentLength = parseContentLength(response.headers.get("content-length"));
  if (contentLength > (options.maxResponseBytes ?? MAX_COMPARE_BYTES)) {
    return incompleteObservation(payload, sourceSizeBytes);
  }

  const comparison = parseCompareResponse(await response.json());
  const estimate = estimatePatchBytes(comparison.files);
  const commitCount = comparison.total_commits ?? payload.commits?.length;
  const ref = createRefChange(payload, {
    ...(commitCount === undefined ? {} : { commitCount }),
    ...(estimate.bytes === undefined ? {} : { estimatedBytes: estimate.bytes }),
  });

  return {
    refs: [ref],
    ...(estimate.complete ? {} : { truncated: true }),
    ...(sourceSizeBytes === undefined ? {} : { sourceSizeBytes }),
  };
}

function createRefChange(
  payload: GitHubPushPayload,
  estimate: { commitCount?: number; estimatedBytes?: number },
): RefChange {
  return {
    ref: payload.ref,
    ...(payload.before === ZERO_OID ? {} : { before: payload.before }),
    ...(payload.after === ZERO_OID ? {} : { after: payload.after }),
    forced: payload.forced,
    ...estimate,
  };
}

function incompleteObservation(
  payload: GitHubPushPayload,
  sourceSizeBytes: number | undefined,
): ChangeObservation {
  const commitEstimate =
    payload.commits === undefined ? {} : { commitCount: payload.commits.length };
  return {
    refs: [createRefChange(payload, commitEstimate)],
    truncated: true,
    ...(sourceSizeBytes === undefined ? {} : { sourceSizeBytes }),
  };
}

function parseCompareResponse(value: unknown): CompareResponse {
  if (!isRecord(value)) return {};
  const totalCommits = typeof value.total_commits === "number" ? value.total_commits : undefined;
  const files = Array.isArray(value.files)
    ? value.files.flatMap((file): CompareFile[] => {
        if (!isRecord(file)) return [];
        return [
          {
            ...(typeof file.status === "string" ? { status: file.status } : {}),
            ...(typeof file.additions === "number" ? { additions: file.additions } : {}),
            ...(typeof file.deletions === "number" ? { deletions: file.deletions } : {}),
            ...(typeof file.patch === "string" ? { patch: file.patch } : {}),
          },
        ];
      })
    : undefined;
  return {
    ...(totalCommits === undefined ? {} : { total_commits: totalCommits }),
    ...(files === undefined ? {} : { files }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function estimatePatchBytes(files: readonly CompareFile[] | undefined): {
  readonly complete: boolean;
  readonly bytes?: number;
} {
  if (files === undefined || files.length >= 300) return { complete: false };

  let bytes = 0;
  for (const file of files) {
    if (file.status === "removed") continue;
    if (file.patch === undefined || !patchHasAllChanges(file)) {
      return { complete: false };
    }
    bytes += new TextEncoder().encode(file.patch).byteLength;
  }
  return { complete: true, bytes };
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

function parseContentLength(value: string | null): number {
  if (value === null) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
