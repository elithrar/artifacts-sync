# Cloudflare Worker example

This Worker synchronizes one repository pair:

- `elithrar/artifacts-sync` ↔ `default/artifacts-sync`

GitHub and Artifacts pushes use the same Workflow to keep the repositories synchronized in both directions.

## Configure repository pairs

Edit `src/index.ts`:

```ts
import { syncRepos } from "@elithrar/artifacts-sync";

export { SyncCoordinator, SyncWorkflow, WorkspaceProxy } from "@elithrar/artifacts-sync";

export default syncRepos({
  github: "elithrar/artifacts-sync",
  artifacts: "artifacts-sync",
  artifactsRemote:
    "https://d458dbe698b8eef41837f941d73bc5b3.artifacts.cloudflare.net/git/default/artifacts-sync.git",
  direction: "bidirectional",
});
```

A repository without a namespace uses `default` and the `ARTIFACTS` binding. A `namespace/repo` value requires `artifactsBinding`. `artifactsRemote` supplies the Git URL explicitly while the binding mints short-lived repo tokens.

## Configure Cloudflare

Keep each Artifacts binding aligned with the namespace in `src/index.ts`:

```jsonc
"artifacts": [
  {
    "binding": "ARTIFACTS",
    "namespace": "default",
  },
]
```

The checked-in `wrangler.jsonc` also declares:

- The `SyncCoordinator` SQLite-backed Durable Object and Computer container.
- The `SyncWorkflow` Workflow binding.
- A filtered `cf.artifacts.repo.pushed` trigger for the Artifacts repository.
- Worker logs and traces.

Remove a repository's Artifacts event trigger when its direction is `github-to-artifacts`.

Generate binding types after editing `wrangler.jsonc`:

```sh
pnpm types:example
```

## Configure GitHub

Add a fine-grained token with read/write access to `elithrar/artifacts-sync` and a webhook secret:

```sh
pnpm exec wrangler secret put GITHUB_TOKEN --config examples/cloudflare-worker/wrangler.jsonc
pnpm exec wrangler secret put GITHUB_WEBHOOK_SECRET --config examples/cloudflare-worker/wrangler.jsonc
```

Configure the GitHub repository to send JSON `push` webhooks to:

```text
https://<worker>/webhooks/github
```

Use the same webhook secret in GitHub and the Worker.

## Deploy

```sh
pnpm deploy:example
```

An accepted GitHub delivery returns HTTP `202` with the pair-specific Workflow ID. The Workflow output reports the repository pair, whether work ran, the selected strategy, affected refs, and the planning reason.

Duplicate GitHub deliveries reuse the same pair-specific ID and do not create another Workflow instance.
