import type { ChangeObservation } from "./types.js";

const ZERO_OID = "0000000000000000000000000000000000000000";

export interface ArtifactsPushEvent {
  readonly payload: {
    readonly ref: string;
    readonly before: string;
    readonly after: string;
    readonly totalCommitsCount: number;
    readonly commitsTruncated: boolean;
  };
}

export interface ArtifactsPushEvidence {
  readonly estimatedBytes?: number;
  readonly sourceSizeBytes?: number;
  /** Set only when ancestry was independently verified. */
  readonly forced?: boolean;
}

export function observeArtifactsPush(
  event: ArtifactsPushEvent,
  evidence: ArtifactsPushEvidence = {},
): ChangeObservation {
  const payload = event.payload;
  return {
    refs: [
      {
        ref: payload.ref,
        ...(payload.before === ZERO_OID ? {} : { before: payload.before }),
        ...(payload.after === ZERO_OID ? {} : { after: payload.after }),
        commitCount: payload.totalCommitsCount,
        ...(evidence.estimatedBytes === undefined
          ? {}
          : { estimatedBytes: evidence.estimatedBytes }),
        ...(evidence.forced === undefined ? {} : { forced: evidence.forced }),
      },
    ],
    ...(payload.commitsTruncated ? { truncated: true } : {}),
    ...(evidence.sourceSizeBytes === undefined
      ? {}
      : { sourceSizeBytes: evidence.sourceSizeBytes }),
  };
}
