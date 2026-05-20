import { additionalFiles } from "@trigger.dev/build/extensions/core";
import { pythonExtension } from "@trigger.dev/python/extension";
import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_wwx_configure_me",
  dirs: ["./trigger"],
  build: {
    extensions: [
      additionalFiles({
        files: ["engines/ww-2-runtime/**"],
      }),
      pythonExtension({
        requirements: [
          "anthropic>=0.75.0",
          "requests>=2.32.0",
          "python-dotenv>=1.0.0",
        ],
        scripts: ["engines/ww-2-runtime/tools/**/*.py"],
      }),
    ],
  },
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 2_000,
      maxTimeoutInMs: 60_000,
      factor: 2,
      randomize: true,
    },
  },
  maxDuration: 60 * 60 * 6,
});
