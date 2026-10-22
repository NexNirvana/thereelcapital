import { describe, expect, it } from "bun:test";
import type { PositionView } from "#lib/domain/positions-view.ts";
import {
  exitBlockMessage,
  formatExpiration,
  formatUnits,
  allOutHint,
  cancelOutcome,
  exitOutcome,
  sellableQty,
  countsLine,
  instrumentLine,
  remainingLine,
  roundedToZeroLine,
  stepBasisHint,
  roundedToZero,
  soldPercent,
  stepViews,
  stopStatus,
  switcherLabel,
  trailingStatus,
} from "./positions.ts";

const call: PositionView = {
  id: "p1",
  accountId: "SIM-1",
  symbol: "SPY 261120C600",
  option: { underlying: "SPY", expiration: "2026-11-20", strikeMicros: 600_000_000, right: "call" },
  originalQty: 50,
  soldQty: 35,
  protectionState: "none",
  stopPct: 30,
  trailingUnlockPct: 70,
  trailingPct: null,
  steps: ["done", "done", "done_zero", "done", "available", "available", "available"],
};

describe("positions screen wording", () => {
  it("words an option as the design does", () => {
    expect(switcherLabel(call)).toBe("SPY · Call 600");
    expect(instrumentLine(call)).toBe("Call 600 · 20 nov 2026");
    expect(formatExpiration("2026-01-05")).toBe("5 ene 2026");
  });

  it("keeps a fractional strike and says shares as shares", () => {
    const put = {
      ...call,
      option: { ...call.option!, strikeMicros: 602_500_000, right: "put" as const },
    };
    expect(switcherLabel(put)).toBe("SPY · Put 602.5");
    expect(formatUnits(1, { option: null })).toBe("1 acción");
    expect(formatUnits(15, call)).toBe("15 contratos");
  });

  it("says what remains and what ALL OUT closes", () => {
    expect(remainingLine(call)).toBe("15 contratos restantes");
    expect(allOutHint(call, 15)).toBe("ALL OUT · Cierra los 15 contratos restantes");
    const shares = { ...call, option: null, originalQty: 198, soldQty: 0 };
    expect(allOutHint(shares, 198)).toBe("ALL OUT · Cierra las 198 acciones restantes");
    expect(remainingLine({ ...shares, soldQty: 197 })).toBe("1 acción restante");
    expect(allOutHint(shares, 1)).toBe("ALL OUT · Cierra la acción restante");
    expect(allOutHint(call, 1)).toBe("ALL OUT · Cierra el contrato restante");
    expect(countsLine(call)).toBe("50 iniciales · 35 vendidos");
    expect(countsLine({ ...call, originalQty: 1, soldQty: 1 })).toBe("1 inicial · 1 vendido");
    expect(stepBasisHint({ ...call, originalQty: 1 })).toBe(
      "Porcentajes sobre la cantidad inicial: 1 contrato",
    );
  });

  it("words the step basis and the zero rounding for the instrument", () => {
    const third = { index: 2, pct: 10, state: "done_zero", name: "" } as const;
    expect(stepBasisHint(call)).toBe("Porcentajes sobre los 50 contratos iniciales");
    expect(roundedToZeroLine(third, call)).toBe("Paso 3 (10%): 0 contratos por redondeo");
    const shares = { ...call, option: null, originalQty: 198 };
    expect(stepBasisHint(shares)).toBe("Porcentajes sobre las 198 acciones iniciales");
    expect(roundedToZeroLine(third, shares)).toBe("Paso 3 (10%): 0 acciones por redondeo");
  });

  it("holds back the unfilled part of working orders from ALL OUT", () => {
    const order = (positionId: string, qty: number, filledQty: number) => ({
      id: "i",
      positionId,
      kind: "exit",
      state: "ACKNOWLEDGED",
      qty,
      filledQty,
      cancelable: true,
    });
    expect(sellableQty(call, [])).toBe(15);
    expect(sellableQty(call, [order("p1", 10, 4), order("other", 99, 0)])).toBe(9);
    expect(sellableQty(call, [order("p1", 20, 0)])).toBe(0);
  });

  it("does not call a rejected, unknown or untaken order a success", () => {
    expect(exitOutcome("ACKNOWLEDGED")).toMatchObject({ ok: true });
    expect(exitOutcome("FILLED")).toMatchObject({ ok: true });
    expect(exitOutcome("REJECTED")).toMatchObject({ ok: false });
    expect(exitOutcome("UNKNOWN")).toMatchObject({ ok: false });
    expect(exitOutcome("UNKNOWN")).toMatchObject({ title: "Verificando la orden" });
    expect(exitOutcome("UNKNOWN").message).toContain("no es un fallo");
    expect(cancelOutcome("CANCEL_PENDING")).toMatchObject({ ok: true });
    expect(cancelOutcome("ACKNOWLEDGED")).toMatchObject({ ok: false });
  });

  it("shows 70% sold for 35 of 50, and never 100% while something remains", () => {
    expect(soldPercent(call)).toBe(70);
    expect(soldPercent({ ...call, originalQty: 1000, soldQty: 999 })).toBe(99);
    expect(soldPercent({ ...call, soldQty: 50 })).toBe(100);
  });

  it("lists seven steps and flags the ones rounded to zero", () => {
    const steps = stepViews(call);
    expect(steps.map((s) => s.pct)).toEqual([30, 20, 10, 10, 10, 10, 10]);
    expect(steps[0]?.name).toBe("Paso 1, 30%, vendido");
    expect(roundedToZero(steps).map((s) => s.index)).toEqual([2]);
  });

  it("calls a stop active only when verified", () => {
    expect(stopStatus("verified")).toEqual({ label: "Activo", active: true });
    for (const state of ["none", "unverified", "pending", "anything"]) {
      expect(stopStatus(state).active).toBe(false);
      expect(stopStatus(state).label).not.toBe("Activo");
    }
  });

  it("words block codes, with a fallback", () => {
    expect(exitBlockMessage(["UNKNOWN_INTENT_PENDING"])).toContain("verificación");
    expect(exitBlockMessage(["SOMETHING_NEW"])).toBe("No pudimos enviar la orden ahora.");
  });
});

describe("trailing activation", () => {
  const working = [
    {
      id: "o1",
      positionId: "p1",
      kind: "exit",
      state: "ACKNOWLEDGED",
      qty: 3,
      filledQty: 0,
      cancelable: true,
    },
  ];

  it("offers Activar once enough is sold and nothing is working", () => {
    expect(trailingStatus(call, [])).toEqual({ active: false, canActivate: true });
  });

  it("does not offer it before the unlock share, with an order working, or once active", () => {
    expect(trailingStatus({ ...call, soldQty: 34 }, []).canActivate).toBe(false);
    expect(trailingStatus(call, working).canActivate).toBe(false);
    expect(trailingStatus({ ...call, trailingPct: 10 }, [])).toEqual({
      active: true,
      canActivate: false,
    });
  });

  it("says why the engine refused", () => {
    expect(exitBlockMessage(["NOT_ELIGIBLE"])).toContain("trailing");
    expect(exitBlockMessage(["EXIT_PENDING"])).toContain("en curso");
    expect(exitBlockMessage(["ALREADY_ACTIVE"])).toContain("ya está activo");
    expect(exitBlockMessage(["QUOTE_UNAVAILABLE"])).toContain("precio");
  });
});
