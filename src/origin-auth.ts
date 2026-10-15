import { z } from "zod";

import type { OriginRepository, RepositoryResolver, ResolvedRepository } from "./types.js";

const DEFAULT_API_URL = "https://api.cursor.com/v1/origin";
const DEFAULT_TIMEOUT_MS = 5_000;
const APP_JWT_LIFETIME_SECONDS = 5 * 60;
const APP_JWT_CLOCK_SKEW_SECONDS = 30;
const MINIMUM_TOKEN_LIFETIME_MS = 30_000;
const MAX_API_RESPONSE_BYTES = 1024 * 1024;

const installationTokenSchema = z.object({
  token: z.string().startsWith("oit_").min(5),
  expiresAt: z.iso.datetime({ offset: true }),
});
const repositorySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  cloneUrl: z.url(),
  owner: z.object({ slug: z.string().min(1) }),
});

interface OriginRepositoryMetadata {
  readonly id: string;
  readonly name: string;
  readonly owner: string;
  readonly cloneUrl: string;
}

export interface OriginResolverOptions {
  readonly appId: string;
  readonly privateKey: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly apiUrl?: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export function createOriginResolver(options: OriginResolverOptions): RepositoryResolver {
  validateOpaqueValue(options.appId, "Origin app ID");
  if (options.privateKey.length === 0) throw new Error("Origin app private key must be configured");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Origin timeoutMs must be a positive safe integer");
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  const apiUrl = normalizeApiUrl(options.apiUrl ?? DEFAULT_API_URL);
  const now = options.now ?? Date.now;
  let importedKey: CryptoKey | undefined;
  const getPrivateKey = async (): Promise<CryptoKey> => {
    importedKey ??= await importPrivateKey(options.privateKey);
    return importedKey;
  };
  const metadata = new Map<string, OriginRepositoryMetadata>();

  return {
    async resolve(repository, access): Promise<ResolvedRepository> {
      if (repository.kind !== "origin") throw new Error("Expected an Origin repository");
      const cacheKey = originCacheKey(repository);
      let resolved = metadata.get(cacheKey);
      if (resolved === undefined) {
        resolved = await resolveMetadata(
          repository,
          options.appId,
          getPrivateKey,
          fetcher,
          apiUrl,
          timeoutMs,
          now,
        );
        metadata.set(cacheKey, resolved);
      }
      if (repository.repositoryId !== undefined && repository.repositoryId !== resolved.id) {
        throw new Error("Origin repository ID does not match the configured repository");
      }

      const scopes =
        access === "read"
          ? ["repository:contents:read"]
          : ["repository:contents:read", "repository:contents:write"];
      const token = await mintInstallationToken(
        repository.installationId,
        scopes,
        [resolved.id],
        options.appId,
        getPrivateKey,
        fetcher,
        apiUrl,
        timeoutMs,
        now,
      );
      return {
        identity: `origin:${resolved.id}`,
        url: resolved.cloneUrl,
        authorization: basicAuthorization("x-access-token", token),
      };
    },
  };
}

async function resolveMetadata(
  repository: OriginRepository,
  appId: string,
  getPrivateKey: () => Promise<CryptoKey>,
  fetcher: typeof globalThis.fetch,
  apiUrl: string,
  timeoutMs: number,
  now: () => number,
): Promise<OriginRepositoryMetadata> {
  const repositoryIds =
    repository.repositoryId === undefined ? undefined : [repository.repositoryId];
  const metadataToken = await mintInstallationToken(
    repository.installationId,
    ["repository:metadata:read"],
    repositoryIds,
    appId,
    getPrivateKey,
    fetcher,
    apiUrl,
    timeoutMs,
    now,
  );
  const response = await request(
    fetcher,
    `${apiUrl}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`,
    {
      headers: { Authorization: `Bearer ${metadataToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!response.ok) throw new Error(`Origin get repository failed with HTTP ${response.status}`);
  const parsed = await parseApiResponse(response, repositorySchema);
  validateOpaqueValue(parsed.id, "Origin repository ID");
  if (
    parsed.name.toLowerCase() !== repository.repo.toLowerCase() ||
    parsed.owner.slug.toLowerCase() !== repository.owner.toLowerCase()
  ) {
    throw new Error("Origin repository metadata does not match the configured repository");
  }
  assertSafeCloneUrl(parsed.cloneUrl, repository);
  return {
    id: parsed.id,
    name: parsed.name,
    owner: parsed.owner.slug,
    cloneUrl: parsed.cloneUrl,
  };
}

async function mintInstallationToken(
  installationId: string,
  scopes: readonly string[],
  repositoryIds: readonly string[] | undefined,
  appId: string,
  getPrivateKey: () => Promise<CryptoKey>,
  fetcher: typeof globalThis.fetch,
  apiUrl: string,
  timeoutMs: number,
  now: () => number,
): Promise<string> {
  validateOpaqueValue(installationId, "Origin installation ID");
  const appJwt = await createAppJwt(appId, await getPrivateKey(), now());
  const body = repositoryIds === undefined ? { scopes } : { scopes, repositoryIds };
  const response = await request(
    fetcher,
    `${apiUrl}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appJwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!response.ok) {
    throw new Error(`Origin installation token request failed with HTTP ${response.status}`);
  }
  const token = await parseApiResponse(response, installationTokenSchema);
  const expiresAt = Date.parse(token.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt - now() < MINIMUM_TOKEN_LIFETIME_MS) {
    throw new Error("Origin installation token expires too soon");
  }
  return token.token;
}

async function createAppJwt(appId: string, privateKey: CryptoKey, nowMs: number): Promise<string> {
  const now = Math.floor(nowMs / 1000);
  const header = encodeJson({ alg: "EdDSA", kid: appId, typ: "JWT" });
  const claims = encodeJson({
    iss: appId,
    aud: "origin-apps",
    iat: now - APP_JWT_CLOCK_SKEW_SECONDS,
    exp: now + APP_JWT_LIFETIME_SECONDS - APP_JWT_CLOCK_SKEW_SECONDS,
  });
  const signingInput = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const match = pem.match(
    /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z\d+/=\s]+?)\s+-----END PRIVATE KEY-----$/,
  );
  if (match?.[1] === undefined) {
    throw new Error("Origin app private key must be a PKCS#8 PEM private key");
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = decodeBase64(match[1].replaceAll(/\s/g, ""));
  } catch (error) {
    throw new Error("Origin app private key contains invalid base64", { cause: error });
  }
  try {
    return await crypto.subtle.importKey("pkcs8", bytes, "Ed25519", false, ["sign"]);
  } catch (error) {
    throw new Error("Origin app private key is not a valid Ed25519 PKCS#8 key", { cause: error });
  }
}

async function request(
  fetcher: typeof globalThis.fetch,
  input: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetcher(input, init);
  } catch (error) {
    throw new Error("Origin API request failed", { cause: error });
  }
}

