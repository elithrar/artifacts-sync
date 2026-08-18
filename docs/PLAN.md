# Plan

## Goal

Synchronize pushed Git refs between GitHub and Cloudflare Artifacts with a small, deployment-oriented API:

```ts
export default syncRepos({
  github: "elithrar/project",
  artifacts: "project",
  direction: "bidirectional",
});
```

One Worker can configure multiple independent repository pairs. Bidirectional pairs create two directional routes; they are not conflict-merging systems.

## Decisions

- Accept plain repository strings and validate them during module initialization. Keep normalized repository types internal.
- Accept one pair or an array of pairs.
- Treat `namespace/repo` as the stable Artifacts identity. A bare repository name means `default/repo`.
- Default the `default` namespace to the `ARTIFACTS` binding. Require an explicit `artifactsBinding` for other namespaces.
- Reject duplicate pairs, conflicting namespace bindings, and fan-out from a source repository.
- Synchronize only refs named by a push. Full repository mirroring is not part of the public API.
- Read source and destination refs before executing. Drop stale events whose source ref has moved and return a no-op when the destination already equals the triggering object.
- Verify the source ref again in the native-Git executor. Protect forced updates and deletions with `--force-with-lease`, and require a destructive destination update to still match the event's previous object. Divergent or concurrent destination pushes fail instead of being overwritten.
- Use a persistent `@cloudflare/computer` Workspace and its isomorphic-git client only for bounded changes.
- Use the Computer container backend and native Git for large, forced, or uncertain transfers.
- Treat missing evidence as large. Commit count is never a byte-size estimate.
- Keep Computer behind executor interfaces because the package is preview-only and its API is unstable.

## Automatic strategy

The initial Workspace limits are:

| Signal                       | Workspace limit |
| ---------------------------- | --------------: |
| Changed refs                 |               3 |
| New commits                  |              50 |
| Complete UTF-8 patch bytes   |          16 MiB |
| Cold-cache source repository |          16 MiB |

The Workspace strategy also requires a nondeleting, confirmed fast-forward update, complete inspection data, and either every source base object in the ordered pair cache or a source repository below the cold-cache limit. Cache-directory existence alone is not warm evidence. Any deletion, force push, truncation, binary or unknown patch, or unknown size selects the container.

GitHub push inspection uses the Compare API. It accepts a patch estimate only when every nondeleted file includes a complete patch and bounds the streamed response even when `Content-Length` is absent or wrong. Patch bytes are a routing signal, not Git pack bytes. Current Artifacts push events expose commit counts but no byte estimate, so Artifacts-originated changes default to the container.

## Runtime topology

1. The module initializes an immutable registry of validated repository pairs.
2. The returned Worker verifies GitHub webhooks and resolves `repository.full_name` to one pair.
3. Cloudflare sends `cf.artifacts.repo.pushed` events directly to the exported Workflow, which resolves `source.namespace` and `source.repoName` to one pair.
4. Each routed job carries the stable pair ID. Unconfigured Artifacts events return a no-op result.
5. A Durable Object named for that pair serializes both directions and owns its Computer Workspace.
6. The coordinator selects the Artifacts namespace binding configured for the pair and builds the internal repository resolver.
7. The sync engine confirms source refs still match the event, reads destination refs, plans the operation, and executes through the Workspace or container.

One Durable Object per pair prevents opposite directions from running concurrently without creating contention between unrelated pairs. Computer maintains a separate ordered cache for each direction inside that coordinator.

## Public API

```ts
import { syncRepos } from "@elithrar/artifacts-sync";

export { SyncCoordinator, SyncWorkflow, WorkspaceProxy } from "@elithrar/artifacts-sync";

export default syncRepos([
  {
    github: "elithrar/project-a",
    artifacts: "project-a",
    direction: "bidirectional",
  },
  {
    github: "elithrar/project-b",
    artifacts: "staging/project-b",
    artifactsBinding: "STAGING_ARTIFACTS",
    direction: "github-to-artifacts",
  },
]);
```

The root package exposes `syncRepos` and the three Cloudflare runtime classes required by Wrangler. Repository constructors, event schemas, planners, resolvers, executors, and the sync client remain implementation details.

`direction` accepts `"github-to-artifacts"`, `"artifacts-to-github"`, or `"bidirectional"`.

## Deployment configuration

- Every Artifacts namespace has its own Worker binding.
- `ARTIFACTS` is the default binding for the `default` namespace.
- One `GITHUB_TOKEN` must cover all configured GitHub repositories.
- GitHub repositories use one `GITHUB_WEBHOOK_SECRET` and send pushes to `/webhooks/github`.
- Artifacts push event filters target the shared Workflow and carry namespace and repository identity in the event.
- `SYNC_COORDINATOR` and `SYNC_WORKFLOW` remain conventional binding names.

## Follow-ups before production

- Run repository-size and pack-memory benchmarks against real workloads.
- Add an Artifacts tree or blob-size inspector when the binding exposes a bounded object-reading API.
- Add a cache eviction or rebuild policy because Computer's isomorphic-git pack cache is unbounded and has no `git gc` support.
- Pin and test Computer upgrades.
- Define a higher-level conflict-resolution policy for simultaneous human pushes. The current policy fails closed: fast-forwards may proceed, while destructive updates require the destination to match the source event's previous object.
- Add post-push destination verification when the upstream APIs expose a cheap, reliable consistency signal.

## Currently unsupported

- Fan-out from one source repository to multiple destinations.
