<script lang="ts">
  import { resolve } from "$app/paths";
  import { connectionKey } from "#lib/domain/overview.ts";
  import { connectionLabel } from "#lib/ui/admin-operations.ts";
  import ClientOperations from "#lib/ui/ClientOperations.svelte";
  import Notice from "#lib/ui/Notice.svelte";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
</script>

<svelte:head><title>Operativa · REEL CAPITAL</title></svelte:head>

<h1>Operativa</h1>
<p class="hint">
  Posiciones, órdenes pendientes y protección de cada cliente, tal como las informa su motor. Solo
  lectura: desde aquí no se envía ni se cancela ninguna orden.
</p>

{#if data.rows.length === 0}
  <Notice title="Aún no hay clientes">Crea el primero desde Clientes.</Notice>
{/if}

{#each data.rows as row (row.id)}
  <section aria-labelledby={`client-${row.id}`}>
    <h2 id={`client-${row.id}`}>
      <a href={resolve("/admin/clientes/[id]", { id: row.id })}>{row.email}</a>
    </h2>
    <p class="status">Conexión: {connectionLabel(connectionKey(row.overview))}</p>
    {#if row.overview.status === "unavailable"}
      <Notice title="No disponible" role="alert">
        No pudimos leer el estado de este cliente. Vuelve a intentarlo en unos segundos.
      </Notice>
    {:else}
      <ClientOperations overview={row.overview.value} label={row.email} />
    {/if}
  </section>
{/each}

<style>
  h1 {
    font-size: clamp(28px, 4vw, 40px);
  }
  h2 {
    margin: 0 0 0.25rem;
    font-size: 1.125rem;
    text-transform: none;
    overflow-wrap: anywhere;
  }
  h2 a {
    display: inline-flex;
    align-items: center;
    min-height: var(--target);
    color: var(--text);
  }
  section {
    margin-top: 2.5rem;
    padding-top: 1rem;
    border-top: 1px solid var(--rule);
  }
  .hint {
    max-width: 40rem;
    color: var(--text-muted);
  }
  .status {
    margin: 0 0 0.75rem;
    color: var(--text-muted);
  }
</style>
