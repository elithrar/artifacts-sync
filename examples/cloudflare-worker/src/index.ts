import { syncRepos } from "artifacts-sync";

export { SyncCoordinator, SyncWorkflow, WorkspaceProxy } from "artifacts-sync";

export default syncRepos({
  github: "elithrar/artifacts-sync",
  artifacts: "artifacts-sync",
  artifactsRemote:
    "https://d458dbe698b8eef41837f941d73bc5b3.artifacts.cloudflare.net/git/default/artifacts-sync.git",
  direction: "bidirectional",
});
