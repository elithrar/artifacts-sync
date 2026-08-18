import { planSync } from "./plan.js";
import { createRemoteRefReader } from "./ref-reader.js";
import type {
  ChangeObservation,
  ExecutionContext,
  RefChange,
  RefReader,
  Repository,
  RepositoryResolver,
  SyncClient,
  SyncExecutor,
  SyncOptions,
  SyncPlan,
  SyncResult,
  SyncLimits,
} from "./types.js";
import type { PlanSyncInput } from "./plan.js";

export interface CreateSyncClientOptions {
  readonly resolver: RepositoryResolver;
  readonly workspace: SyncExecutor;
  readonly container: SyncExecutor;
  readonly refs?: RefReader;
}

interface PreparedSync {
  readonly plan: SyncPlan;
  readonly context: ExecutionContext;
}

export function createSyncClient(options: CreateSyncClientOptions): SyncClient {
  const refReader = options.refs ?? createRemoteRefReader();

  async function prepare(
    from: Repository,
    to: Repository,
    syncOptions: SyncOptions,
  ): Promise<PreparedSync> {
    const [resolvedFrom, resolvedTo] = await Promise.all([
      options.resolver.resolve(from, "read"),
      options.resolver.resolve(to, "write"),
    ]);
    if (resolvedFrom.identity === resolvedTo.identity) {
      throw new Error("Source and destination repositories must be different");
    }
    const pairKey = await createPairKey(resolvedFrom.identity, resolvedTo.identity);
    const mode = syncOptions.mode ?? "push";
    if (mode === "push" && syncOptions.change === undefined) {
      throw new Error(
        'Push sync requires a change observation; use { mode: "mirror" } for a full mirror',
      );
    }
    const observed =
      mode === "push" && syncOptions.change !== undefined
        ? await readCurrentRefs(syncOptions.change, resolvedFrom, resolvedTo, refReader)
        : syncOptions.change;
    const cacheWarm =
      observed === undefined || observed.refs.length === 0
        ? false
        : ((await options.workspace.hasCache?.(pairKey, observed.refs)) ?? false);
    const plan = planSync(
      createPlanInput(
        mode,
        syncOptions.strategy ?? "auto",
        syncOptions.limits,
        observed,
        cacheWarm,
      ),
    );

    return {
      plan,
      context: {
        from: resolvedFrom,
        to: resolvedTo,
        pairKey,
      },
    };
  }

  return {
    async plan(from, to, syncOptions): Promise<SyncPlan> {
      return (await prepare(from, to, syncOptions)).plan;
    },

    async sync(from, to, syncOptions): Promise<SyncResult> {
      const prepared = await prepare(from, to, syncOptions);
      if (prepared.plan.strategy === "noop") {
        return { plan: prepared.plan, executed: false };
      }
      const executor =
        prepared.plan.strategy === "workspace" ? options.workspace : options.container;
      const result = await executor.execute(prepared.plan, prepared.context);
      return { plan: prepared.plan, executed: true, result };
    },
  };
}

async function readCurrentRefs(
  observation: ChangeObservation,
  source: ExecutionContext["from"],
  destination: ExecutionContext["to"],
  reader: RefReader,
): Promise<ChangeObservation> {
  const inspected = await Promise.all(
    observation.refs.map(async (change): Promise<RefChange | null> => {
      const [currentSource, currentDestination] = await Promise.all([
        reader.read(source, change.ref),
        reader.read(destination, change.ref),
      ]);
      if (!sameOid(currentSource, change.after)) return null;
      return {
        ...change,
        destination:
          currentDestination === null
            ? { status: "missing" }
            : { status: "present", oid: currentDestination },
      };
    }),
  );
  const refs = inspected.filter((change): change is RefChange => change !== null);
  return { ...observation, refs };
}

function sameOid(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  return left.toLowerCase() === right.toLowerCase();
}

function createPlanInput(
  mode: PlanSyncInput["mode"],
  strategy: PlanSyncInput["strategy"],
  limits: Partial<SyncLimits> | undefined,
  change: ChangeObservation | undefined,
  cacheWarm: boolean,
): PlanSyncInput {
  if (mode === "mirror") {
    if (limits === undefined) return { mode, strategy, cacheWarm };
    return { mode, strategy, limits, cacheWarm };
  }
  if (change === undefined) throw new Error("Push sync requires a change observation");
  if (limits === undefined) {
    return { mode, strategy, change, cacheWarm };
  }
  return { mode, strategy, limits, change, cacheWarm };
}

async function createPairKey(from: string, to: string): Promise<string> {
  const value = new TextEncoder().encode(`${from}\n${to}`);
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
