<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import { authClient } from "#lib/auth-client.ts";
  import { passkeyErrorMessage } from "#lib/auth-messages.ts";
  import Button from "./Button.svelte";
  import Notice from "./Notice.svelte";

  // A new passkey sign-in makes the session fresh again; the admin then repeats the action.
  let { onconfirmed }: { onconfirmed: () => void } = $props();

  let reauthenticating = $state(false);
  let failure = $state<string | null>(null);

  async function confirmIdentity() {
    reauthenticating = true;
    failure = null;
    const { error } = await authClient.signIn.passkey();
    reauthenticating = false;
    if (error) {
      failure = passkeyErrorMessage("code" in error ? error.code : undefined);
      return;
    }
    onconfirmed();
    await invalidateAll();
  }
</script>

<Button onclick={confirmIdentity} disabled={reauthenticating}>
  {reauthenticating ? "Esperando tu passkey" : "Confirmar con passkey"}
</Button>
{#if failure}<Notice title="No pudimos confirmar" role="alert">{failure}</Notice>{/if}
