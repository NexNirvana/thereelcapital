// Applies .github/rulesets/*.json to a repository, creating or updating by name.
// Usage: bun run scripts/apply-rulesets.ts <owner/repo>
import { $ } from "bun";
import { Glob } from "bun";

const repo = Bun.argv[2];
if (!repo?.match(/^[\w.-]+\/[\w.-]+$/)) {
  console.error("usage: bun run scripts/apply-rulesets.ts <owner/repo>");
  process.exit(1);
}

const dir = new URL("../.github/rulesets/", import.meta.url).pathname;
// Only this repository's own rulesets: after the transfer, organization rulesets
// would otherwise be listed too and could match by name. --slurp joins the pages
// into one array of page arrays.
const pages: { id: number; name: string }[][] =
  await $`gh api --paginate --slurp repos/${repo}/rulesets?includes_parents=false`.json();
const existing = pages.flat();

for (const file of new Glob("*.json").scanSync(dir)) {
  const body = await Bun.file(dir + file).text();
  const { name } = JSON.parse(body) as { name: string };
  const id = existing.find((r) => r.name === name)?.id;
  const [method, path] = id
    ? ["PUT", `repos/${repo}/rulesets/${id}`]
    : ["POST", `repos/${repo}/rulesets`];
  await $`gh api -X ${method} ${path} --input - < ${new Response(body)}`.quiet();
  console.log(`${id ? "updated" : "created"} ${name}`);
}
