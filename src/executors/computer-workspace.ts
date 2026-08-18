import type { Workspace } from "@cloudflare/computer";
import { z } from "zod";

import type {
  ExecutionContext,
  ExecutorResult,
  RefChange,
  SyncExecutor,
  SyncPlan,
} from "../types.js";

const CACHE_ROOT = "/artifacts-sync";

export function createComputerWorkspaceExecutor(workspace: Workspace): SyncExecutor {
  return {
    async hasCache(pairKey: string, refs: readonly RefChange[]): Promise<boolean> {
      const dir = `${CACHE_ROOT}/${pairKey}`;
      if (!(await pathExists(workspace, `${dir}/HEAD`))) return false;
      if (refs.some((change) => change.after !== null && change.before === null)) return false;
      const baseOids = refs.flatMap((change) => {
        if (change.after === null || change.before === null) return [];
        return [change.before];
      });
      const available = await Promise.all(baseOids.map((oid) => hasObject(workspace, dir, oid)));
      return available.every(Boolean);
    },

    async execute(plan: SyncPlan, context: ExecutionContext): Promise<ExecutorResult> {
      if (plan.mode === "mirror") {
        throw new Error("The Workspace executor cannot mirror repositories");
      }
      if (plan.refs.length === 0) {
        throw new Error("The Workspace executor requires at least one ref change");
      }
      const dir = `${CACHE_ROOT}/${context.pairKey}`;
      const warm = await pathExists(workspace, `${dir}/HEAD`);
      if (!warm) {
        await workspace.fs.mkdir(dir, { recursive: true });
        await workspace.git.init({ dir, bare: true });
      }

      await workspace.git.remoteAdd({
        dir,
        name: "source",
        url: context.from.url,
        force: true,
      });
      await workspace.git.remoteAdd({
        dir,
        name: "target",
        url: context.to.url,
        force: true,
      });

      for (const change of plan.refs) {
        // Ref updates are intentionally serialized within the pair coordinator.
        // eslint-disable-next-line no-await-in-loop
        await applyRef(workspace, dir, change, context);
      }

      return {
        refs: plan.refs.map((change) => change.ref),
        detail: { cache: warm ? "warm" : "created" },
      };
    },
  };
}

async function hasObject(workspace: Workspace, dir: string, oid: string): Promise<boolean> {
  try {
    await workspace.git.catFile({ dir, oid });
    return true;
  } catch {
    // Missing or unreadable evidence is cold; the planner will select the native-Git path.
    return false;
  }
}

async function pathExists(workspace: Workspace, path: string): Promise<boolean> {
  try {
    await workspace.fs.stat(path);
    return true;
  } catch (error) {
    if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success) return false;
    throw error;
  }
}

async function applyRef(
  workspace: Workspace,
  dir: string,
  change: RefChange,
  context: ExecutionContext,
): Promise<void> {
  if (change.after === null) {
    const deleted = await workspace.git.push({
      dir,
      url: context.to.url,
      remoteRef: change.ref,
      delete: true,
      ...headers(context.to.authorization),
    });
    assertPush(deleted.ok, deleted.error, change.ref);
    return;
  }

  const localRef = `refs/heads/artifacts-sync-${await shortHash(change.ref)}`;
  await workspace.git.fetch({
    dir,
    url: context.from.url,
    ref: localRef,
    remoteRef: change.ref,
    singleBranch: true,
    tags: false,
    ...headers(context.from.authorization),
  });
  const pushed = await workspace.git.push({
    dir,
    url: context.to.url,
    ref: localRef,
    remoteRef: change.ref,
    force: change.forced ?? false,
    ...headers(context.to.authorization),
  });
  assertPush(pushed.ok, pushed.error, change.ref);
}

function headers(authorization: string | undefined): {
  headers?: Record<string, string>;
} {
  return authorization === undefined ? {} : { headers: { Authorization: authorization } };
}

function assertPush(ok: boolean, error: string | null, ref: string): void {
  if (!ok) throw new Error(`Failed to push ${ref}: ${error ?? "unknown Git error"}`);
}

async function shortHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest).slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
