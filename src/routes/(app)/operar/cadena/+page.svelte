<script lang="ts">
  import { invalidate } from "$app/navigation";
  import { resolve } from "$app/paths";
  import {
    LIVE_CHAIN_REFRESH_FACTOR,
    LIVE_QUOTE_MAX_BACKOFF_MS,
    LIVE_QUOTE_MAX_POLLS,
    LIVE_QUOTE_POLL_MS,
  } from "#lib/domain/config.ts";
  import Button from "#lib/ui/Button.svelte";
  import {
    chainFromMessage,
    chainSymbols,
    readLiveChain,
    type LiveChain,
  } from "#lib/ui/live-chain.ts";
  import { startLiveFeed } from "#lib/ui/live-feed.ts";
  import ExpirationField from "#lib/ui/ExpirationField.svelte";
  import Notice from "#lib/ui/Notice.svelte";
  import {
    formatAge,
    formatExpiration,
    formatQuote,
    formatSnapshotTime,
    formatStrike,
    isStale,
  } from "#lib/ui/option-chain.ts";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  let typedUnderlying = $derived(data.underlying);
  const withAccount = (params: Record<string, string>) =>
    new URLSearchParams(data.accountId === null ? params : { ...params, cuenta: data.accountId });

  // The bid and ask keep updating while the screen is open (D46). They are display only: picking a
  // contract carries just its symbol, and the order is priced when it is sent. A newer load
  // (`Actualizar`, another expiration) replaces what the poll last showed.
  let live = $state<{ loaded: string; chain: LiveChain } | null>(null);
  // Names the load the poll started from; a plain string, since $state would proxy an object.
  const loaded = $derived(
    data.chain === null ? null : `${data.underlying} ${data.expiration} ${data.chain.receivedAt}`,
  );
  const shown = $derived(live !== null && live.loaded === loaded ? live.chain : data.chain);
  const quotesHref = $derived(
    data.chain === null
      ? null
      : `${resolve("/(app)/operar/cadena/cotizaciones")}?${withAccount({
          subyacente: data.underlying,
          vencimiento: data.expiration,
        })}`,
  );
  // The quotes of a chain cost one request per 100 contracts, so a long chain polls proportionally
  // slower and one open screen stays inside the quotes budget.
  const pollMs = $derived(
    LIVE_QUOTE_POLL_MS * Math.max(1, Math.ceil(((data.chain?.strikes.length ?? 0) * 2) / 100)),
  );
  $effect(() => {
    const href = quotesHref;
    const source = loaded;
    if (href === null || source === null) return;
    const base = data.chain;
    // The last full read: it names the contracts to watch and to recognize in the pushes.
    let reference = base;
    // The socket pushes every tick of the contracts on screen (D47); the poll of D46 runs only
    // while it is not delivering.
    const feed = startLiveFeed({
      watch: () => ({
        type: "watch",
        symbols: reference === null ? [] : chainSymbols(reference),
      }),
      onMessage: (message) => {
        const current = live !== null && live.loaded === source ? live.chain : base;
        const next =
          current === null ? null : chainFromMessage(current, message, reference ?? current);
        if (next !== null) live = { loaded: source, chain: next };
      },
      // Contracts with no market at load are not watched; a slow full read brings them in.
      refreshMs: pollMs * LIVE_CHAIN_REFRESH_FACTOR,
      poll: {
        intervalMs: pollMs,
        maxPolls: LIVE_QUOTE_MAX_POLLS,
        maxBackoffMs: LIVE_QUOTE_MAX_BACKOFF_MS,
        run: async (signal) => {
          const answer = await readLiveChain(href, fetch, signal);
          // An answer for a chain that is no longer on screen is dropped.
          if (answer !== null && !signal.aborted) {
            live = { loaded: source, chain: answer };
            // A contract that has a market now joins the stream.
            const changed =
              reference === null || chainSymbols(answer).join() !== chainSymbols(reference).join();
            reference = answer;
            if (changed) feed.rewatch();
          }
          return answer !== null;
        },
      },
    });
    return feed;
  });

  // The age counts from the moment this snapshot reached the page. It is a local clock for the
  // label only.
  let elapsedMs = $state(0);
  $effect(() => {
    if (shown === null) return;
    void shown.receivedAt;
    elapsedMs = 0;
    const startedAt = Date.now();
    const timer = setInterval(() => (elapsedMs = Date.now() - startedAt), 1000);
    return () => clearInterval(timer);
  });
  const stale = $derived(isStale(elapsedMs));

  let refreshing = $state(false);
  async function refresh(event: SubmitEvent) {
    event.preventDefault();
    refreshing = true;
    try {
      await invalidate("app:chain");
    } finally {
      refreshing = false;
    }
  }

  const expirationFields = $derived({
    subyacente: data.underlying,
    ...(data.accountId === null ? {} : { cuenta: data.accountId }),
  });
  const chainPath = resolve("/(app)/operar/cadena");
  const entryPath = resolve("/(app)/operar");
  const expirationHref = (expiration: string) =>
    `${chainPath}?${withAccount({ subyacente: data.underlying, vencimiento: expiration })}`;
  // The symbol is the exact one TradeStation listed; /operar asks the engine what it stands for.
  const contractHref = (symbol: string) =>
    `${entryPath}?${withAccount({ tipo: "opciones", simbolo: symbol })}`;
  const backHref = $derived(`${entryPath}?${withAccount({ tipo: "opciones" })}`);

  function pickLabel(name: string, strike: number, side: { bid: number; ask: number }): string {
    return `Elegir ${name} ${formatStrike(strike)}, bid ${formatQuote(side.bid)}, ask ${formatQuote(side.ask)}`;
  }

  function bidAsk(side: { bid: number; ask: number }): string {
    return `${formatQuote(side.bid)} / ${formatQuote(side.ask)}`;
  }
