<script lang="ts">
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import Button from "./Button.svelte";
  import { errorView } from "./error-view.ts";

  const view = $derived(errorView(page.status, page.error?.code));
</script>

<svelte:head><title>{view.title} · Reel Capital</title></svelte:head>

<div class="error">
  <p class="code">{view.code}</p>
  <h1>{view.title}</h1>
  <p class="lead" role="alert">{view.message}</p>
  <Button variant="primary" href={view.signIn ? resolve("/acceso") : resolve("/(app)/operar")}>
    {view.signIn ? "Ir al acceso" : "Ir a Operar"}
  </Button>
</div>

<style>
  .error {
    max-width: 32rem;
    padding: 4rem 1rem;
  }
  .code {
    margin: 0 0 0.75rem;
    color: var(--text-dim);
    letter-spacing: 0.04em;
  }
  h1 {
    margin-bottom: 1rem;
    font-size: clamp(28px, 4vw, 40px);
  }
  .lead {
    margin: 0 0 2rem;
    color: var(--text-muted);
  }
</style>
