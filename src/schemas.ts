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
  .refine((ref) => !ref.endsWith("/") && !ref.endsWith(".") && !ref.endsWith(".lock"), {
    error: "Invalid Git ref",
  });

const githubCommitSchema = z.object({ id: gitOidSchema });

export const githubPushPayloadSchema = z.object({
  ref: gitRefSchema,
  before: gitOidSchema,
  after: gitOidSchema,
  forced: z.boolean(),
  created: z.boolean().optional(),
  deleted: z.boolean().optional(),
  commits: z.array(githubCommitSchema).optional(),
  repository: z.object({
    full_name: z.string().regex(/^[A-Za-z\d](?:[A-Za-z\d-]{0,37}[A-Za-z\d])?\/[A-Za-z\d._-]+$/),
    size: z.number().nonnegative().finite().optional(),
  }),
});

export type GitHubPushPayload = z.infer<typeof githubPushPayloadSchema>;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}
