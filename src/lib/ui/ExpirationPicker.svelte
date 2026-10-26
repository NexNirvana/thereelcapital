<script lang="ts">
  import type { ExpirationMonth } from "./expirations.ts";

  // Plain links, so picking works without JavaScript. `href` comes from the page, which builds it
  // with resolve() (the `?vencimiento=` contract stays there).
  let {
    months,
    selected,
    href,
  }: { months: ReadonlyArray<ExpirationMonth>; selected: string; href: (date: string) => string } =
    $props();

  // On a phone the strip scrolls: bring the selected date into view (only horizontally).
  let strip: HTMLElement | undefined = $state();
  $effect(() => {
    const current = strip?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!strip || !current) return;
    strip.scrollLeft = current.offsetLeft - (strip.clientWidth - current.offsetWidth) / 2;
  });
</script>

<div class="picker" bind:this={strip}>
  {#each months as month (month.key)}
    <section class="month" aria-labelledby="exp-{month.key}">
      <h3 id="exp-{month.key}">{month.label}</h3>
      <ul>
        {#each month.chips as chip (chip.date)}
          <li>
            <!-- eslint-disable svelte/no-navigation-without-resolve -- built with resolve() by the page -->
            <a
              href={href(chip.date)}
              class:today={chip.isToday}
              aria-current={chip.date === selected ? "page" : undefined}
              aria-label={chip.ariaLabel}>{chip.label}</a
            >
            <!-- eslint-enable svelte/no-navigation-without-resolve -->
          </li>
        {/each}
      </ul>
    </section>
  {/each}
</div>

<style>
  .picker {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    gap: 1rem 1.5rem;
  }
  .month {
    max-width: 100%;
  }
  h3 {
    margin: 0 0 0.375rem;
    color: var(--text-dim);
    font-size: 14px;
    font-weight: 500;
    text-transform: uppercase;
    white-space: nowrap;
  }
  ul {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  a {
    display: inline-flex;
    align-items: center;
    min-height: var(--target);
    padding: 0 0.875rem;
    border: 1px solid var(--rule-strong);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    text-decoration: none;
    white-space: nowrap;
  }
  a.today {
    color: var(--text);
  }
  a[aria-current="page"] {
    border-color: var(--text);
    background: var(--text);
    color: var(--bg);
    font-weight: 600;
  }

  /* On a phone the months run in one strip that scrolls sideways. */
  @media (max-width: 640px) {
    .picker {
      flex-wrap: nowrap;
      overflow-x: auto;
      padding-bottom: 0.5rem;
    }
    .month {
      flex: none;
      max-width: none;
    }
    ul {
      flex-wrap: nowrap;
    }
  }
</style>
