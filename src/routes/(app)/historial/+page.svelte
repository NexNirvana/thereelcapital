<script lang="ts">
  import { resolve } from "$app/paths";
  import Button from "#lib/ui/Button.svelte";
  import Notice from "#lib/ui/Notice.svelte";
  import {
    eventText,
    fillLine,
    fillPrice,
    formatWhen,
    kindLabel,
    levelLabel,
    stateLabel,
  } from "#lib/ui/history.ts";
  import { formatQuantity } from "#lib/ui/new-entry.ts";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const base = resolve("/(app)/historial");
  const nextHref = $derived(data.page?.nextQuery ? `${base}?${data.page.nextQuery}` : null);
</script>

<svelte:head><title>Historial · Reel Capital</title></svelte:head>

<div class="page">
  <header>
    <p class="crumb">Historial</p>
    <h1>Historial</h1>
    <p class="lead">Tus órdenes y eventos en simulación.</p>
  </header>

  <form class="filters" method="GET" action={base} aria-label="Filtros">
    <label>
      <span>Modo</span>
      <select name="modo">
        <option value="SIM" selected>SIM</option>
        <option value="REAL" disabled>REAL (no disponible)</option>
      </select>
    </label>
    <label>
      <span>Cuenta</span>
      <select name="cuenta">
        <option value="" selected={data.filters.cuenta === ""}>Todas</option>
        {#each data.page?.accounts ?? [] as account (account)}
          <option value={account} selected={data.filters.cuenta === account}>{account}</option>
        {/each}
      </select>
    </label>
    <label>
      <span>Símbolo</span>
      <input
        name="simbolo"
        value={data.filters.simbolo}
        maxlength="32"
        autocomplete="off"
        autocapitalize="characters"
        spellcheck="false"
        placeholder="MSFT"
      />
    </label>
    <label>
      <span>Desde</span>
      <input type="date" name="desde" value={data.filters.desde} />
    </label>
    <label>
      <span>Hasta</span>
      <input type="date" name="hasta" value={data.filters.hasta} />
    </label>
    <div class="buttons">
      <Button type="submit" variant="outline">Filtrar</Button>
      {#if data.filtered}<a class="clear" href={base}>Quitar filtros</a>{/if}
    </div>
  </form>

  {#if data.error !== null}
    <Notice title="No pudimos mostrar tu historial" role="alert">{data.error}</Notice>
  {:else if data.page !== null}
    {#if data.page.intents.length === 0}
      <p class="empty" role="status">
        {data.filtered
          ? "No hay órdenes con estos filtros."
          : data.page.first
            ? "Aún no tienes órdenes. Cuando operes, aparecerán aquí."
            : "No hay más órdenes."}
      </p>
    {:else}
      <table>
        <caption class="sr-only">Órdenes, de la más reciente a la más antigua</caption>
        <thead>
          <tr>
            <th scope="col">Fecha</th>
            <th scope="col">Símbolo</th>
            <th scope="col">Tipo</th>
            <th scope="col">Estado</th>
            <th scope="col">Cantidad</th>
            <th scope="col">Ejecutadas</th>
            <th scope="col">Precio de ejecución</th>
            <th scope="col">Cuenta</th>
          </tr>
        </thead>
        <tbody>
          {#each data.page.intents as order (order.id)}
            <tr>
              <th scope="row" data-label="Fecha">{formatWhen(order.created_at)}</th>
              <td data-label="Símbolo" class="symbol">{order.symbol}</td>
              <td data-label="Tipo">
                {kindLabel(order.kind)}{order.source === "external" ? " · externa" : ""}
              </td>
              <td data-label="Estado" class="state">
                {stateLabel(order.state)}{#if order.reject_reason}<span class="reason"
                    >{order.reject_reason}</span
                  >{/if}
              </td>
              <td data-label="Cantidad">
                {formatQuantity(order.qty, order.asset_type === "option" ? "option" : "equity")}
              </td>
              <td data-label="Ejecutadas">{fillLine(order.filled_qty, order.qty)}</td>
              <td data-label="Precio de ejecución">{fillPrice(order.avg_fill_price)}</td>
              <td data-label="Cuenta">{order.account_id}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if nextHref}
        <nav class="more" aria-label="Paginación">
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- built with resolve() above -->
          <a href={nextHref}>Ver órdenes anteriores →</a>
        </nav>
      {/if}
    {/if}

    {#if data.page.first}
      <section class="events" aria-labelledby="events-title">
        <h2 id="events-title">Eventos</h2>
        {#if data.page.events.length === 0}
          <p class="empty" role="status">
            No hay eventos{data.filtered ? " en estas fechas" : ""}.
          </p>
        {:else}
          <table>
            <caption class="sr-only">Eventos, del más reciente al más antiguo</caption>
            <thead>
              <tr>
                <th scope="col">Fecha</th>
                <th scope="col">Nivel</th>
                <th scope="col">Evento</th>
              </tr>
            </thead>
            <tbody>
              {#each data.page.events as event, index (index)}
                <tr>
                  <th scope="row" data-label="Fecha">{formatWhen(event.at)}</th>
                  <td data-label="Nivel">{levelLabel(event.level)}</td>
                  <td data-label="Evento">{eventText(event)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
          <p class="note">Los eventos se filtran solo por fecha.</p>
        {/if}
      </section>
    {/if}
  {/if}

  <p class="note">SIM · Simulación, sin dinero real</p>
</div>

<style>
  .page {
    max-width: 1000px;
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
  h2 {
    margin: 0 0 1rem;
    font-size: 18px;
    font-weight: 600;
    text-transform: uppercase;
  }
  .lead,
  .note {
    margin: 0.75rem 0 0;
    color: var(--text-dim);
    font-size: 14px;
  }
  .lead {
    font-size: inherit;
    color: var(--text-muted);
  }
  .filters {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 1rem;
    align-items: end;
    margin: 2rem 0;
  }
  label span {
    display: block;
    margin-bottom: 0.375rem;
    color: var(--text-dim);
    font-size: 14px;
  }
  select,
  input {
    width: 100%;
    min-height: var(--target);
    margin: 0;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--rule-strong);
    border-radius: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
  }
  option {
    background: var(--surface);
  }
  .buttons {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .clear,
  .more a {
    color: var(--text);
    text-underline-offset: 4px;
  }
  .more {
    margin: 1.5rem 0 0;
  }
  .events {
    margin-top: 3rem;
  }
  .empty {
    margin: 2rem 0;
    padding: 1.5rem 0;
    border-top: 1px solid var(--rule);
    border-bottom: 1px solid var(--rule);
    color: var(--text-muted);
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th,
  td {
    padding: 0.875rem 0.75rem 0.875rem 0;
    border-bottom: 1px solid var(--rule);
    text-align: left;
    font-weight: 400;
    overflow-wrap: anywhere;
  }
  thead th {
    color: var(--text-dim);
    font-size: 14px;
  }
  .symbol,
  .state {
    font-weight: 600;
  }
  .reason {
    display: block;
    font-weight: 400;
    font-size: 0.8125rem;
    color: var(--text-dim);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  @media (max-width: 900px) {
    thead {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
    tr {
      display: block;
      padding: 0.75rem 0;
      border-bottom: 1px solid var(--rule);
    }
    th,
    td {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      padding: 0.25rem 0;
      border: 0;
      text-align: right;
    }
    th[scope="row"] {
      color: var(--text-muted);
    }
    td::before,
    th[scope="row"]::before {
      content: attr(data-label);
      flex: none;
      color: var(--text-dim);
      text-align: left;
    }
  }
</style>
