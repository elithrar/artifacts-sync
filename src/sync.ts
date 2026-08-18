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
} from "./types.js";

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
    syncOptions: SyncOptions = {},
  ): Promise<PreparedSync> {
    const [resolvedFrom, resolvedTo] = await Promise.all([
      options.resolver.resolve(from, "read"),
      options.resolver.resolve(to, "write"),
    ]);
    const pairKey = await createPairKey(resolvedFrom.identity, resolvedTo.identity);
    const mode = syncOptions.mode ?? (syncOptions.change === undefined ? "mirror" : "push");
    const observed =
      mode === "push" && syncOptions.change !== undefined
        ? await readDestinationRefs(syncOptions.change, resolvedTo, refReader)
        : syncOptions.change;
    const cacheWarm = (await options.workspace.hasCache?.(pairKey)) ?? false;
    const plan = planSync({
      mode,
      strategy: syncOptions.strategy ?? "auto",
      ...(syncOptions.limits === undefined ? {} : { limits: syncOptions.limits }),
      ...(observed === undefined ? {} : { change: observed }),
      cacheWarm,
    });

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
    async plan(from, to, syncOptions = {}): Promise<SyncPlan> {
      return (await prepare(from, to, syncOptions)).plan;
    },

    async sync(from, to, syncOptions = {}): Promise<SyncResult> {
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

async function readDestinationRefs(
  observation: ChangeObservation,
  destination: ExecutionContext["to"],
  reader: RefReader,
): Promise<ChangeObservation> {
  const refs = await Promise.all(
    observation.refs.map(async (change): Promise<RefChange> => {
      const current = await reader.read(destination, change.ref);
      const { before: _observedBefore, ...withoutBefore } = change;
      return {
        ...withoutBefore,
        ...(current === undefined ? {} : { before: current }),
      };
    }),
  );
  return { ...observation, refs };
}

async function createPairKey(from: string, to: string): Promise<string> {
  const value = new TextEncoder().encode(`${from}\n${to}`);
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
