# artifacts-sync

`artifacts-sync` keeps GitHub and Cloudflare Artifacts repositories synchronized after either repository receives a push. One Worker can manage multiple independent repository pairs.

The library validates GitHub webhooks and Artifacts events, starts durable Workflows, serializes each pair through its own Durable Object, and chooses between a persistent Computer Workspace and native Git in a Computer container.

## Installation

```sh
pnpm add @elithrar/artifacts-sync
```

## Quick start

```ts
import { syncRepos } from "@elithrar/artifacts-sync";

export { SyncCoordinator, SyncWorkflow, WorkspaceProxy } from "@elithrar/artifacts-sync";

export default syncRepos({
  github: "elithrar/project",
  artifacts: "project",
  direction: "bidirectional",
});
```

`syncRepos` returns the Worker handler. Cloudflare also requires the three named class exports because the Workflow, Durable Object, and Computer container bindings refer to those exported class names.

## Configuration

### Repository pairs

Pass one configuration object or an array:

```ts
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

`direction` accepts:

- `"github-to-artifacts"`
- `"artifacts-to-github"`
- `"bidirectional"`

Each configured source repository must be unique in its enabled direction. Configuration fails during Worker startup when it contains a duplicate pair, conflicting namespace bindings, or fan-out.

### Artifacts namespaces and bindings

`artifacts: "project-a"` means the `project-a` repository in the `default` namespace and uses the `ARTIFACTS` binding.

Use `namespace/repo` for another namespace and name its binding explicitly:

```ts
{
  github: "elithrar/project-b",
  artifacts: "staging/project-b",
  artifactsBinding: "STAGING_ARTIFACTS",
  direction: "bidirectional",
}
```

Bind both namespaces in `wrangler.jsonc`:

```jsonc
{
  "artifacts": [
    {
      "binding": "ARTIFACTS",
      "namespace": "default",
    },
    {
      "binding": "STAGING_ARTIFACTS",
      "namespace": "staging",
    },
  ],
}
```

The namespace in the repository string must match the namespace assigned to its binding. Reuse one binding consistently for every configured repository in that namespace. Repositories must already exist.

### GitHub credentials and webhooks

The Worker uses one GitHub token and one webhook secret across its configured repositories:

```sh
wrangler secret put GITHUB_TOKEN
wrangler secret put GITHUB_WEBHOOK_SECRET
```

`GITHUB_TOKEN` must have access to every configured GitHub repository. Configure each GitHub repository to send JSON `push` webhooks to the same endpoint:

```text
https://<worker>/webhooks/github
```

Use the same webhook secret for every repository. The handler verifies `X-Hub-Signature-256` over the bounded raw body before parsing it, routes by `repository.full_name`, and returns `404` for an unconfigured repository.

An accepted delivery returns the Workflow instance ID:

```json
{
  "accepted": true,
  "id": "github-delivery-id-pair-suffix"
}
```

`GITHUB_WEBHOOK_SECRET` is unnecessary when no configuration accepts GitHub-originated pushes. `GITHUB_TOKEN` remains necessary when a sync writes to or inspects GitHub.

### Artifacts push events

Point `cf.artifacts.repo.pushed` events at the configured Workflow. Add one filtered trigger per repository:

```jsonc
{
  "triggers": {
    "events": [
      {
        "type": "cf.artifacts.repo.pushed",
        "filter": {
          "namespace": "default",
          "repo_name": "project-a",
        },
        "targets": [
          {
            "type": "workflow",
            "workflow_name": "artifacts-sync",
          },
        ],
      },
      {
        "type": "cf.artifacts.repo.pushed",
        "filter": {
          "namespace": "staging",
          "repo_name": "project-b",
        },
        "targets": [
          {
            "type": "workflow",
            "workflow_name": "artifacts-sync",
          },
        ],
      },
    ],
  },
}
```

You can omit the filter to deliver every Artifacts push event in the account. Events for unconfigured repositories return a no-op Workflow result rather than retrying.

Remove Artifacts event triggers when every pair is `github-to-artifacts`.

### Runtime bindings

The complete Worker configuration also declares:

- `SYNC_COORDINATOR`: the SQLite-backed Durable Object binding.
- `SYNC_WORKFLOW`: the Workflow binding.
- The Computer container attached to `SyncCoordinator`.
- Observability for Worker logs and traces.

Start from the complete [Worker example](./examples/cloudflare-worker/) and its [Wrangler configuration](./examples/cloudflare-worker/wrangler.jsonc). Regenerate binding types after changing the configuration:

```sh
wrangler types
```

## Results

The Workflow output identifies the repository pair and summarizes the completed sync:

```json
{
  "pair": "github:elithrar/project|artifacts:default/project",
  "executed": true,
  "strategy": "workspace",
  "refs": ["refs/heads/main"],
  "reason": "Bounded fast-forward change in a small source repository"
}
```

Inspect an instance with `wrangler workflows instances describe <workflow> <id>` or in the Cloudflare dashboard.

## Strategy

The Workspace path requires a complete, non-forced SHA-1 update within all four limits:

| Signal                       | Workspace limit |
| ---------------------------- | --------------: |
| Changed refs                 |               3 |
| New commits                  |              50 |
| Complete UTF-8 patch bytes   |          16 MiB |
| Cold-cache source repository |          16 MiB |

Missing evidence selects the native-Git container. Current Artifacts push events provide commit counts but not enough evidence to prove a small fast-forward transfer, so Artifacts-originated updates use the container by default.

Before execution, the library confirms that each source ref still matches the event and reads the destination ref. Stale deliveries become no-ops, and matching destination refs suppress events generated by bidirectional synchronization.

See [the design notes](./docs/PLAN.md) for the execution and conflict model.

## Status

Experimental. Cloudflare Artifacts and `@cloudflare/computer` are preview APIs. Pin upgrades and test against representative repository sizes before production use.

## License

Apache-2.0. See [LICENSE](./LICENSE).

## Currently unsupported

- **Fan-out:** one source repository cannot sync to multiple destinations. `syncRepos` rejects duplicate outgoing source routes during configuration.
