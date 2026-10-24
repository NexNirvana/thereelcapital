<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import { signInWithPasskey } from "#lib/passkey-sign-in.ts";
  import Button from "./Button.svelte";
  import Notice from "./Notice.svelte";

  // A new passkey sign-in makes the session fresh again; the admin then repeats the action.
  // `refresh` re-runs every load after the sign-in; a caller whose own state must survive it (the
  // recovery-code prompt shows codes that make a layout load see them as existing) turns it off.
  let { onconfirmed, refresh = true }: { onconfirmed: () => void; refresh?: boolean } = $props();

  let reauthenticating = $state(false);
  let failure = $state<string | null>(null);

  async function confirmIdentity() {
    reauthenticating = true;
    failure = null;
    failure = await signInWithPasskey();
    reauthenticating = false;
    if (failure) return;
    onconfirmed();
    if (refresh) await invalidateAll();
  }
</script>

<Button onclick={confirmIdentity} disabled={reauthenticating}>
  {reauthenticating ? "Esperando tu passkey" : "Confirmar con passkey"}
</Button>
{#if failure}<Notice title="No pudimos confirmar" role="alert">{failure}</Notice>{/if}
