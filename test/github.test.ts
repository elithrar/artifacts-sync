import { describe, expect, it, vi } from "vitest";

import { handleGitHubWebhook, inspectGitHubPush } from "../src/github.js";
import type { GitHubPushPayload } from "../src/schemas.js";

const payload: GitHubPushPayload = {
  ref: "refs/heads/main",
  before: "a".repeat(40),
  after: "b".repeat(40),
  forced: false,
  created: false,
  deleted: false,
  commits: [{ id: "b".repeat(40) }],
  repository: { full_name: "elithrar/example", size: 12 },
};

describe("inspectGitHubPush", () => {
  it("estimates a complete textual patch", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        total_commits: 1,
        files: [
          {
            status: "modified",
            additions: 1,
            deletions: 1,
            patch: "@@ -1 +1 @@\n-old\n+new",
          },
        ],
      }),
    );
    const observation = await inspectGitHubPush(payload, { fetch: fetcher, token: "secret" });

    expect(observation.complete).toBe(true);
    expect(observation.refs[0]).toMatchObject({
      before: payload.before,
      after: payload.after,
      destination: { status: "unchecked" },
      commitCount: 1,
      forced: false,
    });
    expect(observation.refs[0]?.estimatedPatchBytes).toBeGreaterThan(0);
    expect(observation.sourceSizeBytes).toBe(12 * 1024);
    const requestHeaders = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(requestHeaders.get("authorization")).toBe("Bearer secret");
    expect(requestHeaders.get("user-agent")).toBe("artifacts-sync");
    expect(requestHeaders.get("x-github-api-version")).toBe("2026-03-10");
  });

  it("marks a comparison without complete patches as incomplete", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        total_commits: 1,
        files: [{ status: "modified", additions: 0, deletions: 0 }],
      }),
    );
    const observation = await inspectGitHubPush(payload, { fetch: fetcher });

    expect(observation.complete).toBe(false);
    expect(observation.refs[0]?.estimatedPatchBytes).toBeNull();
  });

  it("bounds the streamed response even without Content-Length", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("12345"));
    const observation = await inspectGitHubPush(payload, {
      fetch: fetcher,
      maxResponseBytes: 4,
    });

    expect(observation.complete).toBe(false);
    expect(observation.refs[0]?.estimatedPatchBytes).toBeNull();
  });

  it("does not call compare for a deleted ref", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const observation = await inspectGitHubPush(
      { ...payload, after: "0".repeat(40), deleted: true },
      { fetch: fetcher },
    );

    expect(fetcher).not.toHaveBeenCalled();
    expect(observation.complete).toBe(true);
    expect(observation.refs[0]).toMatchObject({
      after: null,
      commitCount: 0,
      estimatedPatchBytes: 0,
    });
  });

  it("routes tag updates to native Git without comparing tag object IDs", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const observation = await inspectGitHubPush(
      { ...payload, ref: "refs/tags/v0.0.1" },
      { fetch: fetcher },
    );

    expect(fetcher).not.toHaveBeenCalled();
    expect(observation).toMatchObject({
      complete: false,
      refs: [{ ref: "refs/tags/v0.0.1", estimatedPatchBytes: null }],
    });
  });

  it("routes forced branch updates to native Git without comparing commits", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const observation = await inspectGitHubPush({ ...payload, forced: true }, { fetch: fetcher });

    expect(fetcher).not.toHaveBeenCalled();
    expect(observation).toMatchObject({
      complete: false,
      refs: [{ forced: true, estimatedPatchBytes: null }],
    });
  });

  it("rejects malformed compare responses", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ total_commits: "one", files: [] }));
    await expect(inspectGitHubPush(payload, { fetch: fetcher })).rejects.toThrow();
  });

  it("validates its response byte limit", async () => {
    await expect(inspectGitHubPush(payload, { maxResponseBytes: 0 })).rejects.toThrow(
      "maxResponseBytes must be a positive safe integer",
    );
  });

  it("rejects push flags that disagree with the before and after OIDs", async () => {
    await expect(inspectGitHubPush({ ...payload, created: true })).rejects.toThrow(
      "created must match the before OID",
    );
    await expect(inspectGitHubPush({ ...payload, deleted: true })).rejects.toThrow(
      "deleted must match the after OID",
    );
  });
});

describe("handleGitHubWebhook", () => {
  it("verifies and enqueues a push", async () => {
    const body = JSON.stringify(payload);
    const enqueue = createEnqueue();
    const response = await handleGitHubWebhook(
      await webhookRequest(body, "push", await sign(body)),
      webhookOptions(enqueue),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true, id: "workflow-1" });
    expect(enqueue).toHaveBeenCalledWith("delivery-1", "pair-1", payload);
  });

  it("accepts a signed GitHub ping without creating a sync", async () => {
    const body = JSON.stringify({ zen: "Keep it logically awesome." });
    const enqueue = createEnqueue();
    const response = await handleGitHubWebhook(
      await webhookRequest(body, "ping", await sign(body)),
      webhookOptions(enqueue),
    );

    expect(response.status).toBe(204);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rejects invalid signatures before parsing the payload", async () => {
    const enqueue = createEnqueue();
    const response = await handleGitHubWebhook(
      await webhookRequest("not json", "push", `sha256=${"0".repeat(64)}`),
      webhookOptions(enqueue),
    );

    expect(response.status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rejects pushes for a different repository", async () => {
    const body = JSON.stringify({
      ...payload,
      repository: { ...payload.repository, full_name: "elithrar/other" },
    });
    const enqueue = createEnqueue();
    const response = await handleGitHubWebhook(
      await webhookRequest(body, "push", await sign(body)),
      webhookOptions(enqueue),
    );

    expect(response.status).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rejects an advertised body above the webhook limit", async () => {
    const enqueue = createEnqueue();
    const response = await handleGitHubWebhook(
      new Request("https://sync.example/webhooks/github", {
        method: "POST",
        body: "{}",
        headers: {
          "content-type": "application/json",
          "content-length": String(10 * 1024 * 1024 + 1),
          "x-github-delivery": "delivery-1",
          "x-github-event": "push",
          "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
        },
      }),
      webhookOptions(enqueue),
    );

    expect(response.status).toBe(413);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

type Enqueue = (
  delivery: string,
  configurationId: string,
  event: GitHubPushPayload,
) => Promise<string>;

function createEnqueue() {
  return vi.fn<Enqueue>().mockResolvedValue("workflow-1");
}

function webhookOptions(enqueue: Enqueue) {
  return {
    secret: "webhook-secret",
    route(repository: string): string | undefined {
      return repository.toLowerCase() === "elithrar/example" ? "pair-1" : undefined;
    },
    enqueue,
  };
}

async function webhookRequest(body: string, event: string, signature: string): Promise<Request> {
  return new Request("https://sync.example/webhooks/github", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-github-delivery": "delivery-1",
      "x-github-event": event,
      "x-hub-signature-256": signature,
    },
  });
}

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("webhook-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  const hex = Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}
