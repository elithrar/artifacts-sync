import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createOriginResolver } from "../src/origin-auth.js";
import { parseOriginRepository } from "../src/repositories.js";

const NOW = Date.parse("2026-08-23T12:00:00Z");
const EXPIRES_AT = "2026-08-23T12:15:00Z";
const installationTokenRequestSchema = z.object({
  scopes: z.array(z.string()),
  repositoryIds: z.array(z.string()).optional(),
});
const jwtPartSchema = z.record(z.string(), z.union([z.string(), z.number()]));

type InstallationTokenRequest = z.infer<typeof installationTokenRequestSchema>;
type JwtPart = z.infer<typeof jwtPartSchema>;

describe("createOriginResolver", () => {
  it("mints repository-scoped tokens and uses returned clone metadata", async () => {
    const privateKey = await generatePrivateKey();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ token: "oit_metadata", expiresAt: EXPIRES_AT }))
      .mockResolvedValueOnce(
        Response.json({
          id: "repo-1",
          name: "Example",
          owner: { slug: "Elithrar" },
          cloneUrl: "https://origin.cursor.com/Elithrar/Example.git",
        }),
      )
      .mockResolvedValueOnce(Response.json({ token: "oit_read", expiresAt: EXPIRES_AT }))
      .mockResolvedValueOnce(Response.json({ token: "oit_write", expiresAt: EXPIRES_AT }));
    const resolver = createOriginResolver({
      appId: "app-1",
      privateKey,
      fetch: fetcher,
      now: () => NOW,
    });
    const repository = {
      ...parseOriginRepository("elithrar/example", "installation-1"),
      repositoryId: "repo-1",
    };

    await expect(resolver.resolve(repository, "read")).resolves.toEqual({
      identity: "origin:repo-1",
      url: "https://origin.cursor.com/Elithrar/Example.git",
      authorization: `Basic ${btoa("x-access-token:oit_read")}`,
    });
    await expect(resolver.resolve(repository, "write")).resolves.toMatchObject({
      authorization: `Basic ${btoa("x-access-token:oit_write")}`,
    });

    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(requestBody(fetcher, 0)).toEqual({
      scopes: ["repository:metadata:read"],
      repositoryIds: ["repo-1"],
    });
    expect(requestBody(fetcher, 2)).toEqual({
      scopes: ["repository:contents:read"],
      repositoryIds: ["repo-1"],
    });
    expect(requestBody(fetcher, 3)).toEqual({
      scopes: ["repository:contents:read", "repository:contents:write"],
      repositoryIds: ["repo-1"],
    });
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "https://api.cursor.com/v1/origin/repos/elithrar/example",
    );

    const authorization = new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization");
    const jwt = authorization?.replace("Bearer ", "") ?? "";
    const [header, claims] = jwt.split(".");
    expect(decodeJwtPart(header ?? "")).toEqual({ alg: "EdDSA", kid: "app-1", typ: "JWT" });
    expect(decodeJwtPart(claims ?? "")).toEqual({
      iss: "app-1",
      aud: "origin-apps",
      iat: Math.floor(NOW / 1000) - 30,
      exp: Math.floor(NOW / 1000) + 270,
    });
  });

  it("discovers an ID with metadata-only installation access", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ token: "oit_metadata", expiresAt: EXPIRES_AT }))
      .mockResolvedValueOnce(
        Response.json({
          id: "repo-1",
          name: "example",
          owner: { slug: "elithrar" },
          cloneUrl: "https://origin.cursor.com/elithrar/example.git",
        }),
      )
      .mockResolvedValueOnce(Response.json({ token: "oit_write", expiresAt: EXPIRES_AT }));
    const resolver = createOriginResolver({
      appId: "app-1",
      privateKey: await generatePrivateKey(),
      fetch: fetcher,
      now: () => NOW,
    });

    await resolver.resolve(parseOriginRepository("elithrar/example", "installation-1"), "write");

    expect(requestBody(fetcher, 0)).toEqual({ scopes: ["repository:metadata:read"] });
    expect(requestBody(fetcher, 2)).toMatchObject({ repositoryIds: ["repo-1"] });
  });

  it("does not retain failed metadata lookups", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ token: "oit_metadata_1", expiresAt: EXPIRES_AT }))
      .mockResolvedValueOnce(
        Response.json({
          id: "repo-1",
          name: "wrong",
          owner: { slug: "elithrar" },
          cloneUrl: "https://origin.cursor.com/elithrar/wrong.git",
        }),
      )
      .mockResolvedValueOnce(Response.json({ token: "oit_metadata_2", expiresAt: EXPIRES_AT }))
      .mockResolvedValueOnce(
        Response.json({
          id: "repo-1",
          name: "example",
          owner: { slug: "elithrar" },
          cloneUrl: "https://origin.cursor.com/elithrar/example.git",
        }),
      )
      .mockResolvedValueOnce(Response.json({ token: "oit_read", expiresAt: EXPIRES_AT }));
    const resolver = createOriginResolver({
      appId: "app-1",
      privateKey: await generatePrivateKey(),
      fetch: fetcher,
      now: () => NOW,
    });
    const repository = parseOriginRepository("elithrar/example", "installation-1");

    await expect(resolver.resolve(repository, "read")).rejects.toThrow("metadata does not match");
    await expect(resolver.resolve(repository, "read")).resolves.toMatchObject({
      identity: "origin:repo-1",
    });
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("rejects repository substitution, unsafe clone URLs, and expiring credentials", async () => {
    const privateKey = await generatePrivateKey();
    const wrongRepository = createOriginResolver({
      appId: "app-1",
      privateKey,
      now: () => NOW,
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ token: "oit_metadata", expiresAt: EXPIRES_AT }))
        .mockResolvedValueOnce(
          Response.json({
            id: "repo-2",
            name: "other",
            owner: { slug: "elithrar" },
            cloneUrl: "https://origin.cursor.com/elithrar/other.git",
          }),
        ),
    });
    await expect(
      wrongRepository.resolve(parseOriginRepository("elithrar/example", "installation-1"), "read"),
    ).rejects.toThrow("metadata does not match");

    const substitutedId = createOriginResolver({
      appId: "app-1",
      privateKey,
      now: () => NOW,
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ token: "oit_metadata", expiresAt: EXPIRES_AT }))
        .mockResolvedValueOnce(
          Response.json({
            id: "repo-other",
            name: "example",
            owner: { slug: "elithrar" },
            cloneUrl: "https://origin.cursor.com/elithrar/example.git",
          }),
        ),
    });
    await expect(
      substitutedId.resolve(
        {
          ...parseOriginRepository("elithrar/example", "installation-1"),
          repositoryId: "repo-expected",
        },
        "read",
      ),
    ).rejects.toThrow("repository ID does not match");

    const unsafeClone = createOriginResolver({
      appId: "app-1",
      privateKey,
      now: () => NOW,
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ token: "oit_metadata", expiresAt: EXPIRES_AT }))
        .mockResolvedValueOnce(
          Response.json({
            id: "repo-1",
            name: "example",
            owner: { slug: "elithrar" },
            cloneUrl: "https://token@origin.cursor.com/elithrar/example.git",
          }),
        ),
    });
    await expect(
      unsafeClone.resolve(parseOriginRepository("elithrar/example", "installation-1"), "read"),
    ).rejects.toThrow("clone URL");

    const untrustedCloneHost = createOriginResolver({
      appId: "app-1",
      privateKey,
      now: () => NOW,
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ token: "oit_metadata", expiresAt: EXPIRES_AT }))
        .mockResolvedValueOnce(
          Response.json({
            id: "repo-1",
            name: "example",
            owner: { slug: "elithrar" },
            cloneUrl: "https://credentials.example/elithrar/example.git",
          }),
        ),
    });
    await expect(
      untrustedCloneHost.resolve(
        parseOriginRepository("elithrar/example", "installation-1"),
        "read",
      ),
    ).rejects.toThrow("origin.cursor.com");

    const substitutedClonePath = createOriginResolver({
      appId: "app-1",
      privateKey,
      now: () => NOW,
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ token: "oit_metadata", expiresAt: EXPIRES_AT }))
        .mockResolvedValueOnce(
          Response.json({
            id: "repo-other",
            name: "example",
            owner: { slug: "elithrar" },
            cloneUrl: "https://origin.cursor.com/elithrar/other.git",
          }),
        )
        .mockResolvedValueOnce(Response.json({ token: "oit_read", expiresAt: EXPIRES_AT })),
    });
    await expect(
      substitutedClonePath.resolve(
        parseOriginRepository("elithrar/example", "installation-1"),
        "read",
      ),
    ).rejects.toThrow("configured repository");

    const expiring = createOriginResolver({
      appId: "app-1",
      privateKey,
      now: () => NOW,
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json({ token: "oit_metadata", expiresAt: "2026-08-23T12:00:10Z" }),
        ),
    });
    await expect(
      expiring.resolve(parseOriginRepository("elithrar/example", "installation-1"), "read"),
    ).rejects.toThrow("expires too soon");
  });

  it("validates key material and request bounds", async () => {
    expect(() =>
      createOriginResolver({ appId: "app-1", privateKey: "", timeoutMs: 5_000 }),
    ).toThrow("private key must be configured");
    expect(() =>
      createOriginResolver({ appId: "app-1", privateKey: "invalid", timeoutMs: 0 }),
    ).toThrow("positive safe integer");
    expect(() =>
      createOriginResolver({
        appId: "app-1",
        privateKey: "invalid",
        apiUrl: "https://api.cursor.com/v1/origin?unexpected=true",
      }),
    ).toThrow("without credentials or parameters");

    const resolver = createOriginResolver({
      appId: "app-1",
      privateKey: "invalid",
      fetch: vi.fn(),
    });
    await expect(
      resolver.resolve(parseOriginRepository("elithrar/example", "installation-1"), "read"),
    ).rejects.toThrow("PKCS#8 PEM");

    const oversized = createOriginResolver({
      appId: "app-1",
      privateKey: await generatePrivateKey(),
      fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(
        new Response("{}", {
          headers: {
            "content-length": String(1024 * 1024 + 1),
            "content-type": "application/json",
          },
        }),
      ),
    });
    await expect(
      oversized.resolve(parseOriginRepository("elithrar/example", "installation-1"), "read"),
    ).rejects.toThrow("size limit");
  });
});

function requestBody(
  fetcher: ReturnType<typeof vi.fn<typeof fetch>>,
  index: number,
): InstallationTokenRequest {
  const body = z.string().parse(fetcher.mock.calls[index]?.[1]?.body);
  return installationTokenRequestSchema.parse(JSON.parse(body));
}

async function generatePrivateKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 =
    btoa(binary)
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
}

function decodeJwtPart(value: string): JwtPart {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return jwtPartSchema.parse(JSON.parse(atob(padded)));
}
