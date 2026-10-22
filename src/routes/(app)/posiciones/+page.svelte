<script lang="ts">
  import { enhance } from "$app/forms";
  import { invalidate } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { TRAILING_PCT_OPTIONS } from "#lib/domain/config.ts";
  import Button from "#lib/ui/Button.svelte";
  import Notice from "#lib/ui/Notice.svelte";
  import ProgressBar from "#lib/ui/ProgressBar.svelte";
  import {
    allOutHint,
    countsLine,
    formatUnits,
    headline,
    instrumentLine,
    pendingKindLabel,
    pendingStateLabel,
    remainingLine,
    sellableQty,
    roundedToZero,
    soldPercent,
    roundedToZeroLine,
    stepBasisHint,
    stepViews,
    stopStatus,
    switcherLabel,
  } from "#lib/ui/positions.ts";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();

  // Ask the engine again every few seconds while the screen is visible. The bound keeps a forgotten
  // tab from polling for ever; any action starts the count again. The engine keeps reconciling
  // either way.
  const POLL_MS = 3_000;
  const MAX_POLLS = 400;
  let polls = $state(0);

  $effect(() => {
    if (polls >= MAX_POLLS) return;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      polls += 1;
      void invalidate("app:positions");
    };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  });

  const positionHref = (id: string) =>
    `${resolve("/(app)/posiciones")}?${new URLSearchParams({ p: id })}`;
  const positions = $derived(data.view?.positions ?? []);
  const position = $derived(positions.find((p) => p.id === data.selectedId));
  const steps = $derived(position ? stepViews(position) : []);
  const pending = $derived(
    data.view?.pending.filter((order) => order.positionId === position?.id) ?? [],
  );
  const sellable = $derived(position ? sellableQty(position, pending) : 0);
  const stop = $derived(position ? stopStatus(position.protectionState) : null);
  const failure = $derived(form !== null && "message" in form ? form.message : null);
  const failureTitle = $derived(
    form !== null && "title" in form && typeof form.title === "string"
      ? form.title
      : "No se envió la orden",
  );
  const notice = $derived(form !== null && "notice" in form ? form.notice : null);

  // One request at a time: a second click before the first answer must not become a second order.
  let sending = $state(false);
  let confirming = $state(false);
  const submit = ({ cancel }: { cancel: () => void }) => {
    if (sending) {
      cancel();
      return;
    }
    sending = true;
    return async ({ update }: { update: () => Promise<void> }) => {
      await update();
      sending = false;
      confirming = false;
      polls = 0;
    };
  };
</script>

<svelte:head><title>Posiciones · Reel Capital</title></svelte:head>

