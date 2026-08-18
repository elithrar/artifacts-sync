import type {
  ExecutionContext,
  ExecutorResult,
  RefChange,
  SyncExecutor,
  SyncPlan,
} from "../types.js";

export interface ComputerContainerExecutorOptions {
  readonly backend?: string;
  readonly timeoutMs?: number;
}

export interface ComputerRuntimeLike {
  readonly exec: (
    source: string,
    options: {
      readonly backend: string;
      readonly encoding: "utf8";
      readonly timeoutMs: number;
      readonly env: Record<string, string>;
    },
  ) => Promise<{
    result(): Promise<{ exitCode: number; stdout: string; stderr: string }>;
    [Symbol.dispose]?(): void;
  }>;
}

export function createComputerContainerExecutor(
  workspace: { readonly runtime: ComputerRuntimeLike },
  options: ComputerContainerExecutorOptions = {},
): SyncExecutor {
  const backend = options.backend ?? "container";
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  if (backend.length === 0) throw new Error("Container backend must be non-empty");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Container timeoutMs must be a positive safe integer");
  }

  return {
    async execute(plan: SyncPlan, context: ExecutionContext): Promise<ExecutorResult> {
      if (plan.mode === "push" && plan.refs.length === 0) {
        throw new Error("The container executor requires at least one ref change for push mode");
      }
      const pendingRefs = plan.refs.filter((change) => !isSynchronized(change));
      if (plan.mode === "push" && pendingRefs.length === 0) {
        return { refs: [], detail: { backend } };
      }
      const command = buildCommand(plan, pendingRefs);
      const env = createEnvironment(context);
      const handle = await workspace.runtime.exec(command, {
        backend,
        encoding: "utf8",
        timeoutMs,
        env,
      });

      try {
        const result = await handle.result();
        if (result.exitCode !== 0) {
          throw new Error(`Native Git sync failed: ${result.stderr.trim()}`);
        }
        return {
          refs: pendingRefs.map((change) => change.ref),
          detail: { backend },
        };
      } finally {
        handle[Symbol.dispose]?.();
      }
    },
  };
}

function buildCommand(plan: SyncPlan, refs: readonly RefChange[]): string {
  const prelude = `set -eu
source_git() {
  if [ -n "\${SYNC_SOURCE_AUTHORIZATION:-}" ]; then
    git -c "http.extraHeader=$SYNC_SOURCE_AUTHORIZATION" "$@"
  else
    git "$@"
  fi
}
target_git() {
  if [ -n "\${SYNC_TARGET_AUTHORIZATION:-}" ]; then
    git -c "http.extraHeader=$SYNC_TARGET_AUTHORIZATION" "$@"
  else
    git "$@"
  fi
}
workdir="$(mktemp -d /tmp/artifacts-sync.XXXXXX)"
trap 'rm -rf "$workdir"' EXIT`;

  if (plan.mode === "mirror") {
    return `${prelude}
source_git clone --mirror "$SYNC_SOURCE_URL" "$workdir/repo.git"
target_git -C "$workdir/repo.git" push --mirror "$SYNC_TARGET_URL"`;
  }

  const commands = refs.map(buildRefCommands).join("\n");
  return `${prelude}
git init --bare "$workdir/repo.git"
${commands}`;
}

function isSynchronized(change: RefChange): boolean {
  if (change.after === null) return change.destination.status === "missing";
  return (
    change.destination.status === "present" &&
    change.destination.oid.toLowerCase() === change.after.toLowerCase()
  );
}

function buildRefCommands(change: RefChange): string {
  const ref = shellQuote(change.ref);
  if (change.after === null) {
    return `target_git -C "$workdir/repo.git" push "$SYNC_TARGET_URL" :${ref}`;
  }

  const seedRef = shellQuote(`refs/artifacts-sync/target/${encodeRef(change.ref)}`);
  const force = change.forced === true ? " --force" : "";
  return `set +e
target_git ls-remote --exit-code "$SYNC_TARGET_URL" ${ref} >/dev/null
target_status=$?
set -e
if [ "$target_status" -eq 0 ]; then
  target_git -C "$workdir/repo.git" fetch --no-tags "$SYNC_TARGET_URL" +${ref}:${seedRef}
elif [ "$target_status" -ne 2 ]; then
  exit "$target_status"
fi
source_git -C "$workdir/repo.git" fetch --no-tags "$SYNC_SOURCE_URL" +${ref}:${ref}
target_git -C "$workdir/repo.git" push${force} "$SYNC_TARGET_URL" ${ref}:${ref}`;
}

function createEnvironment(context: ExecutionContext) {
  return {
    SYNC_SOURCE_URL: context.from.url,
    SYNC_TARGET_URL: context.to.url,
    SYNC_SOURCE_AUTHORIZATION: context.from.authorization ?? "",
    SYNC_TARGET_AUTHORIZATION: context.to.authorization ?? "",
  };
}

function encodeRef(ref: string): string {
  return Array.from(new TextEncoder().encode(ref), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
