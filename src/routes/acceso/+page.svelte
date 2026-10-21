<script lang="ts">
  import { goto, invalidateAll } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { authClient } from "#lib/auth-client.ts";
  import { passkeyErrorMessage } from "#lib/auth-messages.ts";
  import Button from "#lib/ui/Button.svelte";
  import Notice from "#lib/ui/Notice.svelte";

  let pending = $state(false);
  let failure = $state<string | null>(null);

  // The server decides everything; the page only starts the ceremony and shows the outcome.
  async function signIn() {
    pending = true;
    failure = null;
    const { error } = await authClient.signIn.passkey();
    if (error) {
      failure = passkeyErrorMessage("code" in error ? error.code : undefined);
      pending = false;
      return;
    }
    await invalidateAll();
    await goto(resolve("/(app)"));
  }
</script>

<svelte:head><title>Acceso · Reel Capital</title></svelte:head>

<div class="access">
  <header>
    <span class="wordmark">REEL<br class="desktop-only" /> CAPITAL</span>
    <span class="private desktop-only">Acceso privado</span>
  </header>

  <main>
    <section class="pitch">
      <h1>Tu cuenta.<br />Tu operativa.</h1>
      <p>Terminal privado de acciones y opciones.</p>
      <p class="desktop-only">Opera desde tu propia cuenta de TradeStation.</p>
    </section>

    <section class="sign-in" aria-labelledby="welcome">
      <h2 id="welcome" class="desktop-only">Bienvenido.</h2>
      <p class="invite">
        <svg viewBox="0 0 16 16" width="20" height="20" fill="none" aria-hidden="true">
          <rect x="3" y="7" width="10" height="7" stroke="currentColor" stroke-width="1.5" />
          <path d="M5 7V5a3 3 0 0 1 6 0v2" stroke="currentColor" stroke-width="1.5" />
        </svg>
        <span class="desktop-only">Acceso solo por invitación</span>
        <span class="mobile-only">Solo por invitación</span>
      </p>
      <p class="hint desktop-only">Usa tu passkey para continuar.</p>

      <Button variant="primary" onclick={signIn} disabled={pending}>
        {pending ? "Esperando tu passkey" : "Entrar con passkey"}
      </Button>
      <div class="failure" aria-live="assertive">
        {#if failure}<Notice title="No pudimos entrar" role="alert">{failure}</Notice>{/if}
      </div>

      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the route lands in #14 -->
      <a class="recovery" href="/recuperacion">
        <span class="desktop-only">Usar código de recuperación</span>
        <span class="mobile-only">Código de recuperación</span>
      </a>
      <p class="contact desktop-only">¿Necesitas acceso? Contacta al administrador.</p>
    </section>
  </main>

  <footer>
    <small>thereelcapital.com</small>
    <small class="desktop-only">REEL CAPITAL</small>
  </footer>
</div>

<style>
  .access {
    display: grid;
    grid-template-rows: auto 1fr auto;
    min-height: 100dvh;
    padding: 1.5rem clamp(1rem, 4vw, 3rem);
  }
  header,
  footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    color: var(--text-muted);
  }
  .wordmark {
    line-height: 1.05;
    color: var(--text);
    font-weight: 600;
    letter-spacing: -0.04em;
  }
  main {
    display: grid;
    grid-template-columns: 58fr 32fr;
    align-items: center;
    gap: clamp(2rem, 8vw, 7rem);
    padding: 3rem 0;
  }
  .pitch {
    padding: 4.5rem clamp(1rem, 4vw, 4rem) 4.5rem clamp(0rem, 7vw, 6rem);
    border-right: 1px solid var(--rule-strong);
  }
  h1 {
    font-size: clamp(2.5rem, 5.6vw, 5.5rem);
    line-height: 1;
    margin-bottom: 1.5rem;
  }
  p {
    margin: 0;
  }
  .pitch p {
    color: var(--text-muted);
    font-size: 1.125rem;
  }
  .mobile-only {
    display: none;
  }
  h2 {
    font-size: 2.5rem;
    text-transform: none;
  }
  .invite {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0.75rem 0 1.5rem;
    color: var(--text-muted);
  }
  .hint {
    margin-bottom: 2rem;
    font-size: 1.125rem;
  }
  .failure {
    margin-top: 1rem;
  }
  .recovery {
    display: inline-flex;
    align-items: center;
    min-height: var(--target);
    margin-top: 0.75rem;
    color: var(--text);
    text-underline-offset: 4px;
  }
  .contact {
    margin-top: 1.5rem;
    color: var(--text-muted);
  }

  /* docs/design-system.md: the mobile screen is the short version of the same copy. */
  @media (max-width: 900px) {
    .desktop-only {
      display: none;
    }
    .mobile-only {
      display: inline;
    }
    /* The invitation line sits under the pitch; the button and links sink to the bottom. */
    main {
      display: flex;
      flex-direction: column;
      padding: 2rem 0;
    }
    .sign-in {
      display: contents;
    }
    .invite {
      order: 1;
      justify-content: flex-start;
      align-self: flex-start;
      margin: 1rem 0 0;
    }
    .sign-in :global(.button),
    .failure,
    .recovery {
      order: 2;
    }
    .sign-in :global(.button) {
      margin-top: auto;
    }
    .pitch {
      padding: 0;
      border-right: 0;
    }
    .pitch p {
      font-size: 1rem;
    }
    .recovery {
      align-self: flex-start;
      color: var(--text-muted);
      text-decoration: none;
    }
    h1 {
      font-size: clamp(2rem, 11vw, 3.5rem);
    }
  }
</style>
