<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    /** Path above the title; an item with an `href` is a link back. */
    crumb: { label: string; href?: string }[];
    title: string;
    /** Keep the title's own casing (an e-mail address is read as typed). */
    verbatim?: boolean;
    lead?: Snippet;
  }

  let { crumb, title, verbatim = false, lead }: Props = $props();
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- every href arrives from the caller already built with resolve() -->
<header>
  <p class="crumb">
    {#each crumb as item, index (index)}
      {#if index > 0}
        /
      {/if}
      {#if item.href}<a href={item.href}>{item.label}</a>{:else}{item.label}{/if}
    {/each}
  </p>
  <h1 class:verbatim>{title}</h1>
  {#if lead}<p class="lead">{@render lead()}</p>{/if}
</header>

<!-- eslint-enable svelte/no-navigation-without-resolve -->

<style>
  header {
    margin-bottom: 2rem;
  }
  .crumb {
    margin: 0 0 1rem;
    color: var(--text-dim);
    font-size: 14px;
  }
  .crumb a {
    display: inline-flex;
    align-items: center;
    min-height: var(--target);
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  h1 {
    margin: 0;
    font-size: clamp(32px, 4vw, 42px);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: -0.02em;
  }
  h1.verbatim {
    font-size: clamp(22px, 4vw, 32px);
    text-transform: none;
    overflow-wrap: anywhere;
  }
  .lead {
    max-width: 40rem;
    margin: 0.75rem 0 0;
    color: var(--text-muted);
  }
</style>
