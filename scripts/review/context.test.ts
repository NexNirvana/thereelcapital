import { expect, test } from "bun:test";
import {
  docsFor,
  instructionsFor,
  linkedIssues,
  parseApplyTo,
  parseIgnorePatterns,
  reviewablePaths,
  unignoredPaths,
  skillsFor,
} from "./context.ts";

test("parses applyTo globs from front matter", () => {
  const content = '---\napplyTo: "src/a/**,src/b.ts"\n---\n# Title';
  expect(parseApplyTo(content)).toEqual(["src/a/**", "src/b.ts"]);
  expect(parseApplyTo("# no front matter")).toEqual([]);
});

test("chooses skills by changed path", () => {
  expect(skillsFor(["src/lib/domain/limits.ts"])).toEqual(["reel-trading"]);
  expect(skillsFor(["engine/src/broker/tradestation-client.ts"])).toEqual([
    "reel-trading",
    "tradestation-integration",
    "reel-security-review",
  ]);
  expect(skillsFor(["src/routes/access/+page.svelte"])).toEqual(["reel-design-system"]);
  expect(skillsFor(["src/hooks.server.ts"])).toEqual(["reel-security-review"]);
  expect(skillsFor(["package.json"])).toEqual([]);
});

test("chooses path-scoped instructions and docs", () => {
  const files = [
    { path: "domain.md", applyTo: ["src/lib/domain/**"] },
    { path: "ui.md", applyTo: ["src/routes/**/*.svelte", "src/lib/ui/**"] },
  ];
  expect(instructionsFor(["src/routes/a/+page.svelte"], files)).toEqual(["ui.md"]);
  const docs = [
    { path: "docs/all.md", scope: [] },
    { path: "docs/engine.md", scope: ["engine/**"] },
  ];
  expect(docsFor(["src/x.ts"], docs)).toEqual(["docs/all.md"]);
  expect(docsFor(["engine/src/x.ts"], docs)).toEqual(["docs/all.md", "docs/engine.md"]);
});

test("drops Markdown and ignored paths from the reviewable set", () => {
  const ignore = parseIgnorePatterns("bun.lock\n**/worker-configuration.d.ts\ndesigns/**");
  expect(
    reviewablePaths(
      ["README.md", "bun.lock", "engine/worker-configuration.d.ts", "designs/a.png"],
      ignore,
    ),
  ).toEqual([]);
  expect(reviewablePaths(["src/a.ts", "docs/x.md"], ignore)).toEqual(["src/a.ts"]);
});

test("keeps Markdown in the context but not ignored files", () => {
  const ignore = parseIgnorePatterns("bun.lock");
  expect(unignoredPaths(["docs/x.md", "bun.lock", "src/a.ts"], ignore)).toEqual([
    "docs/x.md",
    "src/a.ts",
  ]);
});

test("finds linked issues in the PR body", () => {
  expect(linkedIssues("Closes #97\n\nalso fixes #12 and Closes #97")).toEqual([97, 12]);
  expect(linkedIssues("no links")).toEqual([]);
});
