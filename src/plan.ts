import type {
  ChangeObservation,
  RefChange,
  SyncLimits,
  SyncMode,
  SyncPlan,
  SyncStrategy,
} from "./types.js";

export const DEFAULT_SYNC_LIMITS: SyncLimits = Object.freeze({
  refs: 3,
  commits: 50,
  bytes: 16 * 1024 * 1024,
  coldSourceBytes: 16 * 1024 * 1024,
});

export interface PlanSyncInput {
  readonly change?: ChangeObservation;
  readonly mode: SyncMode;
  readonly strategy: SyncStrategy;
  readonly limits?: Partial<SyncLimits>;
  readonly cacheWarm: boolean;
}

export function planSync(input: PlanSyncInput): SyncPlan {
  const limits = { ...DEFAULT_SYNC_LIMITS, ...input.limits };
  const refs = input.change?.refs ?? [];
  const estimate = estimateChange(input.change, input.cacheWarm);
  const base = {
    mode: input.mode,
    refs,
    estimate,
    limits,
  } as const;

  if (input.mode === "push" && refs.length > 0 && refs.every(isNoop)) {
    return {
      ...base,
      strategy: "noop",
      reason: "Destination refs already match the requested objects",
      overridden: false,
    };
  }

  if (input.strategy !== "auto") {
    return {
      ...base,
      strategy: input.strategy,
      reason: `Strategy explicitly set to ${input.strategy}`,
      overridden: true,
    };
  }

  const largeReason = automaticContainerReason(input, limits);
  if (largeReason !== undefined) {
    return {
      ...base,
      strategy: "container",
      reason: largeReason,
      overridden: false,
    };
  }

  return {
    ...base,
    strategy: "workspace",
    reason: input.cacheWarm
      ? "Bounded fast-forward change with a warm Workspace cache"
      : "Bounded fast-forward change in a small source repository",
    overridden: false,
  };
}

function automaticContainerReason(input: PlanSyncInput, limits: SyncLimits): string | undefined {
  if (input.mode === "mirror") return "Full mirrors require native Git";
  if (input.change === undefined || input.change.refs.length === 0) {
    return "No bounded push observation was supplied";
  }
  if (input.change.truncated) return "Push inspection was truncated or incomplete";
  if (input.change.refs.length > limits.refs) {
    return `Changed ref count exceeds the workspace limit of ${limits.refs}`;
  }
  if (input.change.refs.some((change) => change.forced !== false)) {
    return "Force-push status is true or unknown";
  }

  const commits = sumKnown(input.change.refs, "commitCount");
  if (commits === undefined) return "Commit count is unknown";
  if (commits > limits.commits) {
    return `Commit count exceeds the workspace limit of ${limits.commits}`;
  }

  const bytes = sumKnown(input.change.refs, "estimatedBytes");
  if (bytes === undefined) return "Transfer size is unknown";
  if (bytes > limits.bytes) {
    return `Estimated change exceeds the workspace limit of ${limits.bytes} bytes`;
  }

  if (!input.cacheWarm) {
    if (input.change.sourceSizeBytes === undefined) {
      return "Cold Workspace cache and source repository size is unknown";
    }
    if (input.change.sourceSizeBytes > limits.coldSourceBytes) {
      return `Cold source repository exceeds the workspace limit of ${limits.coldSourceBytes} bytes`;
    }
  }
  return undefined;
}

function estimateChange(
  change: ChangeObservation | undefined,
  cacheWarm: boolean,
): SyncPlan["estimate"] {
  if (change === undefined) return { cacheWarm };
  const commits = sumKnown(change.refs, "commitCount");
  const bytes = sumKnown(change.refs, "estimatedBytes");
  return {
    refs: change.refs.length,
    cacheWarm,
    ...(commits === undefined ? {} : { commits }),
    ...(bytes === undefined ? {} : { bytes }),
    ...(change.sourceSizeBytes === undefined ? {} : { sourceBytes: change.sourceSizeBytes }),
  };
}

function sumKnown(
  refs: readonly RefChange[],
  key: "commitCount" | "estimatedBytes",
): number | undefined {
  let total = 0;
  for (const ref of refs) {
    const value = ref[key];
    if (value === undefined) return undefined;
    total += value;
  }
  return total;
}

function isNoop(change: RefChange): boolean {
  return change.before === change.after;
}
