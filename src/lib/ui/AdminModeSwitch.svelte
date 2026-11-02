<script lang="ts">
  // The admin reads both modes (D52), one at a time and always labeled: two links to the same page.
  // `base` is a resolved path.
  import type { TradingMode } from "#lib/server/trading-mode.ts";

  let { base, mode }: { base: string; mode: TradingMode } = $props();
  const links = $derived(
    (["SIM", "REAL"] as const).map((option) => ({ option, href: `${base}?modo=${option}` })),
  );
</script>

<nav class="modes" aria-label="Modo">
  {#each links as { option, href } (option)}
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- `base` is a resolved path -->
    <a class:current={option === mode} aria-current={option === mode ? "page" : undefined} {href}
      >{option}</a
    >
  {/each}
</nav>

<style>
  .modes {
    display: flex;
    gap: 0.5rem;
    margin-block: 1rem;
  }
  a {
    min-width: 4.5rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: var(--target);
    padding: 0 1rem;
    border: 1px solid var(--rule);
    color: var(--text);
    text-align: center;
    text-decoration: none;
  }
  a.current {
    background: var(--text);
    color: var(--on-primary);
  }
</style>
