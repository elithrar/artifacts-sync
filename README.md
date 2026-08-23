# artifacts-sync

`artifacts-sync` keeps GitHub or Cursor Origin repositories synchronized with Cloudflare Artifacts after either repository receives a push. Every pair contains one Artifacts repository and one GitHub or native Origin repository. One Worker can manage multiple independent pairs.

The library validates provider webhooks and Artifacts events, starts durable Workflows, serializes each pair through its own Durable Object, and chooses between a persistent Computer Workspace and native Git in a Computer container. Synchronization is entirely event-driven; it does not poll repositories or webhook-delivery APIs.

## Installation

```sh
pnpm add artifacts-sync
```

## Quick start

```ts
import { syncRepos } from "artifacts-sync";

export { SyncCoordinator, SyncWorkflow, WorkspaceProxy } from "artifacts-sync";

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

GitHub pair `direction` accepts:

- `"github-to-artifacts"`
- `"artifacts-to-github"`
- `"bidirectional"`

Origin pair `direction` accepts:

- `"origin-to-artifacts"`
- `"artifacts-to-origin"`
- `"bidirectional"`

Each configured source repository must be unique in its enabled direction. Configuration fails during Worker startup when it contains a duplicate pair, conflicting namespace bindings, or fan-out.

Every pair must contain `artifacts` and exactly one of `github` or `origin`. GitHub-to-Origin synchronization is intentionally not supported.

### Artifacts namespaces and bindings

`artifacts: "project-a"` means the `project-a` repository in the `default` namespace and uses the `ARTIFACTS` binding.

Set `artifactsBinding` to override that binding name, including for the `default` namespace. This is useful when the surrounding Worker already uses `ARTIFACTS` for another purpose.

Set `artifactsRemote` to the repository's HTTPS Git URL when the runtime binding returns a repo handle without its metadata fields. The binding still mints the short-lived repo token.

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

### Cursor Origin credentials and webhooks

Configure a native Cursor Origin repository with its app installation ID. For Origin to Artifacts,
Origin's signed push webhook starts the sync:

```ts
export default syncRepos({
  origin: "elithrar/project",
  originInstallationId: "i_01...",
  artifacts: "project",
  direction: "origin-to-artifacts",
});
```

For Artifacts to Origin, the `cf.artifacts.repo.pushed` event starts the sync:

```ts
export default syncRepos({
  origin: "elithrar/project",
  originInstallationId: "i_01...",
  artifacts: "project",
  direction: "artifacts-to-origin",
});
```

Use `direction: "bidirectional"` to enable both paths. The ordered repositories and credentials are:

| Direction             | Event source               | Git access                             |
| --------------------- | -------------------------- | -------------------------------------- |
| `origin-to-artifacts` | Origin `repository.pushed` | Origin read → Artifacts write          |
| `artifacts-to-origin` | `cf.artifacts.repo.pushed` | Artifacts read → Origin read and write |

Create an Origin App and install it for the configured native Origin repositories. When Origin is a
source (`origin-to-artifacts` or `bidirectional`), subscribe the app to `repository.pushed` and set
its webhook URL to:

```text
https://<worker>/webhooks/origin
```

An `artifacts-to-origin` pair does not need an Origin webhook subscription. It still needs the
installed app and its credentials so the Worker can mint a repository-scoped destination token.

Store the app ID and its Ed25519 PKCS#8 private signing key as Worker secrets:

```sh
wrangler secret put ORIGIN_APP_ID
wrangler secret put ORIGIN_APP_PRIVATE_KEY
```

The app installation needs `repository:contents:read` when Origin is a source and both `repository:contents:read` and `repository:contents:write` when Origin is a destination. The Worker verifies Origin's Ed25519 webhook signature with Cursor's published signing keys; no webhook secret is required.

Origin installation tokens are minted just in time, restricted to the configured repository and required scopes, and passed to Git over HTTPS without embedding them in the remote URL. Repositories mirrored into Origin from GitHub are not supported because Origin Apps cannot access them or receive their push webhooks; configure those repositories through `github` instead.

The root package exports `OriginSyncReposOptions` and `SyncReposOptions` for extracted or generated
configuration:

```ts
import { syncRepos, type SyncReposOptions } from "artifacts-sync";

const pairs = [
  {
    origin: "elithrar/project",
    originInstallationId: "i_01...",
    artifacts: "project",
    direction: "origin-to-artifacts",
  },
] satisfies readonly SyncReposOptions[];

export default syncRepos(pairs);
```

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

Remove Artifacts event triggers when every pair is `github-to-artifacts` or
`origin-to-artifacts`.

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

Before execution, the library confirms that each source ref still matches the event and reads the destination ref. The native-Git path checks the source again and uses `--force-with-lease` against the observed destination for forced updates, ancestry-unknown updates, and deletions. A destination change during execution fails the lease and triggers a Workflow retry with fresh observations; repeated contention can exhaust the retry limit and fail the instance. A source event superseded in the meantime becomes a no-op. Matching destination refs suppress events generated by bidirectional synchronization.

Origin push events can contain up to 100 ref updates. When `refUpdatesCount` says an atomic push was capped, the webhook returns `422` and synchronizes none of the push. It does not report partial success, guess which omitted refs changed, or turn the event into a destructive full mirror. Split the push into smaller updates and retry it, or reconcile it manually; there is no scheduled reconciliation or delivery polling.

For simultaneous pushes to both repositories, there is no reliable ordering shared by providers. The first serialized attempt whose source remains current and whose destination lease succeeds wins; the reflected or superseded event becomes a no-op. This is synchronization, not commit or conflict merging.

See [the design notes](./docs/PLAN.md) for the execution and conflict model.

## Status

Experimental. Cloudflare Artifacts and `@cloudflare/computer` are preview APIs. Pin upgrades and test against representative repository sizes before production use.

## License

Apache-2.0. See [LICENSE](./LICENSE).

## Currently unsupported

- **Fan-out:** one source repository cannot sync to multiple destinations. `syncRepos` rejects duplicate outgoing source routes during configuration.
- **GitHub-to-Origin pairs:** Artifacts must be one side of every pair.
- **GitHub-mirrored Origin repositories:** Origin Apps cannot access these repositories; use the GitHub repository directly.
