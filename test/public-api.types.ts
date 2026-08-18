import { SyncCoordinator, SyncWorkflow, WorkspaceProxy, syncRepos } from "../src/index.js";

void SyncCoordinator;
void SyncWorkflow;
void WorkspaceProxy;

syncRepos({
  github: "elithrar/project",
  artifacts: "project",
  direction: "bidirectional",
});

// @ts-expect-error GitHub repository literals require the owner/repo form.
syncRepos({ github: "project", artifacts: "project", direction: "bidirectional" });

// @ts-expect-error Repository constructors are intentionally not part of the public API.
import { github } from "../src/index.js";
void github;
