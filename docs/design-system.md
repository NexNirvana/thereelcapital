# Design system

How the UI looks. **The PNGs in [`designs/desktop/`](../designs/desktop/) and [`designs/mobile/`](../designs/mobile/) are the reference for layout and copy**; this file gives the tokens and rules for reproducing them in code, plus what the PNGs don't show. The exact Spanish copy of each designed screen is in the `.prompt.md` next to its PNG.

Ignore the blue/green/red accents of the demo HTMLs and the cream/orange explorations in [`designs/explorations/`](../designs/explorations/).

## Principles

- **Dark, monochrome, near-brutalist, quiet.** Black/charcoal, neutral greys, off-white. No accent colors, gradients, glows, decorative shadows, textures, patterns or heavily rounded cards.
- **Information on the background, not in cards.** Definition rows separated by hairlines. Keep about 35% of the main area empty.
- **One filled primary action per view** (off-white fill, black text, right arrow). Everything else is outlined or a text link.
- **Status through text, icons, borders and contrast**, never color alone. BUY vs ALL OUT are distinguished by label, placement and treatment.
- **No charts, no P&L, no balance hero, no crypto or prediction motifs.**
- Minimalism never hides SIM/REAL, account, connection, daily limits, selected position or protection state.

## Tokens

From the final designs (decision D12; they supersede the palette proposed in ONBOARDING).

```css
:root {
  color-scheme: dark;
  --bg:            #101010; /* main canvas */
  --surface:       #161616; /* sidebar, subtle panels */
  --rule:          #333333; /* hairline separators, inactive bar track */
  --rule-strong:   #777777; /* outlined controls, flow boxes */
  --text:          #F3F3F0; /* primary text, primary button fill */
  --text-muted:    #B3B3B3; /* secondary text, captions */
  --text-dim:      #7A7A7A; /* disabled labels, used scale-out buttons */
  --done:          #2A2A2A; /* completed/disabled control fill (mobile) */
  --on-primary:    #0A0A0A; /* text/arrow on primary button */
  --focus:         #F3F3F0; /* 2px outline + 2px offset */
}
```

Single theme (dark only). No light mode.

## Typography

**One family: IBM Plex Mono, weights 400 / 500 / 600** (decision D23; the PNGs show a condensed display face, which this replaces). SIL Open Font License, **self-hosted** from the app (WOFF2 in `static/fonts/` with `@font-face`, `font-display: swap`; include the OFL text). Not loaded from a third-party CDN. Include Latin Extended for Spanish (á é í ó ú ñ ¿ ¡).

