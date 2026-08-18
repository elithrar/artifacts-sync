# Cloudflare Worker example

This example wires both push directions into one Workflow:

- GitHub `push` webhook → Workflow → Cloudflare Artifacts
- `cf.artifacts.repo.pushed` → Workflow → GitHub

The Workflow routes each ordered repository pair to one `SyncCoordinator` Durable Object. That object owns the persistent Computer Workspace and its lazily started native-Git container.

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

## Security

Use a GitHub App installation token or fine-grained token limited to the configured repository. The Artifacts resolver mints a short-lived read or write token for each sync. Neither credential is included in a returned plan or native-Git command string.
