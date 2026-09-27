// Each chat gets its own lightweight Linux VM (microsandbox, via macOS's
// Hypervisor framework; no Docker). Python + charting/PDF libraries are baked
// into the prepared snapshot. Internet access is an admin-page setting (on by
// default, so the agent can download data, pip install packages, call APIs);
// it applies to sandboxes created after the change. App actions on the owner's
// accounts go through Composio, not this sandbox.
import { defineSandbox } from "eve/sandbox";
import { MicrosandboxSandbox } from "eve/sandbox/microsandbox";

import { getSettings } from "./lib/settings";

export const environment = MicrosandboxSandbox.image("python:3.12-slim", {
  prepare: async (sandbox) => {
    const result = await sandbox.run({
      command: "pip install --no-cache-dir matplotlib pandas pillow reportlab openpyxl",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr);
  },
});

export default defineSandbox(() =>
  environment.open({ networkPolicy: getSettings().sandboxInternet ? "allow-all" : "deny-all" }),
);
