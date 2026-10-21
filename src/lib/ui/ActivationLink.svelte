<script lang="ts">
  import Button from "./Button.svelte";
  import Notice from "./Notice.svelte";

  // The one-time activation link the admin shares personally: shown from an action response only.
  let {
    title,
    link,
    expiresAt,
    onhide,
  }: { title: string; link: string; expiresAt: number; onhide: () => void } = $props();

  const expiry = new Intl.DateTimeFormat("es", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/New_York",
  });

  let copied = $state(false);
  let copyFailed = $state(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      copied = true;
      copyFailed = false;
    } catch {
      copied = false;
      copyFailed = true;
    }
  }
</script>

<Notice {title}>
  Comparte este enlace personalmente; no enviamos correos. Se muestra una sola vez y vence el
  {expiry.format(expiresAt)} ET.
</Notice>
<label for="activation-link">Enlace de activación</label>
<div class="copy">
  <input
    id="activation-link"
    type="text"
    readonly
    value={link}
    onfocus={(event) => event.currentTarget.select()}
  />
  <Button onclick={copy}>{copied ? "Copiado" : "Copiar enlace"}</Button>
</div>
{#if copyFailed}
  <Notice title="No se copió el enlace" role="alert">
    Selecciona el enlace del campo y cópialo a mano; no volverá a mostrarse.
  </Notice>
{/if}
<Button variant="link" onclick={onhide}>Ya lo copié, ocultar</Button>

<style>
  label {
    color: var(--text-muted);
  }
  input {
    min-height: var(--target);
    padding: 0 0.75rem;
    border: 1px solid var(--rule-strong);
    border-radius: 0;
    background: var(--bg);
    color: var(--text);
    font: inherit;
  }
  .copy {
    display: flex;
    gap: 0.75rem;
  }
  .copy input {
    flex: 1;
    min-width: 0;
  }
  @media (max-width: 600px) {
    .copy {
      flex-direction: column;
    }
  }
</style>
