// The mode an admin screen reads (`?modo=`): the admin may read both modes, so unlike a client it is
// a plain query parameter. Reading REAL places nothing; the engine still refuses it while the
// deployment is closed (D52), and that reads as "unavailable".
import { Schema } from "effect";
import { decode } from "./decode.ts";
import type { TradingMode } from "./trading-mode.ts";

export const AdminModeQuery = Schema.Struct({
  modo: Schema.optionalKey(Schema.Literals(["SIM", "REAL"])),
});

/** `SIM` unless the URL says `modo=REAL`; any other value is a 400. Other parameters are ignored. */
export function adminModeOf(url: URL): TradingMode {
  const modo = url.searchParams.get("modo");
  return decode(AdminModeQuery, modo === null ? {} : { modo }).modo ?? "SIM";
}
