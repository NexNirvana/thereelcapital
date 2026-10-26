<script lang="ts">
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import AppShell from "#lib/ui/AppShell.svelte";
  import type { LayoutProps } from "./$types";

  let { children }: LayoutProps = $props();

  // Clientes also covers the client and admin detail pages under /admin.
  const sections = [
    resolve("/admin/operativa"),
    resolve("/admin/historial"),
    resolve("/admin/auditoria"),
  ];
  const root = resolve("/admin");
  const current = (href: string) => {
    const path = page.url.pathname;
    return href === root
      ? !sections.some((section) => path.startsWith(section))
      : path.startsWith(href);
  };
  const link = (href: string, label: string) => ({ href, label, current: current(href) });

  const tabs = $derived([
    link(root, "Clientes"),
    link(resolve("/admin/operativa"), "Operativa"),
    link(resolve("/admin/historial"), "Historial"),
    link(resolve("/admin/auditoria"), "Auditoría"),
  ]);
  // The way back to the client app is a link, never the current section.
  const operar = { href: resolve("/(app)/operar"), label: "Operar", current: false };
  const nav = $derived([...tabs, operar]);
</script>

<AppShell home={root} label="Administración" {nav} {tabs} extras={[operar]}>
  {@render children()}
</AppShell>
