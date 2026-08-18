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
  const sourceMovedMessage = shellQuote(`Source ref moved after sync planning: ${change.ref}`);
  if (change.after === null) {
    const lease = forceWithLease(change);
    return `set +e
source_git ls-remote --exit-code "$SYNC_SOURCE_URL" ${ref} >/dev/null
source_status=$?
set -e
if [ "$source_status" -eq 0 ]; then
  echo ${sourceMovedMessage} >&2
  exit 75
elif [ "$source_status" -ne 2 ]; then
  exit "$source_status"
fi
target_git -C "$workdir/repo.git" push ${lease} "$SYNC_TARGET_URL" :${ref}`;
  }

  const seedRef = shellQuote(`refs/artifacts-sync/target/${encodeRef(change.ref)}`);
  const expectedSourceOid = shellQuote(change.after);
  const updateProtection = change.forced === true ? ` ${forceWithLease(change)}` : "";
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
source_oid="$(git -C "$workdir/repo.git" rev-parse ${ref})"
if [ "$source_oid" != ${expectedSourceOid} ]; then
  echo ${sourceMovedMessage} >&2
  exit 75
fi
target_git -C "$workdir/repo.git" push${updateProtection} "$SYNC_TARGET_URL" ${ref}:${ref}`;
}

function forceWithLease(change: RefChange): string {
  if (change.destination.status === "unchecked") {
    throw new Error(`Cannot update ${change.ref} before reading the destination ref`);
  }
  if (change.destination.status === "present" && !sameOid(change.destination.oid, change.before)) {
    throw new Error(`Cannot destructively update diverged destination ref ${change.ref}`);
  }
  const expected = change.destination.status === "present" ? change.destination.oid : "";
  return shellQuote(`--force-with-lease=${change.ref}:${expected}`);
}

function sameOid(left: string, right: string | null): boolean {
  return right !== null && left.toLowerCase() === right.toLowerCase();
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
