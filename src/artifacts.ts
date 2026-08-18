import { z } from "zod";

import { gitOidSchema, gitRefSchema } from "./schemas.js";
import type { ChangeObservation } from "./types.js";

export const artifactsPushEventSchema = z.object({
  type: z.literal("cf.artifacts.repo.pushed"),
  source: z.string().min(1),
  payload: z.object({
    ref: gitRefSchema,
    before: gitOidSchema,
    after: gitOidSchema,
    totalCommitsCount: z.number().int().nonnegative(),
    commitsTruncated: z.boolean(),
  }),
});

export type ArtifactsPushEvent = z.infer<typeof artifactsPushEventSchema>;

export interface ArtifactsPushEvidence {
  readonly estimatedPatchBytes?: number;
  readonly sourceSizeBytes?: number;
  /** Set only when ancestry was independently verified. */
  readonly forced?: boolean;
}

export function observeArtifactsPush(
  event: ArtifactsPushEvent,
  evidence: ArtifactsPushEvidence = {},
): ChangeObservation {
  artifactsPushEventSchema.parse(event);
  const payload = event.payload;
  assertOptionalNonNegativeInteger(evidence.estimatedPatchBytes, "estimatedPatchBytes");
  assertOptionalNonNegativeInteger(evidence.sourceSizeBytes, "sourceSizeBytes");
  return {
    refs: [
      {
        ref: payload.ref,
        before: isZeroOid(payload.before) ? null : payload.before,
        after: isZeroOid(payload.after) ? null : payload.after,
        destination: { status: "unchecked" },
        commitCount: payload.totalCommitsCount,
        estimatedPatchBytes: evidence.estimatedPatchBytes ?? null,
        forced: evidence.forced ?? null,
      },
    ],
    complete: !payload.commitsTruncated,
    sourceSizeBytes: evidence.sourceSizeBytes ?? null,
  };
}

function assertOptionalNonNegativeInteger(value: number | undefined, name: string): void {
  if (value !== undefined) assertNonNegativeInteger(value, name);
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function isZeroOid(oid: string): boolean {
  return /^0+$/.test(oid);
}
