<script lang="ts">
  import { untrack } from "svelte";
  import { goto, invalidate } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { navigating, page } from "$app/state";
  import {
    LIVE_CHAIN_REFRESH_FACTOR,
    LIVE_QUOTE_MAX_BACKOFF_MS,
    LIVE_QUOTE_MAX_POLLS,
    LIVE_QUOTE_POLL_MS,
  } from "#lib/domain/config.ts";
  import type { LiveMessage } from "#lib/domain/live-protocol.ts";
  import Button from "./Button.svelte";
  import {
    DEFAULT_STRIKE_COUNT,
    countOptions,
    exactStrike,
    isInTheMoney,
    matchStrikes,
    priceLineBefore,
    strikeCountParam,
    strikeNearest,
    strikeWindow,
    windowSummary,
    type StrikeCount,
  } from "./chain-window.ts";
  import type { ChainView } from "./chain-view.ts";
  import ComboField, { type ComboOption } from "./ComboField.svelte";
  import ExpirationField from "./ExpirationField.svelte";
  import {
    chainFromMessages,
    chainSymbols,
    indexChain,
    readLiveChain,
    type LiveChain,
  } from "./live-chain.ts";
  import { startLiveFeed } from "./live-feed.ts";
  import { createFrameBatch } from "./frame-batch.ts";
  import Notice from "./Notice.svelte";
  import {
    formatAge,
    formatQuote,
    formatSnapshotTime,
    formatStrike,
    isStale,
  } from "./option-chain.ts";

  // The chain inside the Opciones tab: Subyacente, Vencimiento, Strike and Mostrar above a table of
  // Call and Put bid/ask. Everything but the symbol and the date is chosen in the browser from the
  // strikes the server already sent; picking a side is a link back to /operar with the exact symbol
  // TradeStation listed (docs/screens-and-flows.md, /operar).
  let {
    view,
    accountId,
    accounts,
    initialStrike,
    initialCount,
    chosenSymbol,
  }: {
    view: ChainView;
    accountId: string | null;
    /** Every account the client may trade; the select shows only when there is a choice. */
    accounts: ReadonlyArray<string>;
    /** The strike the URL asked to center on, if it is listed. */
    initialStrike: number | null;
    initialCount: StrikeCount;
    /** The option symbol picked earlier, so its price stays marked. */
    chosenSymbol: string;
  } = $props();

  const entryPath = resolve("/(app)/operar");
  const query = (extra: Record<string, string>) =>
    new URLSearchParams({
      tipo: "opciones",
      ...(accountId === null ? {} : { cuenta: accountId }),
      ...extra,
    });
  let center = $derived(initialStrike);
  let count = $derived<StrikeCount>(initialCount);
  const countQuery = $derived<Record<string, string>>(
    count === DEFAULT_STRIKE_COUNT ? {} : { strikes: strikeCountParam(count) },
  );

  // ---- Subyacente: the search starts by itself ~500 ms after the last key, or at once on Enter or
  // blur. Without JavaScript the same field is a plain GET form with a Buscar button.
  const SEARCH_DEBOUNCE_MS = 500;
  let typedUnderlying = $derived(view.underlying);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  function search() {
    clearTimeout(searchTimer);
    const symbol = typedUnderlying.trim();
    if (symbol === "" || symbol === view.underlying) return;
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- entryPath is built with resolve()
    void goto(`${entryPath}?${query({ subyacente: symbol })}`, { reset: false });
  }
  function onsearch(event: SubmitEvent) {
    event.preventDefault();
    search();
  }
  $effect(() => () => clearTimeout(searchTimer));
  const searching = $derived(navigating.to !== null && typedUnderlying.trim() !== view.underlying);

  // ---- The chain: the server's load, replaced by the live poll while the screen is open (D46). The
  // prices are display only: picking a contract carries just its symbol.
  // Raw: each tick replaces the chain whole, and nothing reads it through a deep proxy.
  let live = $state.raw<{ loaded: string; chain: LiveChain } | null>(null);
  // The last full read. It names every contract on screen and changes only when a full read
  // arrives, so what hangs on it (the strikes and their positions) is not rebuilt on every tick.
  let fullRead = $state.raw<{ loaded: string; chain: LiveChain } | null>(null);
  const loaded = $derived(
    view.chain === null ? null : `${view.underlying} ${view.expiration} ${view.chain.receivedAt}`,
  );
  const shown = $derived(live !== null && live.loaded === loaded ? live.chain : view.chain);
  const structure = $derived(
    fullRead !== null && fullRead.loaded === loaded ? fullRead.chain : view.chain,
  );
  const quotesHref = $derived(
    view.chain === null
      ? null
      : `${resolve("/(app)/operar/cadena/cotizaciones")}?${new URLSearchParams({
          subyacente: view.underlying,
          vencimiento: view.expiration,
          ...(accountId === null ? {} : { cuenta: accountId }),
        })}`,
  );
  // The quotes of a chain cost one request per 100 contracts, so a long chain polls proportionally
  // slower and one open screen stays inside the quotes budget.
  const pollMs = $derived(
    LIVE_QUOTE_POLL_MS * Math.max(1, Math.ceil(((view.chain?.strikes.length ?? 0) * 2) / 100)),
  );
  $effect(() => {
    const href = quotesHref;
    const source = loaded;
    if (href === null || source === null) return;
    const base = view.chain;
    if (base === null) return;
    // The last full read: it names the contracts to watch and to recognize in the pushes.
    // The effect can restart on the same chain (another account): start from the full read already
    // on screen, not the page load, so ticks for contracts that read brought in still find their row.
    let reference: LiveChain = untrack(() =>
      fullRead !== null && fullRead.loaded === source ? fullRead.chain : base,
    );
    let index = indexChain(reference);
    // The ticks of one frame apply together: one update of the table, whatever the burst.
    const ticks = createFrameBatch<LiveMessage>((messages) => {
      const current = live !== null && live.loaded === source ? live.chain : base;
      const next = chainFromMessages(current, messages, index, view.underlying);
      if (next !== null) live = { loaded: source, chain: next };
    });
    // The socket pushes every tick of the contracts on screen (D47); the poll of D46 runs only
    // while it is not delivering.
    const feed = startLiveFeed({
      watch: () => ({
        type: "watch",
        symbols: [view.underlying, ...chainSymbols(reference)],
      }),
      onMessage: (message) => ticks.add(message),
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
            // The full read is newer than any tick still waiting for its frame.
            ticks.clear();
            live = { loaded: source, chain: answer };
            fullRead = { loaded: source, chain: answer };
            // A contract that has a market now joins the stream.
            const changed = chainSymbols(answer).join() !== chainSymbols(reference).join();
            reference = answer;
            index = indexChain(answer);
            if (changed) feed.rewatch();
          }
          return answer !== null;
        },
      },
    });
    return () => {
      feed();
      ticks.stop();
    };
  });

  // The age counts from the moment this snapshot reached the page; a local clock for the label only.
  let elapsedMs = $state(0);
  let snapshotAt = Date.now();
  $effect(() => {
    if (shown === null) return;
    void shown.receivedAt;
    snapshotAt = Date.now();
    elapsedMs = 0;
  });
  // One timer for as long as there is a chain: a tick moves `snapshotAt`, it does not restart the timer.
  const hasChain = $derived(shown !== null);
  $effect(() => {
    if (!hasChain) return;
    const timer = setInterval(() => (elapsedMs = Date.now() - snapshotAt), 1000);
    return () => clearInterval(timer);
  });
  const stale = $derived(isStale(elapsedMs));
  let refreshing = $state(false);
  async function refresh() {
    refreshing = true;
    try {
      await invalidate("app:chain");
    } finally {
      refreshing = false;
    }
  }

  // ---- What is on screen: `count` strikes around the typed strike, or around the price.
  const price = $derived(shown?.underlyingPrice ?? null);
  const strikes = $derived(structure?.strikes.map((row) => row.strike) ?? []);
  // A live chain keeps the full read's rows in the same order, so a strike's position finds its row.
  const positionOf = $derived(new Map(strikes.map((strike, position) => [strike, position])));
  // Without a typed strike the window follows the strike nearest the price, so it moves only when
  // the price crosses into a different strike gap and not on every tick.
  const nearest = $derived(strikeNearest(strikes, price));
  const focus = $derived(center ?? nearest);
  const onScreen = $derived(strikeWindow(strikes, count, focus));
  const rows = $derived(
    onScreen.flatMap((strike) => {
      const position = positionOf.get(strike);
      return (position === undefined ? undefined : shown?.strikes[position]) ?? [];
    }),
  );
  const lineBefore = $derived(priceLineBefore(onScreen, price));

  // Keep the choice in the address so a reload or a shared link shows the same table.
  function syncAddress() {
    const url = new URL(page.url.href);
    if (center === null) url.searchParams.delete("strike");
    else url.searchParams.set("strike", formatStrike(center));
    if (count === DEFAULT_STRIKE_COUNT) url.searchParams.delete("strikes");
    else url.searchParams.set("strikes", strikeCountParam(count));
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- the address of the page already on screen
    void goto(`${url.pathname}${url.search}`, { replace: true, shallow: true, state: page.state });
  }

  // ---- Strike: type a strike to center the table on it.
  let strikeText = $derived(initialStrike === null ? "" : formatStrike(initialStrike));
  const strikeOptions = $derived.by((): ReadonlyArray<ComboOption<number | null>> => {
    if (strikeText.trim() === "") {
      return center === null
        ? []
        : [
            {
              key: null,
              label: "Al precio",
              aside: price === null ? undefined : formatQuote(price),
            },
          ];
    }
    const found = matchStrikes(strikes, strikeText, price);
    return found.strikes.map((strike) => ({
      key: strike,
      label: formatStrike(strike),
      aside:
        found.kind === "nearest"
          ? "más cercano"
          : strike === center
            ? "elegido"
            : strike === nearest
              ? "al precio"
              : undefined,
    }));
  });
  function centerOn(strike: number | null) {
    center = strike;
    strikeText = strike === null ? "" : formatStrike(strike);
    syncAddress();
  }
  function commitStrike() {
    if (strikeText.trim() === "") {
      if (center !== null) centerOn(null);
      return;
    }
    const exact = exactStrike(strikes, strikeText);
    if (exact !== null) centerOn(exact);
    else strikeText = center === null ? "" : formatStrike(center);
  }

  // ---- Mostrar: 10, 25, 50 or all the strikes.
  const countChoices = $derived(countOptions(strikes, focus));
  const countText = $derived(countChoices.find((choice) => choice.count === count)?.label ?? "");
  const countComboOptions = $derived(
    countChoices.map((choice) => ({ key: choice.count, label: choice.label, aside: choice.range })),
  );

  const expirationFields = $derived({
    tipo: "opciones",
    subyacente: view.underlying,
    ...(accountId === null ? {} : { cuenta: accountId }),
    ...countQuery,
  });
  const expirationHref = (isoDate: string) =>
    `${entryPath}?${query({ subyacente: view.underlying, vencimiento: isoDate, ...countQuery })}`;
  // The symbol is the exact one TradeStation listed; /operar asks the engine what it stands for.
  const contractHref = (symbol: string) =>
    `${entryPath}?${query({
      subyacente: view.underlying,
      vencimiento: view.expiration,
      ...(center === null ? {} : { strike: formatStrike(center) }),
      ...countQuery,
      simbolo: symbol,
    })}`;

  // Another account shows the same chain: the symbol, date, strike window and picked contract stay.
  function switchAccount(account: string) {
    const params = query({
      subyacente: view.underlying,
      vencimiento: view.expiration,
      ...(center === null ? {} : { strike: formatStrike(center) }),
      ...countQuery,
      ...(chosenSymbol === "" ? {} : { simbolo: chosenSymbol }),
    });
    params.set("cuenta", account);
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- entryPath is built with resolve()
    void goto(`${entryPath}?${params}`);
  }

  function pickLabel(name: string, strike: number, side: { bid: number; ask: number }): string {
    return `Elegir ${name} ${formatStrike(strike)}, bid ${formatQuote(side.bid)}, ask ${formatQuote(side.ask)}`;
  }
