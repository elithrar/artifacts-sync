import { InvalidWebhookSignature, type OriginWebhookByType } from "cursor-origin-webhooks";
import { describe, expect, it, vi } from "vitest";

import { handleOriginWebhook, observeOriginPush, type OriginPushEvent } from "../src/origin.js";

const before = "a".repeat(40);
const after = "b".repeat(40);
const webhook: OriginWebhookByType["repository.pushed"] = {
  deliveryId: "delivery-1",
  appId: "app-1",
  installationId: "installation-1",
  event: {
    id: "event-1",
    type: "repository.pushed",
    eventTime: "2026-08-23T12:00:00Z",
    payload: {
      repository: { id: "repo-1", name: "example", owner: { slug: "elithrar" } },
      refUpdates: [
        {
          ref: "refs/heads/main",
          before,
          after,
          created: false,
          deleted: false,
          forced: false,
        },
      ],
      pushedAt: "2026-08-23T12:00:00Z",
      pusher: {},
      refUpdatesCount: 1,
    },
  },
};

describe("handleOriginWebhook", () => {
  it("authenticates, routes, and durably enqueues a push", async () => {
    const enqueue = vi.fn().mockResolvedValue("workflow-1");
    const response = await handleOriginWebhook(request(), {
      appId: "app-1",
      verify: vi.fn().mockResolvedValue(webhook),
      route(event) {
        return event.installationId === "installation-1" && event.repository.id === "repo-1"
          ? "pair-1"
          : undefined;
      },
      enqueue,
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true, id: "workflow-1" });
    expect(enqueue).toHaveBeenCalledWith(
      "delivery-1",
      "pair-1",
      expect.objectContaining({ eventId: "event-1", refUpdatesCount: 1 }),
    );
  });

  it("returns the verifier's retryable or terminal status", async () => {
    const response = await handleOriginWebhook(request(), {
      appId: "app-1",
      verify: vi.fn().mockRejectedValue(new InvalidWebhookSignature()),
      route: vi.fn(),
      enqueue: vi.fn(),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "invalid_signature" });
  });

  it("rejects a delivery for another app or unconfigured repository", async () => {
    const wrongApp = await handleOriginWebhook(request(), {
      appId: "another-app",
      verify: vi.fn().mockResolvedValue(webhook),
      route: vi.fn(),
      enqueue: vi.fn(),
    });
    expect(wrongApp.status).toBe(403);

    const unconfigured = await handleOriginWebhook(request(), {
      appId: "app-1",
      verify: vi.fn().mockResolvedValue(webhook),
      route: vi.fn(),
      enqueue: vi.fn(),
    });
    expect(unconfigured.status).toBe(404);
  });

  it("acknowledges authenticated non-push events without enqueueing", async () => {
    const enqueue = vi.fn();
    const response = await handleOriginWebhook(request(), {
      appId: "app-1",
      verify: vi.fn().mockResolvedValue({
        ...webhook,
        event: {
          id: "event-2",
          type: "installation.deleted",
          eventTime: "2026-08-23T12:00:00Z",
          payload: { installation: {}, app: {} },
        },
      }),
      route: vi.fn(),
      enqueue,
    });

    expect(response.status).toBe(204);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rejects malformed nested ref updates after authentication", async () => {
    const response = await handleOriginWebhook(request(), {
      appId: "app-1",
      verify: vi.fn().mockResolvedValue({
        ...webhook,
        event: {
          ...webhook.event,
          payload: {
            ...webhook.event.payload,
            refUpdates: [{ ref: "refs/heads/main" }],
          },
        },
      }),
      route: vi.fn(),
      enqueue: vi.fn(),
    });

    expect(response.status).toBe(400);
  });

  it("rejects a capped push without enqueueing a partial sync", async () => {
    const enqueue = vi.fn();
    const response = await handleOriginWebhook(request(), {
      appId: "app-1",
      verify: vi.fn().mockResolvedValue({
        ...webhook,
        event: {
          ...webhook.event,
          payload: { ...webhook.event.payload, refUpdatesCount: 101 },
        },
      }),
      route: vi.fn().mockReturnValue("pair-1"),
      enqueue,
    });

    expect(response.status).toBe(422);
    await expect(response.text()).resolves.toContain("no refs were synchronized");
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("observeOriginPush", () => {
  it("maps multi-ref changes and treats false force evidence as unknown", () => {
    const event = normalizedEvent();
    event.refUpdates.push({
      ref: "refs/tags/v1",
      before: "0".repeat(40),
      after: "c".repeat(40),
      created: true,
      deleted: false,
      forced: true,
    });
    event.refUpdatesCount = 2;

    expect(observeOriginPush(event)).toMatchObject({
      complete: true,
      sourceSizeBytes: null,
      refs: [
        { ref: "refs/heads/main", before, after, forced: null },
        { ref: "refs/tags/v1", before: null, after: "c".repeat(40), forced: true },
      ],
    });
  });

  it("rejects a capped atomic push", () => {
    const event = normalizedEvent();
    event.refUpdatesCount = 101;
    expect(() => observeOriginPush(event)).toThrow("capped Origin push");
  });

  it("rejects duplicate refs and inconsistent create/delete flags", () => {
    const duplicate = normalizedEvent();
    duplicate.refUpdates.push({ ...duplicate.refUpdates[0]! });
    duplicate.refUpdatesCount = 2;
    expect(() => observeOriginPush(duplicate)).toThrow("duplicate refs");

    const invalid = normalizedEvent();
    invalid.refUpdates[0] = { ...invalid.refUpdates[0]!, created: true };
    expect(() => observeOriginPush(invalid)).toThrow("created must match");
  });
});

function normalizedEvent(): OriginPushEvent {
  return {
    deliveryId: "delivery-1",
    appId: "app-1",
    installationId: "installation-1",
    eventId: "event-1",
    repository: { id: "repo-1", name: "example", owner: { slug: "elithrar" } },
    refUpdates: [
      {
        ref: "refs/heads/main",
        before,
        after,
        created: false,
        deleted: false,
        forced: false,
      },
    ],
    refUpdatesCount: 1,
  };
}

function request(): Request {
  return new Request("https://sync.example/webhooks/origin", {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json" },
  });
}
