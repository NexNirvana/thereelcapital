<script lang="ts">
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { authClient } from "#lib/auth-client.ts";

  let pending = $state(false);
  let failed = $state(false);

  async function signOut() {
    pending = true;
    failed = false;
    const { error } = await authClient.signOut();
    pending = false;
    if (error) {
      failed = true;
      return;
    }
    await goto(resolve("/acceso"), { invalidateAll: true });
  }
</script>

<button type="button" onclick={signOut} disabled={pending}>
  {failed ? "No se cerró. Reintentar" : pending ? "Cerrando sesión" : "Cerrar sesión"}
</button>

<style>
  button {
    display: inline-flex;
    align-items: center;
    min-height: var(--target);
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  button:disabled {
    cursor: default;
  }
</style>
