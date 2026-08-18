# Cloudflare Worker example

This example wires both push directions into one Workflow:

- GitHub `push` webhook → Workflow → Cloudflare Artifacts
- `cf.artifacts.repo.pushed` → Workflow → GitHub

The Workflow routes both directions of the configured repository pair to one `SyncCoordinator` Durable Object. That object owns the persistent Computer Workspace and its lazily started native-Git container.

## Configure

1. Replace the repository values and Artifacts namespace in `wrangler.jsonc`.
2. Generate binding types:

   ```sh
   pnpm types:example
   ```

3. Add secrets:

   ```sh
   pnpm wrangler secret put GITHUB_TOKEN --config examples/cloudflare-worker/wrangler.jsonc
   pnpm wrangler secret put GITHUB_WEBHOOK_SECRET --config examples/cloudflare-worker/wrangler.jsonc
   ```

4. Configure a GitHub `push` webhook to `https://<worker>/webhooks/github` using the same secret.
5. Deploy with `pnpm deploy:example`.

The checked-in Artifacts event trigger is account-side configuration. Limit its filter to the configured namespace and repository before deployment.

Configure the GitHub webhook to send `application/json`. The Worker accepts only `push` events, requires `X-GitHub-Delivery`, verifies `X-Hub-Signature-256`, validates the payload schema, and rejects bodies above 10 MiB before starting a Workflow.

## Security

For this static-secret example, use a fine-grained token limited to the configured repository. GitHub App installation tokens expire, so production App integrations should mint them on demand through the resolver's `githubTokenFor` callback. The Artifacts resolver mints a short-lived read or write token for each sync. Git credentials use HTTP Basic authentication and are passed through request headers or the container environment; they are never included in a returned plan or command string.
