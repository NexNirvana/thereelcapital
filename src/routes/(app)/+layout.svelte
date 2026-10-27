<script lang="ts">
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { indicatorFor } from "#lib/ui/connection-indicator.ts";
  import { keepLiveSocketOpen } from "#lib/ui/live-feed.ts";
  import AppShell from "#lib/ui/AppShell.svelte";
  import RecoveryCodesPrompt from "#lib/ui/RecoveryCodesPrompt.svelte";
  import type { LayoutProps } from "./$types";

  let { children, data }: LayoutProps = $props();
  const indicator = $derived(indicatorFor(data.health));

  // One live-price socket for the whole signed-in app (D47): it opens with the app and stays open
  // across navigation; each screen only says what it watches. Screens that are not on the stream
  // keep polling as before.
  $effect(() => keepLiveSocketOpen());

  const isCurrent = (href: string) => page.url.pathname.startsWith(href);
  const link = (href: string, label: string) => ({ href, label, current: isCurrent(href) });

  // Only built screens are listed. Conexión is also
  // reachable from the top bar.
  const nav = $derived([
    link(resolve("/(app)/operar"), "Operar"),
    link(resolve("/(app)/posiciones"), "Posiciones"),
    link(resolve("/(app)/historial"), "Historial"),
    link(resolve("/(app)/conexion"), "Conexión"),
    ...(data.isAdmin ? [link(resolve("/admin"), "Admin")] : []),
  ]);

  // D29: the mobile tab bar keeps the three designed tabs; Conexión sits in the top bar.
  const tabs = $derived(
    nav.filter((item) => ["Operar", "Posiciones", "Historial"].includes(item.label)),
  );
</script>

<AppShell
  home={resolve("/(app)/operar")}
  {nav}
  {tabs}
  connection={{ ...indicator, href: resolve("/(app)/conexion") }}
  account={data.account}
  extras={data.isAdmin ? [{ href: resolve("/admin"), label: "Admin" }] : []}
>
  {#snippet notice()}
    {#if data.unusedCodes === 0}<RecoveryCodesPrompt />{/if}
  {/snippet}
  {@render children()}
</AppShell>
