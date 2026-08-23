import {
  SyncCoordinator,
  SyncWorkflow,
  WorkspaceProxy,
  syncRepos,
  type OriginSyncReposOptions,
  type SyncReposOptions,
} from "../src/index.js";

void SyncCoordinator;
void SyncWorkflow;
void WorkspaceProxy;

syncRepos({
  github: "elithrar/project",
  artifacts: "project",
  direction: "bidirectional",
});

const originToArtifacts = {
  origin: "cursor/project",
  originInstallationId: "installation-1",
  artifacts: "project",
  direction: "origin-to-artifacts",
} satisfies OriginSyncReposOptions;

const extractedPairs = [
  originToArtifacts,
  {
    origin: "cursor/another-project",
    originInstallationId: "installation-1",
    artifacts: "another-project",
    direction: "artifacts-to-origin",
  },
] satisfies readonly SyncReposOptions[];

syncRepos(extractedPairs);

syncRepos({
  origin: "cursor/project",
  originInstallationId: "installation-1",
  artifacts: "project",
  direction: "artifacts-to-origin",
});

// @ts-expect-error GitHub repository literals require the owner/repo form.
syncRepos({ github: "project", artifacts: "project", direction: "bidirectional" });

// @ts-expect-error Every pair has exactly one non-Artifact peer.
syncRepos({
  github: "elithrar/project",
  origin: "cursor/project",
  originInstallationId: "installation-1",
  artifacts: "project",
  direction: "bidirectional",
});

// @ts-expect-error Artifacts is required for every pair.
syncRepos({
  origin: "cursor/project",
  originInstallationId: "installation-1",
  direction: "origin-to-artifacts",
});

// @ts-expect-error Repository constructors are intentionally not part of the public API.
import { github } from "../src/index.js";
void github;
