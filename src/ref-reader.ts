import git from "isomorphic-git";
import http from "isomorphic-git/http/web";

import type { RefReader, ResolvedRepository } from "./types.js";

interface GitAuthentication {
  readonly headers?: Readonly<Record<string, string>>;
}

export function createRemoteRefReader(): RefReader {
  return {
    async read(repository: ResolvedRepository, ref: string): Promise<string | null> {
      const authentication = authenticationHeaders(repository.authorization);
      const refs = await git.listServerRefs({
        http,
        url: repository.url,
        prefix: ref,
        protocolVersion: 2,
        ...authentication,
      });
      return refs.find((candidate) => candidate.ref === ref)?.oid ?? null;
    },
  };
}

function authenticationHeaders(authorization: string | undefined): GitAuthentication {
  if (authorization === undefined) return {};
  return { headers: { Authorization: authorization } };
}
