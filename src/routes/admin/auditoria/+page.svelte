<script lang="ts">
  import PageHeader from "#lib/ui/PageHeader.svelte";
  import { resolve } from "$app/paths";
  import Button from "#lib/ui/Button.svelte";
  import { formatWhen } from "#lib/ui/history.ts";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const base = resolve("/admin/auditoria");
  const nextHref = $derived(data.nextQuery ? `${base}?${data.nextQuery}` : null);
</script>

<svelte:head><title>Auditoría · Admin · Reel Capital</title></svelte:head>

<PageHeader crumb={[{ label: "Admin" }, { label: "Auditoría" }]} title="Auditoría">
  {#snippet lead()}
    Quién cambió qué: accesos, invitaciones, ajustes y recuperaciones.
  {/snippet}
</PageHeader>

<form class="filters" method="GET" action={base} aria-label="Filtros">
  <label>
    <span>Actor</span>
    <select name="actor">
      <option value="" selected={data.filters.actor === ""}>Todos</option>
      {#each data.page.actors as actor (actor.value)}
        <option value={actor.value} selected={data.filters.actor === actor.value}>
          {actor.label}
        </option>
      {/each}
    </select>
  </label>
  <label>
    <span>Acción</span>
    <select name="accion">
      <option value="" selected={data.filters.accion === ""}>Todas</option>
      {#each data.page.actions as action (action)}
        <option value={action} selected={data.filters.accion === action}>{action}</option>
      {/each}
    </select>
  </label>
  <label>
    <span>Objetivo</span>
    <select name="objetivo">
      <option value="" selected={data.filters.objetivo === ""}>Todos</option>
      {#each data.page.targets as target (target.value)}
        <option value={target.value} selected={data.filters.objetivo === target.value}>
          {target.label}
        </option>
      {/each}
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

{#if data.page.entries.length === 0}
  <p class="empty" role="status">
    {data.filtered
      ? "No hay registros con estos filtros."
      : data.first
        ? "Aún no hay registros."
        : "No hay más registros."}
  </p>
{:else}
  <table>
    <caption class="sr-only">Registro de auditoría, del más reciente al más antiguo</caption>
    <thead>
      <tr>
        <th scope="col">Fecha</th>
        <th scope="col">Actor</th>
        <th scope="col">Acción</th>
        <th scope="col">Objetivo</th>
        <th scope="col">Antes → después</th>
      </tr>
    </thead>
    <tbody>
      {#each data.page.entries as entry (entry.id)}
        <tr>
          <th scope="row" data-label="Fecha">{formatWhen(entry.at)}</th>
          <td data-label="Actor">{entry.actor}</td>
          <td data-label="Acción" class="strong">{entry.action}</td>
          <td data-label="Objetivo">{entry.target ?? "—"}</td>
          <td data-label="Antes → después" class="change">
            {#if entry.before === null && entry.after === null}
              —
            {:else}
              <!-- Plain text interpolation: the browser never parses a stored value as markup. -->
              <code>{entry.before ?? "—"}</code>
              <span aria-hidden="true">→</span>
              <span class="sr-only">cambia a</span>
              <code>{entry.after ?? "—"}</code>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if nextHref}
    <nav class="more" aria-label="Paginación">
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- built with resolve() above -->
      <a href={nextHref}>Ver registros anteriores →</a>
    </nav>
  {/if}
{/if}

<style>
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
    vertical-align: top;
  }
  thead th {
    color: var(--text-dim);
    font-size: 14px;
  }
  .strong {
    font-weight: 600;
  }
  code {
    font: inherit;
    color: var(--text-muted);
    overflow-wrap: anywhere;
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
    .change {
      display: block;
      text-align: left;
    }
    .change code {
      display: block;
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