<div class="page">
  <header>
    <div class="title">
      <h1>Posiciones</h1>
      {#if data.view}
        <p class="count">{positions.length} de {data.view.maxPositions} posiciones</p>
      {/if}
    </div>
    <p class="lead">Gestiona tus posiciones abiertas.</p>
  </header>

  {#if data.error}
    <Notice title="No se pudo cargar" role="alert">{data.error}</Notice>
  {:else if !position || !data.view}
    <p class="empty">No tienes posiciones abiertas.</p>
    <p><Button variant="link" href={resolve("/(app)/operar")}>Nueva entrada</Button></p>
  {:else}
    <nav class="switcher" aria-label="Posiciones abiertas">
      {#each positions as other (other.id)}
        <!-- eslint-disable svelte/no-navigation-without-resolve -- resolve() is applied in positionHref -->
        <a
          href={positionHref(other.id)}
          aria-current={other.id === position.id ? "page" : undefined}
        >
          {switcherLabel(other)}
        </a>
        <!-- eslint-enable svelte/no-navigation-without-resolve -->
      {/each}
      {#if positions.length < data.view.maxPositions}
        <span class="free">Sin segunda posición</span>
      {/if}
    </nav>

    {#if failure}<Notice title={failureTitle} role="alert">{failure}</Notice>{/if}
    {#if notice}<Notice title={notice} />{/if}

    <div class="detail">
      <section class="left" aria-label="Posición">
        <h2 class="symbol">{headline(position)}</h2>
        <p class="instrument">{instrumentLine(position)}</p>

        <p class="remaining">{remainingLine(position)}</p>
        <p class="counts">
          {countsLine(position)}
        </p>
        <div class="progress">
          <ProgressBar value={soldPercent(position)} label={`${soldPercent(position)}% vendido`} />
        </div>

        <h3 class="section">Salidas parciales</h3>
        <form
          method="POST"
          action={`?/salir&p=${encodeURIComponent(position.id)}`}
          use:enhance={submit}
        >
          <input type="hidden" name="positionId" value={position.id} />
          <ol class="steps">
            {#each steps as step (step.index)}
              <li>
                <button
                  type="submit"
                  name="step"
                  value={step.index}
                  class="step"
                  data-state={step.state}
                  aria-label={step.name}
                  disabled={step.state !== "available" || sending}
                >
                  {#if step.state === "done"}<span aria-hidden="true">✓</span>{/if}
                  {step.pct}%
                </button>
              </li>
            {/each}
          </ol>
        </form>
        <ul class="rounded">
          {#each roundedToZero(steps) as step (step.index)}
            <li>{roundedToZeroLine(step, position)}</li>
          {/each}
        </ul>
        <p class="hint">
          {stepBasisHint(position)}
        </p>
      </section>

      <section class="right" aria-label="Protección y cierre">
        <h3 class="section">Protección</h3>
        <dl class="protection">
          <div class="row">
            <dt>Stop loss / {position.stopPct}%</dt>
            <dd data-active={stop?.active}>{stop?.label}</dd>
          </div>
          <div class="row trailing">
            <dt><label for="trailing-pct">Trailing</label></dt>
            <dd>
              <!-- TODO(#29): activating trailing needs the activateTrailing RPC; read-only until then. -->
              <select id="trailing-pct" disabled>
                {#each TRAILING_PCT_OPTIONS as pct (pct)}
                  <option value={pct} selected={pct === (position.trailingPct ?? 10)}>{pct}%</option
                  >
                {/each}
              </select>
              <Button variant="outline" disabled>Activar</Button>
            </dd>
          </div>
          <p class="note">
            Disponible desde {position.trailingUnlockPct}% vendido. Activar el trailing llegará con
            la protección de posiciones.
          </p>
        </dl>

        <div class="close">
          {#if confirming}
            <form
              method="POST"
              action={`?/salir&p=${encodeURIComponent(position.id)}`}
              use:enhance={submit}
            >
              <input type="hidden" name="positionId" value={position.id} />
              <input type="hidden" name="step" value="ALL_OUT" />
              <Notice title="¿Cerrar la posición?">
                Se venderá todo lo que queda de {headline(position)} a mercado. Esto no se puede deshacer.
              </Notice>
              <div class="confirm">
                <Button type="submit" variant="primary" disabled={sending}>
                  {sending ? "Enviando…" : "Confirmar cierre"}
                </Button>
                <Button type="button" variant="link" onclick={() => (confirming = false)}>
                  Volver
                </Button>
              </div>
            </form>
          {:else}
            <Button
              type="button"
              variant="primary"
              disabled={sending || sellable === 0}
              onclick={() => (confirming = true)}
            >
              Cerrar posición
            </Button>
          {/if}
          <p class="hint">{allOutHint(position, sellable)}</p>
        </div>
      </section>
    </div>

    <section class="pending" aria-label="Órdenes pendientes">
      <h3 class="section">Órdenes pendientes</h3>
      <div aria-live="polite">
        {#if pending.length === 0}
          <p class="hint">Sin órdenes pendientes.</p>
        {:else}
          <ul>
            {#each pending as order (order.id)}
              <li>
                <span class="kind">{pendingKindLabel(order.kind)}</span>
                <span>{formatUnits(order.qty, position)}</span>
                <span class="state" data-state={order.state}>{pendingStateLabel(order.state)}</span>
                {#if order.filledQty > 0}
                  <span class="hint">{order.filledQty} de {order.qty}</span>
                {/if}
                {#if order.cancelable}
                  <form
                    method="POST"
                    action={`?/cancelar&p=${encodeURIComponent(position.id)}`}
                    use:enhance={submit}
                  >
                    <input type="hidden" name="intentId" value={order.id} />
                    <Button type="submit" variant="outline" disabled={sending}>Cancelar</Button>
                  </form>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </section>
  {/if}

  <p class="mode">SIM · Simulación, sin dinero real</p>
</div>

<style>
  .page {
    display: grid;
    gap: 2rem;
  }
  p,
  h1,
  h2,
  h3,
  ol,
  ul,
  dl {
    margin: 0;
  }
  ol,
  ul {
    padding: 0;
    list-style: none;
  }
  .title {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
  }
  h1 {
    font-size: clamp(32px, 4vw, 42px);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: -0.02em;
  }
  .lead,
  .count,
  .hint,
  .note,
  .mode,
  .counts,
  .free {
    color: var(--text-muted);
  }
  .hint,
  .note,
  .mode {
    color: var(--text-dim);
    font-size: 14px;
  }
  .lead {
    margin-top: 0.75rem;
  }
  .switcher {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1.5rem;
    align-items: center;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--rule);
  }
  .switcher a {
    display: inline-flex;
    align-items: center;
    min-height: var(--target);
    color: var(--text-muted);
    text-decoration: none;
    border-bottom: 2px solid transparent;
  }
  .switcher a[aria-current="page"] {
    color: var(--text);
    font-weight: 500;
    border-bottom-color: var(--text);
  }
  .detail {
    display: grid;
    grid-template-columns: 56fr 40fr;
    gap: 0;
  }
  .left {
    padding-right: 3rem;
    border-right: 1px solid var(--rule);
  }
  .right {
    padding-left: 3rem;
  }
  .symbol {
    font-size: clamp(32px, 4vw, 38px);
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .instrument {
    margin-top: 0.25rem;
  }
  .remaining {
    margin-top: 2rem;
    font-size: 26px;
    font-weight: 500;
  }
  .counts {
    margin-top: 0.25rem;
    font-size: 14px;
  }
  .progress {
    margin-top: 1rem;
  }
  .section {
    margin-top: 3rem;
    margin-bottom: 1rem;
    color: var(--text-muted);
    font-size: 14px;
    font-weight: 400;
  }
  .right .section {
    margin-top: 0;
  }
  .steps {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 0.5rem;
  }
  .step {
    width: 100%;
    min-height: var(--target);
    padding: 0 0.25rem;
    border: 1px solid var(--text);
    border-radius: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }
  .step:disabled {
    border-color: var(--rule);
    background: var(--done);
    color: var(--text-dim);
    cursor: not-allowed;
  }
  .step[data-state="pending"] {
    border-style: dashed;
  }
  .rounded {
    margin-top: 0.75rem;
    color: var(--text-muted);
    font-size: 14px;
  }
  .left .hint {
    margin-top: 0.75rem;
  }
  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    min-height: var(--target);
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--rule);
  }
  dd {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 0;
  }
  dd[data-active="true"] {
    font-weight: 500;
  }
  dd[data-active="false"] {
    color: var(--text-muted);
  }
  .note {
    margin-top: 0.5rem;
  }
  select {
    min-height: var(--target);
    padding: 0 0.5rem;
    border: 1px solid var(--rule);
    border-radius: 0;
    background: var(--bg);
    color: var(--text-dim);
    font: inherit;
  }
  .close {
    margin-top: 3rem;
    display: grid;
    gap: 0.75rem;
  }
  .confirm {
    display: grid;
    gap: 0.5rem;
    margin-top: 1rem;
  }
  .pending ul {
    border-top: 1px solid var(--rule);
  }
  .pending li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1.5rem;
    padding: 0.75rem 0;
    border-bottom: 1px solid var(--rule);
  }
  .pending .section {
    margin-top: 0;
  }
  .kind {
    font-weight: 500;
  }
  .state {
    color: var(--text-muted);
  }
  .pending form {
    margin-left: auto;
  }

  /* Mobile / iPad: one column, the seven steps wrap 4 + 3. */
  @media (max-width: 900px) {
    .detail {
      grid-template-columns: 1fr;
    }
    .left {
      padding-right: 0;
      border-right: 0;
    }
    .right {
      padding-left: 0;
      margin-top: 3rem;
    }
    .steps {
      grid-template-columns: repeat(4, 1fr);
    }
    .title {
      flex-direction: column;
      gap: 0.5rem;
    }
  }
</style>