function originCacheKey(repository: OriginRepository): string {
  return `${repository.installationId}\n${repository.owner.toLowerCase()}/${repository.repo.toLowerCase()}`;
}

function normalizeApiUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Origin API URL must be an HTTPS URL without credentials or parameters");
  }
  return url.href.replace(/\/$/, "");
}

function assertSafeCloneUrl(value: string, repository: OriginRepository): void {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "origin.cursor.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "Origin clone URL must use origin.cursor.com over HTTPS without credentials or parameters",
    );
  }
  const path = url.pathname.toLowerCase();
  const repositoryPath = `/${repository.owner}/${repository.repo}.git`.toLowerCase();
  if (path !== repositoryPath && path !== `/git${repositoryPath}`) {
    throw new Error("Origin clone URL does not match the configured repository");
  }
}

async function parseApiResponse<Schema extends z.ZodType>(
  response: Response,
  schema: Schema,
): Promise<z.output<Schema>> {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") throw new Error("Origin API returned non-JSON content");

  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength)) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > MAX_API_RESPONSE_BYTES) {
      throw new Error("Origin API response exceeds the size limit");
    }
  }
  if (response.body === null) throw new Error("Origin API returned an empty response");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  for (;;) {
    // A response stream must be consumed in order and bounded before decoding the next chunk.
    // eslint-disable-next-line no-await-in-loop
    const chunk = await reader.read();
    if (chunk.done) break;
    bytesRead += chunk.value.byteLength;
    if (bytesRead > MAX_API_RESPONSE_BYTES) {
      // Stop the same sequential stream before rejecting the oversized response.
      // eslint-disable-next-line no-await-in-loop
      await reader.cancel();
      throw new Error("Origin API response exceeds the size limit");
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  return schema.parse(JSON.parse(text));
}

function encodeJson(value: Readonly<Record<string, string | number>>): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function basicAuthorization(username: string, password: string): string {
  validateOpaqueValue(password, "Origin installation token");
  return `Basic ${btoa(`${username}:${password}`)}`;
}

function validateOpaqueValue(value: string, name: string): void {
  if (value.length === 0 || hasControlCharacter(value)) {
    throw new Error(`${name} must be non-empty and contain no control characters`);
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}
