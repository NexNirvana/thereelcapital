<script lang="ts">
  import type { ClientOverview } from "#lib/domain/overview.ts";
  import { openQty, protectionLabel } from "./admin-operations.ts";
  import { formatWhen, kindLabel, stateLabel } from "./history.ts";
  import Notice from "./Notice.svelte";

  // Read-only: what a client holds and has in flight, as its engine reports it. `label` names the
  // client for the tables' accessible names.
  let { overview, label }: { overview: ClientOverview; label: string } = $props();
  const unknown = $derived(overview.orders.filter((order) => order.state === "UNKNOWN"));
</script>

<p class="counts">
  <span>Posiciones {overview.positionsOpen}/{overview.maxPositions}</span>
  <span>Entradas hoy {overview.entriesToday}/{overview.maxEntries}</span>
</p>

{#if unknown.length > 0}
  <Notice title="Órdenes sin verificar" role="alert">
    {unknown.length === 1
      ? "Una orden no tiene resultado confirmado todavía. El motor la verifica con TradeStation."
      : `${unknown.length} órdenes no tienen resultado confirmado todavía. El motor las verifica con TradeStation.`}
  </Notice>
{/if}

<h3>Posiciones abiertas</h3>
{#if overview.positions.length === 0}
  <p class="empty">Sin posiciones abiertas.</p>
{:else}
  <!-- A scrollable table must be reachable by keyboard. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="scroll" role="region" aria-label={`Posiciones abiertas de ${label}`} tabindex="0">
    <table>
      <thead>
        <tr>
          <th scope="col">Símbolo</th><th scope="col">Cuenta</th>
          <th scope="col" class="num">Abierta</th><th scope="col" class="num">Vendida</th>
          <th scope="col">Protección</th>
        </tr>
      </thead>
      <tbody>
        {#each overview.positions as position (position.id)}
          <tr>
            <th scope="row">{position.symbol}</th>
            <td>{position.accountId}</td>
            <td class="num">{openQty(position)}</td>
            <td class="num">{position.soldQty}</td>
            <td>{protectionLabel(position.protectionState)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<h3>Órdenes pendientes</h3>
{#if overview.orders.length === 0}
  <p class="empty">Sin órdenes pendientes.</p>
{:else}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="scroll" role="region" aria-label={`Órdenes pendientes de ${label}`} tabindex="0">
    <table>
      <thead>
        <tr>
          <th scope="col">Símbolo</th><th scope="col">Tipo</th><th scope="col">Estado</th>
          <th scope="col" class="num">Cantidad</th><th scope="col">Creada</th>
        </tr>
      </thead>
      <tbody>
        {#each overview.orders as order (order.id)}
          <tr>
            <th scope="row">{order.symbol}</th>
            <td>{kindLabel(order.kind)}</td>
            <td class:flag={order.state === "UNKNOWN"}>{stateLabel(order.state)}</td>
            <td class="num">{order.filledQty}/{order.qty}</td>
            <td>{formatWhen(order.createdAt)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .counts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1.5rem;
    margin: 0 0 0.75rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  h3 {
    margin: 1.5rem 0 0.5rem;
    font-size: 1rem;
  }
  .empty {
    margin: 0;
    color: var(--text-muted);
  }
  .scroll {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }
  th,
  td {
    padding: 0.75rem 1rem 0.75rem 0;
    border-bottom: 1px solid var(--rule);
    text-align: left;
    white-space: nowrap;
  }
  thead th {
    color: var(--text-muted);
    font-weight: 400;
  }
  tbody th {
    font-weight: 500;
  }
  .num {
    text-align: right;
  }
  /* On a phone the columns tighten; headers and symbols never break mid-word. */
  @media (max-width: 600px) {
    th,
    td {
      padding-right: 0.5rem;
      font-size: 0.8125rem;
    }
    td:last-child {
      white-space: normal;
    }
  }
  /* Text carries the meaning; the weight and underline only draw the eye (never colour alone). */
  .flag {
    font-weight: 600;
    text-decoration: underline;
  }
</style>
