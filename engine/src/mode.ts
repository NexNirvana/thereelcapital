import { Schema } from "effect";

/** REAL is decoded so it can be rejected by name; it is never served (CLAUDE.md, SIM only). */
export const Mode = Schema.Literals(["SIM", "REAL"]);
export type Mode = typeof Mode.Type;
