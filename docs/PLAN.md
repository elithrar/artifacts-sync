# Plan

## Goal

Synchronize Git refs between GitHub and Cloudflare Artifacts after a push. Keep the public API directional and small:

```ts
await client.sync(from, to, options);
```

Bidirectional setups create two directional subscriptions. They are not conflict-merging systems.

## Decisions

- Synchronize the refs named by a push by default. Use `mode: "mirror"` explicitly for full reconciliation, including deletions and force updates.
- Read source and destination refs before executing. Drop stale events whose source ref has already moved, and return a no-op when the destination already equals the triggering object. This prevents out-of-order delivery from regressing refs and suppresses sync-generated webhook loops without modifying commits.
- Use a persistent `@cloudflare/computer` Workspace and its isomorphic-git client only for bounded changes.
- Use the Computer container backend and native Git for full, large, forced, or uncertain transfers.
- Treat missing evidence as large. Commit count is never a byte-size estimate.
- Keep Computer behind executor interfaces because the package is currently preview-only and its API is unstable.

## Automatic strategy

The initial workspace limits are:

| Signal                       | Workspace limit |
| ---------------------------- | --------------: |
| Changed refs                 |               3 |
| New commits                  |              50 |
| Complete UTF-8 patch bytes   |          16 MiB |
| Cold-cache source repository |          16 MiB |

The workspace strategy also requires a fast-forward update, complete inspection data, and either every source base object in the ordered pair cache or a source repository below the cold-cache limit. Cache-directory existence alone is not warm evidence. Ref deletions do not need source objects. Any force push, mirror, truncation, binary/unknown patch, or unknown size selects the container.

GitHub push inspection uses the Compare API. It accepts a patch estimate only when every nondeleted file includes a complete patch and bounds the streamed response even when `Content-Length` is absent or wrong. Patch bytes are a routing signal, not Git pack bytes. Cloudflare Artifacts push events currently expose commit counts but no byte estimate, so Artifacts-originated changes default to the container unless the caller supplies trusted `estimatedPatchBytes` evidence.

## Runtime topology

1. A GitHub webhook Worker or `cf.artifacts.repo.pushed` event starts a Workflow.
2. The webhook boundary validates the payload; GitHub pushes are inspected in the pair coordinator.
3. A Durable Object for the configured pair serializes both directions and owns the Computer Workspace.
4. The client confirms source refs still match the event, then reads destination refs without overwriting source push history.
5. The planner selects no-op, Workspace Git, or Computer container Git, then executes the plan.

One Durable Object per configured repository pair avoids cross-repository contention and prevents opposite directions from executing concurrently. Computer keeps a separate ordered cache for each direction inside that coordinator.

## API

```ts
const client = createSyncClient({
  resolver,
  workspace: createComputerWorkspaceExecutor(workspace),
  container: createComputerContainerExecutor(workspace),
});

const plan = await client.plan(from, to, { change });
const result = await client.sync(from, to, { change });
```

`strategy: "workspace" | "container"` is available as an explicit override. Overrides remain visible in the returned plan.

The third argument is required: pass a push `change` observation or `{ mode: "mirror" }`. The type contract prevents an omitted option from silently becoming a destructive mirror. The Workspace override rejects mirrors and SHA-256 repositories because Computer's current isomorphic-git path supports SHA-1 objects only.

## Follow-ups before production

- Run repository-size and pack-memory benchmarks against real workloads.
- Add an Artifacts tree/blob-size inspector when the binding exposes a bounded object-reading API.
- Add cache eviction or rebuild policy because Computer's isomorphic-git pack cache is unbounded and has no `git gc` support.
- Pin and test Computer upgrades—the dependency is preview-only.
- Define conflict policy for simultaneous human pushes. The default remains fast-forward only; force reconciliation requires `mode: "mirror"` or an explicit container override.
- Add post-push destination verification when the upstream APIs expose a cheap, reliable consistency signal.
