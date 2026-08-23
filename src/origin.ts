import {
  verifyWebhook,
  WebhookVerificationError,
  type OriginWebhook,
} from "cursor-origin-webhooks";
import { z } from "zod";

import { gitOidSchema, gitRefSchema } from "./schemas.js";
import type { ChangeObservation } from "./types.js";

const ORIGIN_WEBHOOK_PATH = "/webhooks/origin";
const MAX_ORIGIN_REF_UPDATES = 100;

const originRepositoryReferenceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  owner: z.object({ slug: z.string().min(1) }),
});
const originRefUpdateSchema = z
  .object({
    ref: gitRefSchema,
    before: gitOidSchema,
    after: gitOidSchema,
    created: z.boolean(),
    deleted: z.boolean(),
    forced: z.boolean(),
  })
  .refine((update) => update.created === isZeroOid(update.before), {
    error: "created must match the before OID",
    path: ["created"],
  })
  .refine((update) => update.deleted === isZeroOid(update.after), {
    error: "deleted must match the after OID",
    path: ["deleted"],
  })
  .refine((update) => !(update.created && update.deleted), {
    error: "A push cannot create and delete the same ref",
  });

export const originPushEventSchema = z
  .object({
    deliveryId: z.string().min(1),
    appId: z.string().min(1),
    installationId: z.string().min(1),
    eventId: z.string().min(1),
    repository: originRepositoryReferenceSchema,
    refUpdates: z.array(originRefUpdateSchema).max(MAX_ORIGIN_REF_UPDATES),
    refUpdatesCount: z.number().int().nonnegative().max(0xffff_ffff),
  })
  .refine((event) => event.refUpdates.length <= event.refUpdatesCount, {
    error: "refUpdates cannot exceed refUpdatesCount",
    path: ["refUpdates"],
  })
  .refine(
    (event) =>
      new Set(event.refUpdates.map((update) => update.ref)).size === event.refUpdates.length,
    {
      error: "Origin push contains duplicate refs",
      path: ["refUpdates"],
    },
  );

export type OriginPushEvent = z.infer<typeof originPushEventSchema>;

interface OriginRoute {
  readonly installationId: string;
  readonly repository: OriginPushEvent["repository"];
}

interface HandleOriginWebhookOptions {
  readonly appId: string;
  readonly route: (event: OriginRoute) => string | undefined;
  readonly enqueue: (
    delivery: string,
    configurationId: string,
    event: OriginPushEvent,
  ) => Promise<string>;
  readonly verify?: (request: Request) => Promise<OriginWebhook>;
}

export async function handleOriginWebhook(
  request: Request,
  options: HandleOriginWebhookOptions,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== ORIGIN_WEBHOOK_PATH) return new Response("Not found", { status: 404 });

  let webhook: OriginWebhook;
  try {
    webhook = await (options.verify ?? verifyWebhook)(request);
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      return Response.json({ error: error.code }, { status: error.statusCode });
    }
    throw error;
  }

  if (webhook.appId !== options.appId) {
    return new Response("Origin app does not match", { status: 403 });
  }
  if (webhook.event.type !== "repository.pushed") return new Response(null, { status: 204 });

  const event = parseOriginPush(webhook);
  if (event === null) return new Response("Invalid Origin push payload", { status: 400 });
  const configurationId = options.route({
    installationId: event.installationId,
    repository: event.repository,
  });
  if (configurationId === undefined) {
    return new Response("Repository is not configured", { status: 404 });
  }
  if (event.refUpdates.length !== event.refUpdatesCount) {
    return new Response(
      "Origin push exceeds the webhook ref-update limit; no refs were synchronized",
      {
        status: 422,
      },
    );
  }

  const id = await options.enqueue(event.deliveryId, configurationId, event);
  return Response.json({ accepted: true, id }, { status: 202 });
}

export function observeOriginPush(event: OriginPushEvent): ChangeObservation {
  const parsed = originPushEventSchema.parse(event);
  if (parsed.refUpdates.length !== parsed.refUpdatesCount) {
    throw new Error("A capped Origin push cannot be synchronized safely");
  }
  return {
    refs: parsed.refUpdates.map((update) => ({
      ref: update.ref,
      before: isZeroOid(update.before) ? null : update.before,
      after: isZeroOid(update.after) ? null : update.after,
      destination: { status: "unchecked" },
      commitCount: null,
      estimatedPatchBytes: null,
      // Origin may report false for historical pushes whose force status was not tracked.
      forced: update.forced ? true : null,
    })),
    complete: true,
    sourceSizeBytes: null,
  };
}

function parseOriginPush(webhook: OriginWebhook): OriginPushEvent | null {
  if (webhook.event.type !== "repository.pushed") return null;
  const payload = webhook.event.payload;
  const result = originPushEventSchema.safeParse({
    deliveryId: webhook.deliveryId,
    appId: webhook.appId,
    installationId: webhook.installationId,
    eventId: webhook.event.id,
    repository: payload.repository,
    refUpdates: payload.refUpdates,
    refUpdatesCount: payload.refUpdatesCount,
  });
  return result.success ? result.data : null;
}

function isZeroOid(oid: string): boolean {
  return /^0+$/.test(oid);
}
