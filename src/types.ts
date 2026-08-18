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

export interface RefChange {
  readonly ref: string;
  readonly before?: string;
  readonly after?: string;
  readonly commitCount?: number;
  readonly estimatedBytes?: number;
  readonly forced?: boolean;
}

export interface ChangeObservation {
  readonly refs: readonly RefChange[];
  readonly truncated?: boolean;
  readonly sourceSizeBytes?: number;
}

export interface SyncLimits {
  readonly refs: number;
  readonly commits: number;
  readonly bytes: number;
  readonly coldSourceBytes: number;
}

export interface SyncOptions {
  readonly change?: ChangeObservation;
  readonly limits?: Partial<SyncLimits>;
  readonly mode?: SyncMode;
  readonly strategy?: SyncStrategy;
}

export interface SyncEstimate {
  readonly refs?: number;
  readonly commits?: number;
  readonly bytes?: number;
  readonly sourceBytes?: number;
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
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface SyncExecutor {
  hasCache?(pairKey: string): Promise<boolean>;
  execute(plan: SyncPlan, context: ExecutionContext): Promise<ExecutorResult>;
}

export interface RefReader {
  read(repository: ResolvedRepository, ref: string): Promise<string | undefined>;
}

export interface SyncResult {
  readonly plan: SyncPlan;
  readonly executed: boolean;
  readonly result?: ExecutorResult;
}

export interface SyncClient {
  plan(from: Repository, to: Repository, options?: SyncOptions): Promise<SyncPlan>;
  sync(from: Repository, to: Repository, options?: SyncOptions): Promise<SyncResult>;
}
