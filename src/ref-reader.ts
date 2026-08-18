import git from "isomorphic-git";
import http from "isomorphic-git/http/web";

import type { RefReader, ResolvedRepository } from "./types.js";

export function createRemoteRefReader(): RefReader {
  return {
    async read(repository: ResolvedRepository, ref: string): Promise<string | undefined> {
      const refs = await git.listServerRefs({
        http,
        url: repository.url,
        prefix: ref,
        protocolVersion: 2,
        ...(repository.authorization === undefined
          ? {}
          : { headers: { Authorization: repository.authorization } }),
      });
      return refs.find((candidate) => candidate.ref === ref)?.oid;
    },
  };
}
