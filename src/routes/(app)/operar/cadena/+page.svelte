<script lang="ts">
  import { invalidate } from "$app/navigation";
  import { resolve } from "$app/paths";
  import Button from "#lib/ui/Button.svelte";
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

  // The age counts from the moment this snapshot reached the page. It is a local clock for the
  // label only: nothing is fetched until the client asks (`Actualizar`).
  let elapsedMs = $state(0);
  $effect(() => {
    if (data.chain === null) return;
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

  const chainPath = resolve("/(app)/operar/cadena");
  const entryPath = resolve("/(app)/operar");
  const withAccount = (params: Record<string, string>) =>
    new URLSearchParams(data.accountId === null ? params : { ...params, cuenta: data.accountId });
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
    <section class="step" aria-label="Vencimientos">
      <p class="label">Vencimiento</p>
      <ul class="expirations">
        {#each data.expirations as expiration (expiration)}
          <li>
            <!-- eslint-disable svelte/no-navigation-without-resolve -- built with resolve() above -->
            <a
              href={expirationHref(expiration)}
              aria-current={expiration === data.expiration ? "page" : undefined}
              >{formatExpiration(expiration)}</a
            >
            <!-- eslint-enable svelte/no-navigation-without-resolve -->
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if data.chain}
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
        <span>Datos de las {formatSnapshotTime(data.chain.receivedAt)} (Nueva York)</span>
        <span>· {formatAge(elapsedMs)}</span>
        <span aria-live="polite"
          >{#if stale}· desactualizados, actualiza para ver precios vigentes{/if}</span
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
          {#each data.chain.strikes as row (row.strike)}
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
  .field > span,
  .label {
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

  .expirations {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .expirations a {
    display: inline-flex;
    align-items: center;
    min-height: var(--target);
    padding: 0 1rem;
    border: 1px solid var(--rule-strong);
    color: var(--text-muted);
    text-decoration: none;
  }
  .expirations a[aria-current="page"] {
    border-color: var(--text);
    color: var(--text);
    font-weight: 500;
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
    font-weight: 700;
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
