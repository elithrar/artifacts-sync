import { z } from "zod";

export const gitOidSchema = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/i, "Invalid Git OID");

export const gitRefSchema = z
  .string()
  .startsWith("refs/")
  .regex(/^[^~^:?*\\[]+$/, "Invalid Git ref")
  .refine((ref) => !hasControlCharacter(ref), { error: "Invalid Git ref" })
  .refine((ref) => !ref.includes("..") && !ref.includes("@{") && !ref.includes("//"), {
    error: "Invalid Git ref",
  })
  .refine((ref) => ref.split("/").every(isValidRefComponent), {
    error: "Invalid Git ref",
  });

const githubCommitSchema = z.object({ id: gitOidSchema });

export const githubPushPayloadSchema = z
  .object({
    ref: gitRefSchema,
    before: gitOidSchema,
    after: gitOidSchema,
    forced: z.boolean(),
    created: z.boolean(),
    deleted: z.boolean(),
    commits: z.array(githubCommitSchema),
    repository: z.object({
      full_name: z.string().regex(/^[A-Za-z\d](?:[A-Za-z\d-]{0,37}[A-Za-z\d])?\/[A-Za-z\d._-]+$/),
      size: z.number().nonnegative().finite().optional(),
    }),
  })
  .refine((payload) => payload.created === isZeroOid(payload.before), {
    error: "created must match the before OID",
    path: ["created"],
  })
  .refine((payload) => payload.deleted === isZeroOid(payload.after), {
    error: "deleted must match the after OID",
    path: ["deleted"],
  })
  .refine((payload) => !(payload.created && payload.deleted), {
    error: "A push cannot create and delete the same ref",
  });

export type GitHubPushPayload = z.infer<typeof githubPushPayloadSchema>;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

function isZeroOid(oid: string): boolean {
  return /^0+$/.test(oid);
}

function isValidRefComponent(component: string): boolean {
  return (
    component.length > 0 &&
    !component.startsWith(".") &&
    !component.endsWith(".") &&
    !component.endsWith(".lock")
  );
}
