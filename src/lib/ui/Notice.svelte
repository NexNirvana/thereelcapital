<script lang="ts">
  import type { Snippet } from "svelte";

  // "alert" for failures that need attention now, "status" for the rest.
  let {
    title,
    role = "status",
    children,
  }: { title: string; role?: "status" | "alert"; children?: Snippet } = $props();
</script>

<div class="notice" {role}>
  <strong>{title}</strong>
  {#if children}<div class="body">{@render children()}</div>{/if}
</div>

<style>
  .notice {
    padding: 1rem;
    border: 1px solid var(--rule-strong);
    overflow-wrap: anywhere;
  }
  .body {
    margin: 0.25rem 0 0;
    color: var(--text-muted);
  }
</style>
