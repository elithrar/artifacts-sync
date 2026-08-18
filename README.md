# artifacts-sync

Size-aware Git synchronization between GitHub and Cloudflare Artifacts.

```ts
import {
  artifacts,
  createCloudflareResolver,
  createComputerContainerExecutor,
  createComputerWorkspaceExecutor,
  createSyncClient,
  github,
  inspectGitHubPush,
} from "@elithrar/artifacts-sync";

const client = createSyncClient({
  resolver: createCloudflareResolver({
    artifacts: env.ARTIFACTS,
    githubToken: env.GITHUB_TOKEN,
  }),
  workspace: createComputerWorkspaceExecutor(workspace),
  container: createComputerContainerExecutor(workspace),
});

const change = await inspectGitHubPush(payload, {
  token: env.GITHUB_TOKEN,
});

await client.sync(github("elithrar/project"), artifacts("project"), { change });
```

The automatic planner uses the Computer Workspace only for small, fully measured fast-forward updates. Mirrors, force pushes, binary or truncated comparisons, cold substantial repositories, and unknown changes run through native Git in a Computer container.

See [the design plan](./docs/PLAN.md) and [the Cloudflare Worker example](./examples/cloudflare-worker/README.md).

## Status

Experimental. `@cloudflare/computer` is preview-only and currently unsuitable as an unqualified production dependency. Keep the executor boundary if you adopt this library.
