<script lang="ts">
  import { resolve } from "$app/paths";
  import Badge from "#lib/ui/Badge.svelte";
  import SignOutButton from "#lib/ui/SignOutButton.svelte";
  import type { LayoutProps } from "./$types";

  let { children }: LayoutProps = $props();
</script>

<div class="admin">
  <header>
    <a class="wordmark" href={resolve("/admin")}>REEL CAPITAL</a>
    <Badge label="Admin" />
    <Badge label="SIM" />
    <nav aria-label="Administración">
      <a href={resolve("/admin")} aria-current="page">Clientes</a>
    </nav>
    <a class="back" href={resolve("/(app)/operar")}>Operar</a>
    <span class="signout"><SignOutButton /></span>
  </header>
  <main>{@render children()}</main>
</div>

<style>
  .admin {
    min-height: 100dvh;
    padding: 0 clamp(1rem, 4vw, 2rem);
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0 1.25rem;
    min-height: 70px;
    border-bottom: 1px solid var(--rule);
  }
  a {
    display: inline-flex;
    align-items: center;
    min-height: var(--target);
    color: var(--text-muted);
    text-decoration: none;
  }
  .wordmark {
    color: var(--text);
    font-weight: 600;
    letter-spacing: -0.04em;
  }
  nav a {
    border-bottom: 2px solid transparent;
  }
  nav a[aria-current="page"] {
    border-bottom-color: var(--text);
    color: var(--text);
    font-weight: 500;
  }
  .back {
    margin-left: auto;
  }
  .signout {
    color: var(--text-muted);
  }
  main {
    max-width: 1100px;
    padding: 2.5rem 0.5rem;
  }
  @media (max-width: 900px) {
    header {
      gap: 0 0.75rem;
    }
    main {
      padding: 1.5rem 0;
    }
  }
</style>
