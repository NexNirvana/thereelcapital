<script lang="ts">
  import { resolve } from "$app/paths";
  import Button from "./Button.svelte";
  import Notice from "./Notice.svelte";
  import type { ConnectionAlert } from "./connection-alert.ts";

  let { alert }: { alert: ConnectionAlert } = $props();
</script>

<div class="alert" data-kind={alert.kind}>
  <Notice title={alert.title} role="alert">
    {#each alert.lines as line (line)}<p>{line}</p>{/each}
    <p><Button variant="link" href={resolve("/(app)/conexion")}>{alert.action}</Button></p>
  </Notice>
</div>

<style>
  .alert {
    margin-bottom: 1.5rem;
  }
  p {
    margin: 0.25rem 0 0;
  }
</style>
