<script lang="ts">
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import Badge from "#lib/ui/Badge.svelte";
  import { indicatorFor } from "#lib/ui/connection-indicator.ts";
  import MarketClock from "#lib/ui/MarketClock.svelte";
  import RecoveryCodesPrompt from "#lib/ui/RecoveryCodesPrompt.svelte";
  import { maskAccount } from "#lib/ui/shell.ts";
  import SignOutButton from "#lib/ui/SignOutButton.svelte";
  import type { LayoutProps } from "./$types";

  let { children, data }: LayoutProps = $props();
  const indicator = $derived(indicatorFor(data.health));

  // Only built screens are listed. Conexión is also
  // reachable from the top bar.
  const nav = $derived([
    { href: resolve("/(app)/operar"), label: "Operar" },
    { href: resolve("/(app)/posiciones"), label: "Posiciones" },
    { href: resolve("/(app)/historial"), label: "Historial" },
    { href: resolve("/(app)/conexion"), label: "Conexión" },
    ...(data.isAdmin ? [{ href: resolve("/admin"), label: "Admin" }] : []),
  ]);

  // D29: the mobile tab bar keeps the three designed tabs; Conexión sits in the top bar.
  const tabs = $derived(
    nav.filter((item) => ["Operar", "Posiciones", "Historial"].includes(item.label)),
  );

  const isCurrent = (href: string) => page.url.pathname.startsWith(href);
</script>