</script>

<form method="GET" action={entryPath} class="search" onsubmit={onsearch}>
  <input type="hidden" name="tipo" value="opciones" />
  {#if accounts.length > 1}
    <div class="field">
      <label for="cuenta">Cuenta</label>
      <select
        id="cuenta"
        name="cuenta"
        onchange={(event) => switchAccount(event.currentTarget.value)}
      >
        {#each accounts as account (account)}
          <option value={account} selected={account === accountId}>{account}</option>
        {/each}
      </select>
    </div>
  {:else if accountId !== null}
    <input type="hidden" name="cuenta" value={accountId} />
  {/if}
  <div class="field">
    <label for="subyacente">Subyacente</label>
    <input
      id="subyacente"
      class="field-input"
      name="subyacente"
      value={typedUnderlying}
      oninput={(event) => {
        typedUnderlying = event.currentTarget.value.toUpperCase();
        clearTimeout(searchTimer);
        searchTimer = setTimeout(search, SEARCH_DEBOUNCE_MS);
      }}
      onblur={search}
      onfocus={(event) => event.currentTarget.select()}
      maxlength="16"
      autocomplete="off"
      autocapitalize="characters"
      spellcheck="false"
      placeholder="MSFT"
    />
    <p class="msg" role="status">{searching ? `Buscando ${typedUnderlying.trim()}…` : ""}</p>
  </div>
  <noscript><Button type="submit" variant="outline">Buscar</Button></noscript>
</form>

{#if view.problem}
  <Notice title="No pudimos mostrar la cadena" role="alert">{view.problem}</Notice>
{/if}

{#if view.expirations}
  <div class="expiration">
    <ExpirationField
      action={entryPath}
      fields={expirationFields}
      expirations={view.expirations}
      text={view.expirationText}
      nowMs={view.nowMs}
      choice={view.choice}
      hrefFor={expirationHref}
    />
    {#if view.notice}<p class="fallback" role="status">{view.notice}</p>{/if}
  </div>
{/if}

{#if view.chain && shown}
  <section class="chain" aria-label="Contratos">
    <div class="tools">
      <ComboField
        id="strike"
        label="Strike"
        bind:text={strikeText}
        options={strikeOptions}
        inputmode="decimal"
        placeholder={nearest === null ? "" : `Ej. ${formatStrike(nearest)}`}
        onpick={centerOn}
        oncommit={commitStrike}
        oncancel={() => (strikeText = center === null ? "" : formatStrike(center))}
      />
      <ComboField
        id="mostrar"
        label="Mostrar"
        readonly
        text={countText}
        options={countComboOptions}
        onpick={(choice) => {
          count = choice;
          syncAddress();
        }}
      />
    </div>

    <div class="freshness-row">
      <p class="freshness" class:stale>
        <span>Datos de las {formatSnapshotTime(shown.receivedAt)} (Nueva York)</span>
        <span>· {formatAge(elapsedMs)}</span>
        <span aria-live="polite"
          >{#if stale}· desactualizados, actualiza para ver precios vigentes{:else}· se actualizan
            solos{/if}</span
        >
      </p>
      <Button type="button" variant="outline" disabled={refreshing} onclick={refresh}>
        {refreshing ? "Actualizando…" : "Actualizar"}
      </Button>
    </div>

    <table class:stale aria-live="polite" aria-relevant="additions removals">
      <caption class="sr">
        Strikes de {view.underlying} con vencimiento {view.expiration}: bid y ask en dólares de cada
        Call y Put.
      </caption>
      <colgroup><col class="side" /><col class="mid" /><col class="side" /></colgroup>
      <thead>
        <tr>
          <th scope="col" class="call">Call <small>bid / ask</small></th>
          <th scope="col" class="strike">Strike (US$)</th>
          <th scope="col" class="put">Put <small>bid / ask</small></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row, index (row.strike)}
          {#if index === lineBefore && price !== null}
            <tr class="spot">
              <td colspan="3">
                <div><b>{view.underlying} {formatQuote(price)}</b></div>
              </td>
            </tr>
          {/if}
          <tr class:hit={row.strike === center}>
            {#each [{ side: row.call, name: "Call", right: "call" as const }, { side: row.put, name: "Put", right: "put" as const }] as { side, name, right } (name)}
              {#if right === "put"}<th scope="row" class="strike">{formatStrike(row.strike)}</th
                >{/if}
              <td class={[right, { itm: isInTheMoney(right, row.strike, price) }]}>
                {#if side}
                  <!-- eslint-disable svelte/no-navigation-without-resolve -- built with resolve() above -->
                  <a
                    class="pick"
                    class:chosen={side.symbol === chosenSymbol}
                    href={contractHref(side.symbol)}
                    aria-current={side.symbol === chosenSymbol ? "true" : undefined}
                    aria-label={pickLabel(name, row.strike, side)}
                    data-sveltekit-reset="false"
                    >{formatQuote(side.bid)} / {formatQuote(side.ask)}</a
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
    <p class="count" aria-live="polite">{windowSummary(strikes.length, onScreen, count, center)}</p>
    <p class="note">
      «Sin dato»: el contrato existe, pero TradeStation no mostró bid y ask. No se puede elegir.
    </p>
    {#if chosenSymbol !== ""}
      <p class="to-summary"><a href="#resumen">Ir al resumen de la orden ↓</a></p>
    {/if}
  </section>
{/if}

<style>
  .field {
    margin-bottom: 1rem;
  }
  label {
    display: block;
    margin: 0 0 0.375rem;
    color: var(--text-dim);
    font-size: 14px;
  }
  select {
    box-sizing: border-box;
    width: 100%;
    min-height: var(--target);
    margin: 0;
    padding: 0.75rem 1rem;
    border: 1px solid var(--rule-strong);
    border-radius: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
  }
  .msg {
    margin: 0.375rem 0 0;
    min-height: 1.5em;
    color: var(--text-dim);
    font-size: 14px;
  }
  .expiration,
  .chain {
    margin-top: 0.5rem;
  }
  .fallback {
    margin: 0.75rem 0 0;
    color: var(--text-muted);
  }
  .tools {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    margin: 1.5rem 0 0.5rem;
  }
  .freshness-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem 1rem;
    margin: 0.75rem 0 1rem;
  }
  .freshness {
    margin: 0;
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
    table-layout: fixed;
    border-collapse: collapse;
    border-top: 1px solid var(--rule);
    font-variant-numeric: tabular-nums;
  }
  col.side {
    width: 40%;
  }
  col.mid {
    width: 20%;
  }
  table.stale td {
    opacity: 0.6;
  }
  th,
  td {
    padding: 0;
    border-bottom: 1px solid var(--rule);
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
  .call {
    text-align: right;
  }
  .put {
    text-align: left;
  }
  .strike {
    text-align: center;
    font-weight: 600;
  }
  td.itm {
    background: var(--surface);
  }
  tr.hit td {
    box-shadow:
      inset 0 2px var(--text),
      inset 0 -2px var(--text);
  }
  tr.hit th.strike {
    background: var(--text);
    color: var(--bg);
  }
  .pick,
  .missing {
    display: flex;
    align-items: center;
    min-height: var(--target);
    padding: 0 0.5rem;
    white-space: nowrap;
  }
  td.call .pick,
  td.call .missing {
    justify-content: flex-end;
  }
  .pick {
    color: var(--text);
    text-decoration: underline;
    text-underline-offset: 4px;
  }
  .pick.chosen {
    font-weight: 600;
    outline: 1px solid var(--text);
    outline-offset: -3px;
  }
  .missing {
    color: var(--text-dim);
  }
  tr.spot td {
    padding: 0.375rem 0;
    border: 0;
  }
  tr.spot div {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    font-size: 12px;
  }
  tr.spot div::before,
  tr.spot div::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--text);
  }
  tr.spot b {
    padding: 1px 8px;
    background: var(--text);
    color: var(--bg);
    font-weight: 500;
  }
  .count {
    margin: 0.75rem 0 0;
    color: var(--text-muted);
    font-size: 14px;
  }
  .note {
    margin: 0.5rem 0 0;
    color: var(--text-dim);
    font-size: 14px;
  }
  .to-summary {
    display: none;
    margin: 1rem 0 0;
  }
  .to-summary a {
    color: var(--text);
    text-underline-offset: 4px;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  @media (max-width: 900px) {
    .to-summary {
      display: block;
    }
  }
  @media (max-width: 480px) {
    .tools {
      grid-template-columns: 1fr;
    }
    .pick,
    .missing {
      padding: 0 0.25rem;
      font-size: 14px;
    }
  }
</style>
