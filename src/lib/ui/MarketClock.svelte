<script lang="ts">
  import { formatMarketClock, msToNextMinute } from "./shell.ts";

  let now = $state(new Date());

  // Re-aligns to the minute boundary on every tick, so the display never lags a whole minute.
  $effect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const current = new Date();
      now = current;
      timer = setTimeout(tick, msToNextMinute(current));
    };
    tick();
    return () => clearTimeout(timer);
  });
</script>

<!-- A ticking clock must not be announced by screen readers. -->
<time aria-live="off" datetime={now.toISOString()} title="Hora de mercado">
  {formatMarketClock(now)}
</time>
