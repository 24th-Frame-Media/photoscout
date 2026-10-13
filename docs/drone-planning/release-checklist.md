# Drone Planning Overlay Release Checklist

This release checklist verifies that the PhotoScout Drone Planning advisory overlay complies with all safety, security, legal, and operational guardrails before merge.

---

## 1. Automated Test Gates

All test suites and checks must pass cleanly:

- [x] **Server drone test suite:**
  `npx tsx --test server/test/openaip.test.ts server/test/droneRuleCatalog.test.ts server/test/droneAssessment.test.ts server/test/droneFireHazards.test.ts server/test/dronePopulation.test.ts server/test/droneHttp.test.ts` (43/43 pass)
- [x] **Web test suite:**
  `npm test -w web` (271/271 pass)
- [x] **Web drone test suite:**
  `npx tsx --test web/test/drone.test.ts web/test/dronePlanningPanel.test.ts` (8/8 pass)
- [x] **TypeScript compilation:**
  `npm run typecheck` (server, crawler, web pass with zero errors)
- [x] **Production build:**
  `npm run build` (web bundle, server, and crawler build cleanly)
- [x] **Whitespace / Git diff sanity:**
  `git diff --check` (clean, no whitespace warnings or blank lines at EOF)

---

## 2. Security and Credential Isolation

- [x] **Per-user key isolation:** OpenAIP API keys are strictly user-scoped via authenticated session. No global/shared database or environment OpenAIP fallback key exists.
- [x] **No credential leakage:** OpenAIP keys are sent only in server-side HTTP headers (`x-openaip-api-key`). They are never logged, never cached in URLs, never returned to browser clients, and never exposed in error responses.
- [x] **Input bounds validation:** Map extents, radii, and coordinates are strictly clamped and validated before making upstream calls.
- [x] **Redacted error handling:** Network failures or upstream error messages are sanitized and mapped to typed states (`not_configured`, `error`, `stale`) without leaking tokens.

---

## 3. Legal and Product Policy Guardrails

- [x] **Zero positive conclusion claims:** The application never generates "safe", "legal", "approved", "cleared", or "authorised" conclusions.
- [x] **Controlled-aerodrome conditional status:** The 3 NM controlled aerodrome buffer is strictly classified as `caution` with detailed explanation citing aircraft category, weight (including 250 g threshold), and applicable exemptions/permissions. It is never treated as a blanket restriction.
- [x] **Visible "Not checked" gates:** NOTAMs and non-fire emergency gates are permanently visible in assessment results with badge `No authoritative provider configured`. They are never hidden even if other criteria are clear.
- [x] **Modelled fire buffer:** The 2 km buffer around NSW RFS incidents is explicitly labelled as a PhotoScout safety policy heuristic under CASR 101.238(e), not an official statutory distance.
- [x] **Transparent population heuristic:** Populous context uses objective building footprints, major corridors, and event indicators for manual assessment cautions, never statutory legal determinations.
- [x] **Statutory disclaimer:** Exact required disclaimer is displayed prominently in the planning panel and popups:
  > *Planning guidance only. PhotoScout does not confirm that a flight is legal, authorised, or safe. The remote pilot is responsible for checking current airspace, NOTAMs, emergency operations, approvals, operating conditions, and all applicable laws.*

---

## 4. UI and User Experience Verification

- [x] **Layer isolation:** The Drone planning overlay and the NSW RFS Fire incident overlay are independently toggleable. Disabling Fire does not hide Drone fire-operation warning buffers.
- [x] **Ordered panel layout:** The planning panel strictly renders:
  1. Severity summary banner
  2. Mapped evidence & cautions
  3. Not checked gates
  4. Pilot responsibility checklist
  5. Sources, authority labels, freshness & attribution
  6. Statutory disclaimer
- [x] **Responsive mobile layout:** On mobile viewports (≤ 820px), `.drone-panel` is constrained to max-height 55vh, keeping top-right map navigation, locate, and home controls fully visible and accessible.
- [x] **Draggable planning point:** Dropping a pin allows dragging the drone planning point across the map with automatic context reassessment, or resetting to map centre.
- [x] **Map click popups:** Clicking airspaces, aerodromes, 3 NM buffers, or fire buffers opens formatted, sanitized HTML popups with full advisory context and rule citations.
