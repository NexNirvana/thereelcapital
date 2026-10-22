import adapter from "@sveltejs/adapter-cloudflare";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    sveltekit({
      compilerOptions: {
        // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
      },
      adapter: adapter(),
      // SvelteKit adds a nonce (or hash, when prerendered) to its own inline scripts and styles.
      // The Cloudflare Web Analytics beacon is injected at the edge in production (D26): it loads
      // from static.cloudflareinsights.com and reports to cloudflareinsights.com. The OAuth
      // connect form posts here and is redirected to TradeStation's sign-in page.
      csp: {
        directives: {
          "default-src": ["none"],
          "script-src": ["self", "https://static.cloudflareinsights.com"],
          "style-src": ["self"],
          // Style attributes only (the layout wrapper, Svelte's dynamic styles): they cannot run
          // script, and stylesheets stay limited to our own origin.
          "style-src-attr": ["unsafe-inline"],
          "img-src": ["self", "data:"],
          "font-src": ["self"],
          "connect-src": ["self", "https://cloudflareinsights.com"],
          "form-action": ["self", "https://signin.tradestation.com"],
          "base-uri": ["none"],
          "object-src": ["none"],
          "frame-ancestors": ["none"],
          "manifest-src": ["self"],
        },
      },
    }),
  ],
});