</script>

<svelte:head><title>Cadena de opciones · Reel Capital</title></svelte:head>

<div class="page">
  <header class="head">
    <p class="crumb">Operar / Cadena de opciones</p>
    <h1>Cadena de opciones</h1>
    <p class="lead">Elige el subyacente, el vencimiento y el contrato.</p>
  </header>

  <section class="step" aria-label="Buscar subyacente">
    <form method="GET" action={chainPath}>
      {#if data.accountId !== null}<input type="hidden" name="cuenta" value={data.accountId} />{/if}
      <label class="field">
        <span>Subyacente</span>
        <input
          class="symbol"
          name="subyacente"
          bind:value={typedUnderlying}
          maxlength="16"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          placeholder="MSFT"
        />
      </label>
      <Button type="submit" variant="outline">Buscar</Button>
    </form>
  </section>

  {#if data.problem}
    <Notice title="No pudimos mostrar la cadena" role="alert">{data.problem}</Notice>
  {/if}

  {#if data.expirations}
    <section class="step" aria-label="Vencimiento">
      <ExpirationField
        action={chainPath}
        fields={expirationFields}
        expirations={data.expirations}
        text={data.expirationText}
        nowMs={data.nowMs}
        choice={data.choice}
        hrefFor={expirationHref}
      />
      {#if data.notice}<p class="fallback" role="status">{data.notice}</p>{/if}
    </section>
  {/if}

  {#if data.chain && shown}
    <section class="chain" aria-label="Contratos">
      <div class="chain-head">
        <h2>{data.underlying} <span>· {formatExpiration(data.expiration)}</span></h2>
        <form method="GET" action={chainPath} onsubmit={refresh}>
          <input type="hidden" name="subyacente" value={data.underlying} />
          <input type="hidden" name="vencimiento" value={data.expiration} />
          {#if data.accountId !== null}<input
              type="hidden"
              name="cuenta"
              value={data.accountId}
            />{/if}
          <Button type="submit" variant="outline" disabled={refreshing}>
            {refreshing ? "Actualizando…" : "Actualizar"}
          </Button>
        </form>
      </div>
      <p class="freshness" class:stale>
        <span>Datos de las {formatSnapshotTime(shown.receivedAt)} (Nueva York)</span>
        <span>· {formatAge(elapsedMs)}</span>
        <span aria-live="polite"
          >{#if stale}· desactualizados, actualiza para ver precios vigentes{:else}· se actualizan
            solos{/if}</span
        >
      </p>

      <table class:stale>
        <caption class="sr">
          Strikes de {data.underlying} con vencimiento {formatExpiration(data.expiration)}: bid y
          ask en dólares de cada Call y Put.
        </caption>
        <thead>
          <tr>
            <th scope="col">Strike (US$)</th>
            <th scope="col">Call <small>bid / ask</small></th>
            <th scope="col">Put <small>bid / ask</small></th>
          </tr>
        </thead>
        <tbody>
          {#each shown.strikes as row (row.strike)}
            <tr>
              <th scope="row">{formatStrike(row.strike)}</th>
              {#each [{ side: row.call, name: "Call" }, { side: row.put, name: "Put" }] as { side, name } (name)}
                <td>
                  {#if side}
                    <!-- eslint-disable svelte/no-navigation-without-resolve -- built with resolve() above -->
                    <a
                      class="pick"
                      href={contractHref(side.symbol)}
                      aria-label={pickLabel(name, row.strike, side)}>{bidAsk(side)}</a
                    >
                    <!-- eslint-enable svelte/no-navigation-without-resolve -->
                  {:else}
                    <span class="missing">Sin dato</span>
                  {/if}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
      <p class="note">
        «Sin dato»: el contrato existe, pero TradeStation no mostró bid y ask. No se puede elegir.
      </p>
    </section>
  {/if}

  <footer class="foot">
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- built with resolve() above -->
    <a class="back" href={backHref}>← Volver a Nueva entrada</a>
    <p class="mode">SIM · Simulación, sin dinero real</p>
  </footer>
</div>

<style>
  .page {
    display: grid;
    gap: 2rem;
    max-width: 760px;
  }
  .crumb {
    margin: 0 0 1rem;
    color: var(--text-dim);
    font-size: 14px;
  }
  h1 {
    margin: 0;
    font-size: clamp(32px, 4vw, 42px);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: -0.02em;
  }
  .lead {
    margin: 0.75rem 0 0;
    color: var(--text-muted);
  }
  .field {
    display: block;
    margin-bottom: 1rem;
  }
  .field > span {
    display: block;
    margin: 0 0 0.375rem;
    color: var(--text-dim);
    font-size: 14px;
  }
  .symbol {
    box-sizing: border-box;
    width: 100%;
    min-height: 64px;
    margin: 0;
    padding: 0.75rem 1rem;
    border: 1px solid var(--rule-strong);
    border-radius: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 28px;
    font-weight: 600;
  }
  .step form :global(.button) {
    min-width: 11rem;
  }

  .fallback {
    margin: 0.75rem 0 0;
    color: var(--text-muted);
  }

  .chain-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  h2 {
    margin: 0;
    font-size: 24px;
    font-weight: 600;
  }
  h2 span {
    color: var(--text-muted);
    font-weight: 500;
  }
  .freshness {
    margin: 0.75rem 0 1.5rem;
    color: var(--text-dim);
    font-size: 14px;
  }
  .freshness span {
    white-space: nowrap;
  }
  .freshness span:last-child {
    white-space: normal;
  }
  .freshness.stale {
    color: var(--text);
    font-weight: 500;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    border-top: 1px solid var(--rule);
    font-variant-numeric: tabular-nums;
  }
  table.stale td {
    opacity: 0.6;
  }
  th,
  td {
    padding: 0;
    border-bottom: 1px solid var(--rule);
    text-align: right;
  }
  thead th {
    padding: 0.75rem 0.5rem;
    color: var(--text-dim);
    font-size: 14px;
    font-weight: 400;
  }
  thead small {
    display: block;
    font-size: 12px;
  }
  tbody th {
    padding: 0 0.5rem;
    text-align: left;
    font-weight: 600;
  }
  thead th:first-child {
    text-align: left;
  }
  .pick,
  .missing {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    min-height: var(--target);
    padding: 0 0.5rem;
  }
  .pick {
    color: var(--text);
    text-decoration: underline;
    text-underline-offset: 4px;
  }
  .missing {
    color: var(--text-dim);
  }
  .note {
    margin: 1rem 0 0;
    color: var(--text-dim);
    font-size: 14px;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .back {
    color: var(--text);
    text-underline-offset: 4px;
  }
  .mode {
    margin: 1.5rem 0 0;
    color: var(--text-dim);
    font-size: 14px;
  }

  @media (max-width: 480px) {
    .pick,
    .missing {
      font-size: 14px;
    }
  }
</style>
