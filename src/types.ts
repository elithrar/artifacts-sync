export type SyncStrategy = "auto" | "workspace" | "container";
export type PlannedStrategy = "noop" | "workspace" | "container";
export type SyncMode = "push" | "mirror";
export type RepositoryAccess = "read" | "write";

export interface GitHubRepository {
  readonly kind: "github";
  readonly owner: string;
  readonly repo: string;
}

export interface ArtifactsRepository {
  readonly kind: "artifacts";
  readonly namespace: string;
  readonly name: string;
}

export interface GitRepository {
  readonly kind: "git";
  readonly url: string;
  readonly identity?: string;
  readonly authorization?: string;
}

export type Repository = GitHubRepository | ArtifactsRepository | GitRepository;

export interface ResolvedRepository {
  readonly identity: string;
  readonly url: string;
  /** Sensitive. Executors must not include this value in plans or logs. */
  readonly authorization?: string;
}

export interface RepositoryResolver {
  resolve(repository: Repository, access: RepositoryAccess): Promise<ResolvedRepository>;
}

export type DestinationRefState =
  | { readonly status: "unchecked" }
  | { readonly status: "missing" }
  | { readonly status: "present"; readonly oid: string };

export interface RefChange {
  readonly ref: string;
  /** Source object before the push, or null when the ref was created. */
  readonly before: string | null;
  /** Source object after the push, or null when the ref was deleted. */
  readonly after: string | null;
  /** Current destination state. Filled by SyncClient before planning. */
  readonly destination: DestinationRefState;
  readonly commitCount: number | null;
  /** UTF-8 bytes in complete GitHub patches; not an estimate of Git pack size. */
  readonly estimatedPatchBytes: number | null;
  /** Null means ancestry was not independently established. */
  readonly forced: boolean | null;
}

export interface ChangeObservation {
  readonly refs: readonly RefChange[];
  readonly complete: boolean;
  readonly sourceSizeBytes: number | null;
}

export interface SyncLimits {
  readonly refs: number;
  readonly commits: number;
  readonly patchBytes: number;
  readonly coldSourceBytes: number;
}

interface SyncBehaviorOptions {
  readonly limits?: Partial<SyncLimits>;
  readonly strategy?: SyncStrategy;
}

export interface PushSyncOptions extends SyncBehaviorOptions {
  readonly mode?: "push";
  readonly change: ChangeObservation;
}

export interface MirrorSyncOptions extends SyncBehaviorOptions {
  readonly mode: "mirror";
  readonly change?: never;
}

export type SyncOptions = PushSyncOptions | MirrorSyncOptions;

export interface SyncEstimate {
  readonly refs: number | null;
  readonly commits: number | null;
  readonly patchBytes: number | null;
  readonly sourceBytes: number | null;
  readonly cacheWarm: boolean;
}

export interface SyncPlan {
  readonly strategy: PlannedStrategy;
  readonly mode: SyncMode;
  readonly reason: string;
  readonly refs: readonly RefChange[];
  readonly estimate: SyncEstimate;
  readonly limits: SyncLimits;
  readonly overridden: boolean;
}

export interface ExecutionContext {
  readonly from: ResolvedRepository;
  readonly to: ResolvedRepository;
  readonly pairKey: string;
}

export interface ExecutorResult {
  readonly refs: readonly string[];
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface SyncExecutor {
  /** True only when every required source base object is present locally. */
  hasCache?(pairKey: string, refs: readonly RefChange[]): Promise<boolean>;
  execute(plan: SyncPlan, context: ExecutionContext): Promise<ExecutorResult>;
}

export interface RefReader {
  read(repository: ResolvedRepository, ref: string): Promise<string | null>;
}

export interface SkippedSyncResult {
  readonly plan: SyncPlan;
  readonly executed: false;
}

export interface ExecutedSyncResult {
  readonly plan: SyncPlan;
  readonly executed: true;
  readonly result: ExecutorResult;
}

export type SyncResult = SkippedSyncResult | ExecutedSyncResult;

export interface SyncClient {
  plan(from: Repository, to: Repository, options: SyncOptions): Promise<SyncPlan>;
  sync(from: Repository, to: Repository, options: SyncOptions): Promise<SyncResult>;
}
