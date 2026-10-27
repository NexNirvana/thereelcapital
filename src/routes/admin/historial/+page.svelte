<script lang="ts">
  import PageHeader from "#lib/ui/PageHeader.svelte";
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
  import { ORDER_STATES } from "#lib/domain/order-states.ts";
  import { formatQuantity } from "#lib/ui/new-entry.ts";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const base = resolve("/admin/historial");
  const nextHref = $derived(data.nextQuery ? `${base}?${data.nextQuery}` : null);
  const showOrders = $derived(data.filters.tipo === "" || data.filters.tipo === "ordenes");
  const showEvents = $derived(data.filters.tipo !== "ordenes" && data.first);
</script>

<svelte:head><title>Historial · Admin · Reel Capital</title></svelte:head>

<PageHeader crumb={[{ label: "Admin" }, { label: "Historial" }]} title="Historial">
  {#snippet lead()}
    Órdenes, ejecuciones, eventos y errores de todos los clientes, en simulación.
  {/snippet}
</PageHeader>

<form class="filters" method="GET" action={base} aria-label="Filtros">
  <label>
    <span>Cliente</span>
    <select name="cliente">
      <option value="" selected={data.filters.cliente === ""}>Todos</option>
      {#each data.clients as client (client.id)}
        <option value={client.id} selected={data.filters.cliente === client.id}>
          {client.email}
        </option>
      {/each}
    </select>
  </label>
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
      {#each data.page.accounts as account (account)}
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
    <span>Estado</span>
    <select name="estado">
      <option value="" selected={data.filters.estado === ""}>Todos</option>
      {#each ORDER_STATES as state (state)}
        <option value={state} selected={data.filters.estado === state}>{stateLabel(state)}</option>
      {/each}
    </select>
  </label>
  <label>
    <span>Tipo</span>
    <select name="tipo">
      <option value="" selected={data.filters.tipo === ""}>Todo</option>
      <option value="ordenes" selected={data.filters.tipo === "ordenes"}>Órdenes</option>
      <option value="eventos" selected={data.filters.tipo === "eventos"}>Eventos</option>
      <option value="errores" selected={data.filters.tipo === "errores"}>Errores</option>
    </select>
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

{#if data.page.failures.length > 0}
  <Notice title="No pudimos leer el historial de algunos clientes" role="alert">
    <ul class="failures">
      {#each data.page.failures as failure (failure.clientEmail)}
        <li>{failure.clientEmail}: {failure.message}</li>
      {/each}
    </ul>
  </Notice>
{/if}

{#if showOrders}
  {#if data.page.intents.length === 0}
    <p class="empty" role="status">
      {data.filtered
        ? "No hay órdenes con estos filtros."
        : data.first
          ? "Aún no hay órdenes."
          : "No hay más órdenes."}
    </p>
  {:else}
    <table>
      <caption class="sr-only"
        >Órdenes de todos los clientes, de la más reciente a la más antigua</caption
      >
      <thead>
        <tr>
          <th scope="col">Fecha</th>
          <th scope="col">Cliente</th>
          <th scope="col">Símbolo</th>
          <th scope="col">Tipo</th>
          <th scope="col">Estado</th>
          <th scope="col">Cantidad</th>
          <th scope="col">Ejecutadas</th>
          <th scope="col">Precio de ejecución</th>
        </tr>
      </thead>
      <tbody>
        {#each data.page.intents as order (`${order.clientEmail}:${order.id}`)}
          <tr>
            <th scope="row" data-label="Fecha">{formatWhen(order.created_at)}</th>
            <td data-label="Cliente" class="client">
              {order.clientEmail}<span class="account">{order.account_id}</span>
            </td>
            <td data-label="Símbolo" class="strong">{order.symbol}</td>
            <td data-label="Tipo">
              {kindLabel(order.kind)}{order.source === "external" ? " · externa" : ""}
            </td>
            <td data-label="Estado" class="strong">
              {stateLabel(order.state)}{#if order.reject_reason}<span class="account"
                  >{order.reject_reason}</span
                >{/if}
            </td>
            <td data-label="Cantidad">
              {formatQuantity(order.qty, order.asset_type === "option" ? "option" : "equity")}
            </td>
            <td data-label="Ejecutadas">{fillLine(order.filled_qty, order.qty)}</td>
            <td data-label="Precio de ejecución">{fillPrice(order.avg_fill_price)}</td>
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
{/if}

{#if showEvents}
  <section class="events" aria-labelledby="events-title">
    <h2 id="events-title">{data.filters.tipo === "errores" ? "Errores" : "Eventos"}</h2>
    {#if data.page.events.length === 0}
      <p class="empty" role="status">
        {data.filters.tipo === "errores" ? "No hay errores" : "No hay eventos"}{data.filtered
          ? " con estos filtros"
          : ""}.
      </p>
    {:else}
      <table>
        <caption class="sr-only"
          >Eventos de todos los clientes, del más reciente al más antiguo</caption
        >
        <thead>
          <tr>
            <th scope="col">Fecha</th>
            <th scope="col">Cliente</th>
            <th scope="col">Nivel</th>
            <th scope="col">Evento</th>
          </tr>
        </thead>
        <tbody>
          {#each data.page.events as event, index (index)}
            <tr>
              <th scope="row" data-label="Fecha">{formatWhen(event.at)}</th>
              <td data-label="Cliente">{event.clientEmail}</td>
              <td data-label="Nivel">{levelLabel(event.level)}</td>
              <td data-label="Evento">
                {eventText(event)}<span class="account">{event.type}</span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      <p class="note">Los eventos se filtran por cliente, fecha y tipo.</p>
    {/if}
  </section>
{/if}

<p class="note">SIM · Simulación, sin dinero real</p>

<style>
  h2 {
    margin: 0 0 1rem;
    font-size: 18px;
    font-weight: 600;
    text-transform: uppercase;
  }
  .note {
    margin: 0.75rem 0 0;
    color: var(--text-dim);
    font-size: 14px;
  }
  .filters {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
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
    white-space: nowrap;
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
  .failures {
    margin: 0;
    padding-left: 1.25rem;
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
    overflow-wrap: break-word;
  }
  .client {
    overflow-wrap: anywhere;
  }
  .account {
    display: block;
    color: var(--text-dim);
    font-size: 14px;
  }
  thead th {
    color: var(--text-dim);
    font-size: 14px;
  }
  .strong {
    font-weight: 600;
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
    .account {
      flex: none;
      margin-left: 0.5rem;
      white-space: nowrap;
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
