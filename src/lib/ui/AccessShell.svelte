<script lang="ts">
  import type { Snippet } from "svelte";

  // The frame of the pre-login screens (access, recovery, activation): wordmark, one column of
  // content, domain footer. Layout only; the steps are the pages' business.
  let { children }: { children: Snippet } = $props();
</script>

<div class="access">
  <header>
    <span class="wordmark">REEL<br class="desktop-only" /> CAPITAL</span>
    <span class="private desktop-only">Acceso privado</span>
  </header>

  <main>
    {@render children()}
  </main>

  <footer>
    <small>thereelcapital.com</small>
    <small class="desktop-only">REEL CAPITAL</small>
  </footer>
</div>

<style>
  .access {
    display: grid;
    grid-template-rows: auto 1fr auto;
    min-height: 100dvh;
    padding: 1.5rem clamp(1rem, 4vw, 3rem);
  }
  header,
  footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    color: var(--text-muted);
  }
  .wordmark {
    line-height: 1.05;
    color: var(--text);
    font-weight: 600;
    letter-spacing: -0.04em;
  }
  main {
    align-self: center;
    width: min(100%, 32rem);
    margin-inline: clamp(0rem, 7vw, 6rem) auto;
    padding: 3rem 0;
  }
  @media (max-width: 900px) {
    .desktop-only {
      display: none;
    }
    main {
      margin-inline: 0;
      padding: 2rem 0;
    }
  }
</style>
