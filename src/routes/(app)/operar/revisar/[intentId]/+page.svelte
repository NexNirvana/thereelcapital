<script lang="ts">
  import { invalidate } from "$app/navigation";
  import { resolve } from "$app/paths";
  import Button from "#lib/ui/Button.svelte";
  import DefinitionRow from "#lib/ui/DefinitionRow.svelte";
  import Notice from "#lib/ui/Notice.svelte";
  import { stateCopy } from "#lib/ui/order-state.ts";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  // Ask the engine again every few seconds until the order ends or the client leaves. The bound
  // keeps a forgotten tab from polling for ever; the engine keeps reconciling either way.
  const POLL_MS = 3_000;
  const MAX_POLLS = 200;
  let polls = $state(0);

  const copy = $derived(data.intent ? stateCopy(data.intent) : null);
  const watching = $derived(
    polls < MAX_POLLS && (data.intent === null ? true : !(copy?.terminal ?? false)),
  );

  $effect(() => {
    if (!watching) return;
    const timer = setInterval(() => {
      polls += 1;
      void invalidate("app:order");
    }, POLL_MS);
    return () => clearInterval(timer);
  });
</script>

<svelte:head><title>Estado de la orden · Reel Capital</title></svelte:head>

<div class="page">
  <header>
    <p class="crumb">Operar / Estado de la orden</p>
    <h1>Estado de la orden</h1>
  </header>

  <!-- The live region lives outside the {#if}, so screen readers hear every state change. -->
  <div class="state" role="status" aria-live="polite" aria-atomic="true">
    {#if data.intent && copy}
      <p class="label" data-state={data.intent.state}>{copy.label}</p>
      <p class="detail">{copy.detail}</p>
    {:else}
      <p class="detail">{data.message}</p>
    {/if}
  </div>

  {#if data.intent}
    <dl>
      <DefinitionRow label="Instrumento" value={data.intent.symbol} />
      <DefinitionRow label="Acción" value="Comprar para abrir" />
      <DefinitionRow label="Cantidad" value={String(data.intent.qty)} />
      <DefinitionRow label="Ejecutado" value={`${data.intent.filledQty} de ${data.intent.qty}`} />
      <DefinitionRow label="Tipo de orden" value="Market" />
    </dl>
  {/if}

  {#if !watching && copy && !copy.terminal}
    <Notice title="Seguimos verificando">
      Dejamos de actualizar esta pantalla. Tu orden sigue en revisión y se concilia sola.
    </Notice>
  {/if}

  <p><Button variant="link" href={resolve("/(app)/operar")}>Volver a Nueva entrada</Button></p>
  <p class="mode">SIM · Simulación, sin dinero real</p>
</div>

<style>
  .page {
    display: grid;
    gap: 1.5rem;
    max-width: 560px;
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
  .state {
    padding: 1.25rem 0;
    border-top: 1px solid var(--rule);
    border-bottom: 1px solid var(--rule);
  }
  .label {
    margin: 0;
    font-size: 28px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .detail {
    margin: 0.5rem 0 0;
    color: var(--text-muted);
  }
  dl {
    margin: 0;
  }
  p {
    margin: 0;
  }
  .mode {
    color: var(--text-dim);
    font-size: 14px;
  }
</style>
