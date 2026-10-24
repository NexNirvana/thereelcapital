<script lang="ts">
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";

  let pending = $state(false);
  let failed = $state(false);

  async function signOut() {
    pending = true;
    failed = false;
    // Plain POST instead of the Better Auth client, so the passkey client chunk is not loaded on
    // every signed-in page. The browser adds `Origin`, which the origin check needs.
    const signedOut = await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
      .then((response) => response.ok)
      .catch(() => false);
    pending = false;
    if (!signedOut) {
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
