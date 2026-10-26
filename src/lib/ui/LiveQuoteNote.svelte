<script lang="ts">
  import { LIVE_QUOTE_STALE_AFTER_MS } from "#lib/domain/config.ts";
  import { formatSnapshotTime } from "#lib/ui/option-chain.ts";

  // «Precio de las 10:00:05»: when the price on screen was read, in New York time. The age counts
  // from the moment it reached this page (a local clock, like the chain's), so a poll that stops
  // or keeps failing calls the price out of date without trusting the server's clock.
  let { receivedAt }: { receivedAt: number } = $props();

  let arrivedAt = $state(Date.now());
  let now = $state(Date.now());
  $effect(() => {
    void receivedAt;
    arrivedAt = Date.now();
    now = arrivedAt;
  });
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const stale = $derived(now - arrivedAt > LIVE_QUOTE_STALE_AFTER_MS);
</script>

<p class="live" class:stale>
  <span>Precio de las {formatSnapshotTime(receivedAt)} (Nueva York)</span>
  <span aria-live="polite">{stale ? "· desactualizado" : "· se actualiza solo"}</span>
</p>

<style>
  .live {
    margin: 1rem 0 0;
    color: var(--text-dim);
    font-size: 14px;
  }
  .stale {
    color: var(--text);
    font-weight: 500;
  }
</style>
