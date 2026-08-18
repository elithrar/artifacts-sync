# Cloudflare Worker example

This Worker synchronizes two independent repository pairs:

- `elithrar/example` ↔ `default/example`
- `elithrar/example-staging` ↔ `staging/example`

Both GitHub webhooks use the same Worker endpoint. Separate Artifacts bindings and event filters identify the two namespaces.

## Configure repository pairs

Edit `src/index.ts`:

```ts
import { syncRepos } from "@elithrar/artifacts-sync";

export { SyncCoordinator, SyncWorkflow, WorkspaceProxy } from "@elithrar/artifacts-sync";

export default syncRepos([
  {
    github: "elithrar/example",
    artifacts: "example",
    direction: "bidirectional",
  },
  {
    github: "elithrar/example-staging",
    artifacts: "staging/example",
    artifactsBinding: "STAGING_ARTIFACTS",
    direction: "bidirectional",
  },
]);
```

A repository without a namespace uses `default` and the `ARTIFACTS` binding. A `namespace/repo` value requires `artifactsBinding`.

## Configure Cloudflare

Keep each Artifacts binding aligned with the namespace in `src/index.ts`:

```jsonc
"artifacts": [
  {
    "binding": "ARTIFACTS",
    "namespace": "default",
  },
  {
    "binding": "STAGING_ARTIFACTS",
    "namespace": "staging",
  },
]
```

The checked-in `wrangler.jsonc` also declares:

- The `SyncCoordinator` SQLite-backed Durable Object and Computer container.
- The `SyncWorkflow` Workflow binding.
- One filtered `cf.artifacts.repo.pushed` trigger for each Artifacts repository.
- Worker logs and traces.

Remove a repository's Artifacts event trigger when its direction is `github-to-artifacts`.

Generate binding types after editing `wrangler.jsonc`:

```sh
pnpm types:example
```

## Configure GitHub

Add a fine-grained token with access to both GitHub repositories and one shared webhook secret:

```sh
pnpm exec wrangler secret put GITHUB_TOKEN --config examples/cloudflare-worker/wrangler.jsonc
pnpm exec wrangler secret put GITHUB_WEBHOOK_SECRET --config examples/cloudflare-worker/wrangler.jsonc
```

Configure each GitHub repository to send JSON `push` webhooks to:

```text
https://<worker>/webhooks/github
```

Use the same webhook secret for both repositories.

## Deploy

```sh
pnpm deploy:example
```

An accepted GitHub delivery returns HTTP `202` with the pair-specific Workflow ID. The Workflow output reports the repository pair, whether work ran, the selected strategy, affected refs, and the planning reason.

Duplicate GitHub deliveries reuse the same pair-specific ID and do not create another Workflow instance.
