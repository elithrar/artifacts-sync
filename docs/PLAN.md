# Plan

## Goal

Synchronize Git refs between GitHub and Cloudflare Artifacts after a push. Keep the public API directional and small:

```ts
await client.sync(from, to, options);
```

Bidirectional setups create two directional subscriptions. They are not conflict-merging systems.

## Decisions

- Synchronize the refs named by a push by default. Use `mode: "mirror"` explicitly for full reconciliation, including deletions and force updates.
- Read the destination ref before executing. If its object ID already equals the triggering object ID, return a no-op. This suppresses sync-generated webhook loops without modifying commits.
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
| Estimated Git patch bytes    |          16 MiB |
| Cold-cache source repository |          16 MiB |

The workspace strategy also requires a fast-forward update, complete inspection data, and either a warm pair cache or a source repository below the cold-cache limit. Any force push, mirror, truncation, binary/unknown patch, or unknown size selects the container.

GitHub push inspection uses the Compare API. It accepts a patch estimate only when every nondeleted file includes a complete patch. Cloudflare Artifacts push events currently expose commit counts but no byte estimate, so Artifacts-originated changes default to the container unless the caller supplies a trusted estimate.

## Runtime topology

1. A GitHub webhook Worker or `cf.artifacts.repo.pushed` event starts a Workflow.
2. A Workflow step normalizes and inspects the push.
3. A per-repository-pair Durable Object serializes execution and owns the Computer Workspace.
4. The planner selects no-op, Workspace Git, or Computer container Git.
5. A final Workflow step verifies the destination ref.

One Durable Object per ordered repository pair avoids cross-repository contention while preserving a small-path Git cache.

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

## Follow-ups before production

- Run repository-size and pack-memory benchmarks against real workloads.
- Add an Artifacts tree/blob-size inspector when the binding exposes a bounded object-reading API.
- Add cache eviction or rebuild policy because Computer's isomorphic-git pack cache is unbounded and has no `git gc` support.
- Pin and test Computer upgrades—the dependency is preview-only.
- Define conflict policy for simultaneous human pushes. The default remains fast-forward only; force reconciliation requires `mode: "mirror"` or an explicit container override.