<div class="shell">
  <aside class="sidebar">
    <a class="wordmark" href={resolve("/(app)/operar")}>REEL<br />CAPITAL</a>
    <nav aria-label="Principal">
      <ul>
        {#each nav as item (item.href)}
          <li>
            <a href={item.href} aria-current={isCurrent(item.href) ? "page" : undefined}>
              {item.label}
            </a>
          </li>
        {/each}
      </ul>
    </nav>
    <div class="signout"><SignOutButton /></div>
    <small class="domain">thereelcapital.com</small>
  </aside>

  <div class="main">
    <header class="topbar">
      <a class="wordmark mobile-only" href={resolve("/(app)/operar")}>REEL CAPITAL</a>
      <p class="connection" aria-live="polite">
        <span class="dot" class:hollow={!indicator.healthy} aria-hidden="true"></span>
        <a class="plain" href={resolve("/(app)/conexion")}>{indicator.label}</a>
        {#if indicator.action}
          <a class="reconnect" href={resolve("/(app)/conexion")}>{indicator.action}</a>
        {/if}
      </p>
      <div class="mode"><Badge label="SIM" /></div>
      {#if data.account}
        <p class="account" title="Cuenta">{maskAccount(data.account)}</p>
      {/if}
      <p class="clock desktop-only"><MarketClock /></p>
    </header>

    <main>
      {#if data.unusedCodes === 0}<RecoveryCodesPrompt />{/if}
      {@render children()}
    </main>

    <footer class="mobile-only extras">
      {#if data.isAdmin}<a href={resolve("/admin")}>Admin</a>{/if}
      <SignOutButton />
    </footer>
  </div>

  <nav class="tabbar" aria-label="Principal">
    <ul>
      {#each tabs as item (item.href)}
        <li>
          <a href={item.href} aria-current={isCurrent(item.href) ? "page" : undefined}>
            {item.label}
          </a>
        </li>
      {/each}
    </ul>
  </nav>
</div>

<style>
  .shell {
    display: grid;
    grid-template-columns: var(--sidebar-width) 1fr;
    min-height: 100dvh;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  a {
    color: inherit;
    text-decoration: none;
  }
  p {
    margin: 0;
  }

  /* Sidebar (desktop) */
  .sidebar {
    position: sticky;
    top: 0;
    display: flex;
    flex-direction: column;
    height: 100dvh;
    padding: 2rem 0 1.5rem;
    background: var(--surface);
  }
  .wordmark {
    font-weight: 600;
    font-size: 26px;
    line-height: 1.05;
    letter-spacing: -0.04em;
  }
  .sidebar .wordmark {
    padding: 0 1.5rem;
  }
  .sidebar nav {
    margin-top: 3rem;
  }
  .sidebar nav a {
    display: flex;
    align-items: center;
    min-height: var(--target);
    padding: 0 1.5rem;
    border-left: 2px solid transparent;
    color: var(--text-muted);
  }
  .sidebar nav a[aria-current="page"] {
    border-left-color: var(--text);
    color: var(--text);
    font-weight: 500;
  }
  .signout {
    margin-top: auto;
    padding: 0 1.5rem;
    color: var(--text-muted);
  }
  .domain {
    margin-top: 1rem;
    font-size: 13px;
    overflow-wrap: normal;
    padding: 0 1.5rem;
    color: var(--text-muted);
  }

  /* Top utility row */
  .main {
    min-width: 0;
    padding: 0 2rem;
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: 1.25rem;
    min-height: 70px;
    border-bottom: 1px solid var(--rule);
  }
  .connection {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-height: var(--target);
  }
  .connection a {
    display: flex;
    align-items: center;
    gap: 0.5em;
    min-height: var(--target);
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--text);
  }
  .dot.hollow {
    border: 1.5px solid var(--text);
    background: transparent;
  }
  .reconnect {
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .account {
    margin-left: auto;
    font-weight: 500;
  }
  .clock {
    padding-left: 1.25rem;
    border-left: 1px solid var(--rule);
    color: var(--text-muted);
    font-weight: 500;
  }
  main {
    max-width: 1100px;
    padding: 2.5rem 0.5rem;
  }

  .mobile-only,
  .tabbar {
    display: none;
  }

  /* Mobile / iPad */
  @media (max-width: 900px) {
    .shell {
      display: block;
      padding-bottom: calc(var(--target) + 1.5rem + env(safe-area-inset-bottom));
    }
    .sidebar,
    .desktop-only {
      display: none;
    }
    .mobile-only {
      display: block;
    }
    .main {
      padding: 0 1rem;
    }
    .topbar {
      display: grid;
      grid-template-columns: 1fr auto;
      grid-template-areas:
        "word mode"
        "conn acct";
      gap: 0;
      padding-top: env(safe-area-inset-top);
      border-bottom: 0;
    }
    .topbar .wordmark {
      grid-area: word;
      align-self: center;
      padding: 1rem 0 0.25rem;
      font-size: 24px;
    }
    .mode {
      grid-area: mode;
      align-self: center;
      padding-top: 0.75rem;
    }
    .connection {
      grid-area: conn;
      flex-wrap: wrap;
      gap: 0 0.75rem;
      color: var(--text-muted);
    }
    .dot {
      display: none;
    }
    .account {
      grid-area: acct;
      align-self: start;
      display: flex;
      align-items: center;
      min-height: var(--target);
      margin: 0;
      color: var(--text-muted);
    }
    main {
      padding: 1.5rem 0;
    }
    .tabbar {
      position: fixed;
      inset: auto 0 0;
      display: block;
      padding: 0 1rem env(safe-area-inset-bottom);
      border-top: 1px solid var(--rule);
      background: var(--bg);
    }
    .extras {
      display: flex;
      align-items: center;
      gap: 1.5rem;
      padding-bottom: 1.5rem;
      color: var(--text-muted);
      font-size: 13px;
    }
    .extras a {
      display: flex;
      align-items: center;
      min-height: var(--target);
    }
    .tabbar ul {
      display: flex;
      justify-content: space-between;
      gap: 0.25rem;
      overflow-x: auto;
      font-size: 12px;
      white-space: nowrap;
      scrollbar-width: none;
    }
    .tabbar {
      color: var(--text-muted);
    }
    .tabbar a {
      display: flex;
      align-items: center;
      min-height: var(--target);
      border-bottom: 2px solid transparent;
      color: var(--text-muted);
    }
    .tabbar a[aria-current="page"] {
      border-bottom-color: var(--text);
      color: var(--text);
      font-weight: 500;
    }
  }
</style>
