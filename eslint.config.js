import prettier from "eslint-config-prettier";
import path from "node:path";
import js from "@eslint/js";
import svelte from "eslint-plugin-svelte";
import { defineConfig, includeIgnoreFile } from "eslint/config";
import globals from "globals";
import ts from "typescript-eslint";

const gitignorePath = path.resolve(import.meta.dirname, ".gitignore");

export default defineConfig(
  includeIgnoreFile(gitignorePath),
  { ignores: ["**/worker-configuration.d.ts"] },
  js.configs.recommended,
  ts.configs.recommended,
  svelte.configs.recommended,
  prettier,
  svelte.configs.prettier,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      // typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
      // see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
      "no-undef": "off",
      // The app is served from the domain root (no base path) and links to routes added by later issues.
      "svelte/no-navigation-without-resolve": "off",
    },
  },
  {
    files: ["**/*.svelte", "**/*.svelte.ts", "**/*.svelte.js"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        extraFileExtensions: [".svelte"],
        parser: ts.parser,
      },
    },
  },
  {
    // Worker code runs in workerd: no Bun APIs outside unit tests and scripts (CONTRIBUTING.md#bun).
    ignores: ["**/*.test.ts", "scripts/**"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "Bun", message: "Worker code must not use Bun APIs." },
      ],
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["bun:*"], message: "Only unit tests import bun:*." }] },
      ],
    },
  },
);