**Loading** (issue #231): `src/app.html` preloads the latin 400 and 600 faces (`rel=preload as=font crossorigin`, allowed by the CSP's `font-src 'self'`), so the fetch starts with the document instead of after the CSS parses. 400 is the inherited body weight and 600 the headings, buttons and emphasis; the 500 and latin-ext faces load on demand. `/fonts/*` is served `Cache-Control: public, max-age=31536000, immutable` (`_headers` at the repository root, which the Cloudflare adapter merges into the build output; Cloudflare serves static assets without running the Worker, so the security headers in `hooks.server.ts` are not involved). Because of that, **a font file is renamed when its content changes** (for example `ibm-plex-mono-latin-400-normal.v2.woff2`), updating `base.css` and the preload links together; a file with an unchanged name must never change. `font-weight: 700` is not used: there is no 700 face, and `600` renders the same.

```css
--font: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
font-variant-numeric: tabular-nums;
```

Keep the designs' **hierarchy** through size, weight, case and letter-spacing:

| Role | Use | Spec |
| --- | --- | --- |
| **Heading** | `NUEVA ENTRADA`, `POSICIONES`, `TU CUENTA. / TU OPERATIVA.`, wordmark | 600, uppercase, slight negative tracking; desktop H1 about 40px, login hero about 56–64px, mobile H1 about 32px |
| **Instrument / key figure** | `SPY`, `15 contratos restantes` | 600, 28–36px |
| **Primary button label** | `Revisar orden`, `Cerrar posición` | 600, 16–18px |
| **Body** | labels, subtitles, nav, captions | 400, sentence case, 14–16px; secondary in `--text-muted` |
| **Data** | SIZE, ask, quantities, %, account, time | 500, tabular numerals |

A monospaced face is wide, so check the long Spanish strings at 400px (`ALL OUT · Cierra los 15 contratos restantes`) and let them wrap.

## Layout shell

**Desktop** (see `designs/desktop/02-new-order.png`):
- Left sidebar **190px**, `--surface`: stacked wordmark `REEL / CAPITAL`; nav `Operar · Posiciones · Historial · Conexión` (a screen is listed once it is built; admins also get `Admin`); active item = slim white vertical bar + brighter text; `Cerrar sesión` and `thereelcapital.com` at the bottom.
- Top utility row, separated by one hairline: `● TradeStation conectado` · outlined `SIM` badge … `•• 4821` | `10:42 ET` (market time, `Intl` with America/New_York, refreshed each minute, not announced by screen readers). The account (last four characters) appears only while connected. The limits line stays hidden until M4 provides the counters.
- Content max-width about 1000px, generous padding. Breadcrumb (`Operar / Nueva entrada`) → H1 → subtitle; quiet limits line top-right (`1/2 posiciones · 2/3 entradas hoy`).
- Two unboxed columns (about 55/40) split by **one** thin vertical rule.
- (The PNGs' footer `SIM · Datos de ejemplo` marks sample data; it is not a UI element.)

**Mobile / iPad** (see `designs/mobile/`):
- Header: wordmark left, outlined `SIM` right; line `TradeStation · •• 4821`.
- Single column, stacked. Bottom tab nav `Operar · Posiciones · Historial` (active = underline; only the built screens are listed; decision D29). Conexión is reached from the header; `Admin` (admins) and `Cerrar sesión` sit in a footer below the content, not in the top bar, which keeps the brand and the connection state (decision D38). On Posiciones the heading reads `Posición`, the `x de 2 posiciones` count is hidden and the ALL OUT caption is the short `ALL OUT · 15 contratos`.
- Touch targets **≥ 44px**. Safe-area padding.

## Components

- **Badge (mode)**: black fill, 1px off-white/grey outline, mono caps `SIM` / `REAL`. Always visible.
- **Primary button**: off-white fill, black label (Plex Mono 600), right arrow `→`, square corners, full column width. Exactly one per view.
- **Outline button**: 1px `--text` border, transparent fill (e.g. `Activar trailing`).
- **Text link**: underlined (`Usar código de recuperación`).
- **Tabs**: text only; selected = brighter + underline (`Acciones | Opciones`).
- **Option chain (Opciones tab)**: four fields in one style (`.field-input`: 1px outlined box, same height, ellipsis instead of clipping): `Subyacente`, `Vencimiento`, `Strike` and `Mostrar` (comboboxes with arrow-key, Enter and Escape handling), above a `Call bid/ask | Strike | Put bid/ask` table with a price line at the underlying price, shading on the in-the-money side and `Sin dato` for a side with no market. Picking a price fills the order summary on the same page.
- **Definition row**: label left (body), value right (mono), hairline below. Read-only values look read-only (no input chrome).
- **Progress bar**: thin; filled `--text`, track `--rule`; right label `70% vendido`.
- **Scale-out bar**: 7 compact square-cornered buttons in one row (`30% 20% 10% 10% 10% 10% 10%`). Available = outlined; used = dimmed + ✓ (mobile: `--done` fill with ✓, label below); pending = distinct label (e.g. `…` / `Enviando`), never re-clickable; used with zero quantity = dimmed + caption «0 contratos por redondeo». Wraps 4+3 on narrow screens.
- **Protection rows**: `Stop loss / 30%` + verified state (`Activo` / `No verificado`); `Trailing / 10%` + % selector (allowed values only, no free text) + `Activar trailing` + caption `Disponible desde 70% vendido` on desktop and mobile (D42), or the real eligibility.
- **Admin tables** (lists of clients, orders, fills, errors, audit): mono rows with hairlines, a filter bar (text search + selects), no zebra colors, sticky header, horizontal scroll container on mobile.
- **Notices**: connection, permission, unknown result and protection-loss messages. Bordered text block, never hidden or color-only.
- **Focus**: always visible (2px outline). Keyboard reachable.

## Formats

UI copy is Spanish. Numbers: `US$20,000`, `US$4.00`, `50 contratos`, dates `20 nov 2026`, times `10:42 ET`.

**Error page** (`+error.svelte` at the root, in `(app)` and in `admin`): the Spanish title and message depend only on the status (401, 403, 404, 5xx, other 4xx), with the stable code in small type and one button (`Ir a Operar`, or `Ir al acceso` for 401). Internal messages never reach the page. An address no route matches renders it without the shell.

**Recovery-code prompt**: when the signed-in client has no unused recovery codes, the shell shows a prompt above the content. `Generar códigos` calls `POST /api/recovery-codes`; a session older than 10 minutes asks for `Confirmar con passkey` first. The codes are shown once and leave the page when the client confirms with `Ya los guardé`.

**Admin shell**: `/admin/**` uses the same shell as the client app (`src/lib/ui/AppShell.svelte`, shared by both layouts): the sidebar lists `Clientes · Operativa · Historial · Auditoría` and a link back to `Operar` (nav `aria-label="Administración"`, `aria-current` on the current section; Clientes also covers the client and admin detail pages), with `Cerrar sesión` and the domain at the bottom. The top bar carries the `SIM` badge and the New York clock but no TradeStation connection or account, which belong to a client. On a phone the tab bar keeps the four sections and `Operar` and `Cerrar sesión` sit in the footer. Pages open with the shared `PageHeader` (breadcrumb `Admin / <section>` → H1 → subtitle). On a phone the client list stacks each client as email, `Acceso`, `Conexión`, one per line.
