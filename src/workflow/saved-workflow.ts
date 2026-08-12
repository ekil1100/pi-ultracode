import * as os from "node:os";
import * as path from "node:path";
import {
  artifactPathExists,
  readContainedArtifactFile,
} from "./run-artifacts.ts";

export interface SavedWorkflowSource {
  script: string;
  sourcePath: string;
  scope: "project" | "user";
}

/** Discover an ambient saved workflow without crossing the project-trust gate. */
export function readSavedWorkflowByName(
  name: string,
  cwd: string,
  projectTrusted: boolean,
): SavedWorkflowSource | undefined {
  const roots: Array<{ root: string; scope: "project" | "user" }> = [
    ...(projectTrusted ? [{ root: cwd, scope: "project" as const }] : []),
    { root: os.homedir(), scope: "user" },
  ];
  for (const { root, scope } of roots) {
    const directory = path.join(root, ".pi", "ultracode", "workflows");
    for (const candidate of [`${name}.workflow.js`, `${name}.js`]) {
      const sourcePath = path.join(directory, candidate);
      if (!artifactPathExists(sourcePath)) continue;
      return {
        script: readContainedArtifactFile(root, sourcePath, "saved workflow", 16 * 1024 * 1024),
        sourcePath,
        scope,
      };
    }
  }
  return undefined;
}
