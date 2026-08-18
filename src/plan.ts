import { gitOidSchema, gitRefSchema } from "./schemas.js";
import type {
  ChangeObservation,
  RefChange,
  SyncEstimate,
  SyncLimits,
  SyncMode,
  SyncPlan,
  SyncStrategy,
} from "./types.js";

export const DEFAULT_SYNC_LIMITS: SyncLimits = Object.freeze({
  refs: 3,
  commits: 50,
  patchBytes: 16 * 1024 * 1024,
  coldSourceBytes: 16 * 1024 * 1024,
});

interface PlanSyncBehavior {
  readonly strategy: SyncStrategy;
  readonly limits?: Partial<SyncLimits>;
  readonly cacheWarm: boolean;
}

interface PlanPushSyncInput extends PlanSyncBehavior {
  readonly change: ChangeObservation;
  readonly mode: "push";
}

interface PlanMirrorSyncInput extends PlanSyncBehavior {
  readonly change?: never;
  readonly mode: "mirror";
}

export type PlanSyncInput = PlanPushSyncInput | PlanMirrorSyncInput;

export function planSync(input: PlanSyncInput): SyncPlan {
  const limits: SyncLimits = { ...DEFAULT_SYNC_LIMITS, ...input.limits };
  validateLimits(limits);
  if (input.change !== undefined) validateObservation(input.change);
  if (input.mode === "push" && input.change === undefined) {
    throw new Error("Push sync requires a change observation");
  }

  const refs = input.change?.refs ?? [];
  const estimate = estimateChange(input.change, input.cacheWarm);

  if (input.mode === "push" && refs.length === 0) {
    return createPlan(
      input.mode,
      refs,
      estimate,
      limits,
      "noop",
      "No current ref changes remain",
      false,
    );
  }

  if (input.mode === "push" && refs.length > 0 && refs.every(isNoop)) {
    return createPlan(
      input.mode,
      refs,
      estimate,
      limits,
      "noop",
      "Destination refs already match the requested objects",
      false,
    );
  }

  if (input.strategy !== "auto") {
    validateStrategyCapability(input.strategy, input.mode, refs);
    return createPlan(
      input.mode,
      refs,
      estimate,
      limits,
      input.strategy,
      `Strategy explicitly set to ${input.strategy}`,
      true,
    );
  }

  const largeReason = automaticContainerReason(input, limits);
  if (largeReason !== null) {
    return createPlan(input.mode, refs, estimate, limits, "container", largeReason, false);
  }

  return createPlan(
    input.mode,
    refs,
    estimate,
    limits,
    "workspace",
    input.cacheWarm
      ? "Bounded fast-forward change with a warm Workspace cache"
      : "Bounded fast-forward change in a small source repository",
    false,
  );
}

function createPlan(
  mode: SyncMode,
  refs: readonly RefChange[],
  estimate: SyncEstimate,
  limits: SyncLimits,
  strategy: SyncPlan["strategy"],
  reason: string,
  overridden: boolean,
): SyncPlan {
  return { mode, refs, estimate, limits, strategy, reason, overridden };
}

function validateStrategyCapability(
  strategy: Exclude<SyncStrategy, "auto">,
  mode: SyncMode,
  refs: readonly RefChange[],
): void {
  if (strategy === "workspace" && mode === "mirror") {
    throw new Error("The workspace strategy cannot mirror repositories; use container");
  }
  if (strategy === "workspace" && refs.some(usesSha256)) {
    throw new Error("The workspace strategy supports SHA-1 repositories only; use container");
  }
}

