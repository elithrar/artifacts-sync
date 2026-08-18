import { syncRepos } from "@elithrar/artifacts-sync";

export { SyncCoordinator, SyncWorkflow, WorkspaceProxy } from "@elithrar/artifacts-sync";

export default syncRepos([
  {
    github: "elithrar/example",
    artifacts: "example",
    direction: "bidirectional",
  },
  {
    github: "elithrar/example-staging",
    artifacts: "staging/example",
    artifactsBinding: "STAGING_ARTIFACTS",
    direction: "bidirectional",
  },
]);