function automaticContainerReason(input: PlanSyncInput, limits: SyncLimits): string | null {
  if (input.mode === "mirror") return "Full mirrors require native Git";
  if (input.change === undefined || input.change.refs.length === 0) {
    return "No bounded push observation was supplied";
  }
  if (!input.change.complete) return "Push inspection was truncated or incomplete";
  if (input.change.refs.length > limits.refs) {
    return `Changed ref count exceeds the workspace limit of ${limits.refs}`;
  }
  if (input.change.refs.some(usesSha256)) {
    return "SHA-256 object IDs require native Git";
  }
  if (input.change.refs.some((change) => change.forced !== false)) {
    return "Force-push status is true or unknown";
  }

  const commits = sumKnown(input.change.refs, "commitCount");
  if (commits === null) return "Commit count is unknown";
  if (commits > limits.commits) {
    return `Commit count exceeds the workspace limit of ${limits.commits}`;
  }

  const patchBytes = sumKnown(input.change.refs, "estimatedPatchBytes");
  if (patchBytes === null) return "Patch byte estimate is unknown";
  if (patchBytes > limits.patchBytes) {
    return `Estimated patch bytes exceed the workspace limit of ${limits.patchBytes}`;
  }

  const needsSourceObjects = input.change.refs.some((change) => change.after !== null);
  if (!input.cacheWarm && needsSourceObjects) {
    if (input.change.sourceSizeBytes === null) {
      return "Cold Workspace cache and source repository size is unknown";
    }
    if (input.change.sourceSizeBytes > limits.coldSourceBytes) {
      return `Cold source repository exceeds the workspace limit of ${limits.coldSourceBytes} bytes`;
    }
  }
  return null;
}

function estimateChange(change: ChangeObservation | undefined, cacheWarm: boolean): SyncEstimate {
  if (change === undefined) {
    return {
      refs: null,
      commits: null,
      patchBytes: null,
      sourceBytes: null,
      cacheWarm,
    };
  }
  return {
    refs: change.refs.length,
    commits: sumKnown(change.refs, "commitCount"),
    patchBytes: sumKnown(change.refs, "estimatedPatchBytes"),
    sourceBytes: change.sourceSizeBytes,
    cacheWarm,
  };
}

function sumKnown(
  refs: readonly RefChange[],
  key: "commitCount" | "estimatedPatchBytes",
): number | null {
  let total = 0;
  for (const ref of refs) {
    const value = ref[key];
    if (value === null) return null;
    total += value;
  }
  return total;
}

function isNoop(change: RefChange): boolean {
  if (change.after === null) return change.destination.status === "missing";
  return (
    change.destination.status === "present" &&
    change.destination.oid.toLowerCase() === change.after.toLowerCase()
  );
}

function usesSha256(change: RefChange): boolean {
  if (change.before?.length === 64 || change.after?.length === 64) return true;
  return change.destination.status === "present" && change.destination.oid.length === 64;
}

function validateLimits(limits: SyncLimits): void {
  validatePositiveInteger(limits.refs, "limits.refs");
  validatePositiveInteger(limits.commits, "limits.commits");
  validatePositiveInteger(limits.patchBytes, "limits.patchBytes");
  validatePositiveInteger(limits.coldSourceBytes, "limits.coldSourceBytes");
}

function validateObservation(observation: ChangeObservation): void {
  validateOptionalNonNegativeInteger(observation.sourceSizeBytes, "change.sourceSizeBytes");
  const uniqueRefs = new Set<string>();
  for (const change of observation.refs) {
    gitRefSchema.parse(change.ref);
    if (uniqueRefs.has(change.ref)) throw new Error(`Duplicate ref change: ${change.ref}`);
    uniqueRefs.add(change.ref);
    validateOptionalOid(change.before);
    validateOptionalOid(change.after);
    if (change.destination.status === "present") validateObjectOid(change.destination.oid);
    validateOptionalNonNegativeInteger(change.commitCount, "change.commitCount");
    validateOptionalNonNegativeInteger(change.estimatedPatchBytes, "change.estimatedPatchBytes");
  }
}

function validateOptionalOid(value: string | null): void {
  if (value !== null) validateObjectOid(value);
}

function validateObjectOid(value: string): void {
  gitOidSchema.parse(value);
  if (/^0+$/.test(value)) throw new Error("Git object OIDs cannot be all zeroes; use null");
}

function validateOptionalNonNegativeInteger(value: number | null, name: string): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError(`${name} must be null or a non-negative safe integer`);
  }
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
