# Drone Planning Data Sources and Legal Authority Register

This document records the external datasets, statutory authorities, and regulatory guidance that inform PhotoScout's Drone Planning advisory overlay.

PhotoScout provides **planning guidance only**. It is not an aviation clearance system, flight authorization service, or legal compliance guarantor. The remote pilot remains entirely responsible for assessing operating conditions, airspace status, and applicable statutory requirements before flight.

---

## Source Register

| Source Title | Authority Class | Retrieval / Baseline Date | Scope & Use in PhotoScout | Limitations & Exclusions | Attribution & Terms |
|---|---|---|---|---|---|
| **Civil Aviation Safety Regulations 1998 (CASR) Part 101** | `legislation` | 2026-10-13 | Versioned baseline rules for standard RPA operations (Part 101 Subparts 101.A, 101.C, 101.F). Encoded in `server/src/drone/ruleCatalog.ts`. | Statutory text subject to amendment by Parliament/CASA. Must be reviewed prior to release via `reviewBy` dates. | Commonwealth of Australia / Federal Register of Legislation. |
| **CASA Drone Rules & Plain English Guides** | `regulator_guidance` | 2026-10-13 | Advisory guidance, definitions (e.g. populous area indicators, 30 m separation, micro RPA exceptions). Used for human-readable checklists and pilot prompts. | Regulatory guidance is not statutory law but informs compliance interpretations. | Civil Aviation Safety Authority (CASA). |
| **OpenAIP Core API** | `provider_context` | 2026-10-13 | Worldwide aeronautical data: airspace boundaries (prohibited, restricted, danger, CTR/CTA), aerodromes/airfields, runway alignments and radio frequencies when available. | Community and open aeronautical database. Not an authoritative Airservices Australia / AIP product. NOTAMs and dynamic tactical activations are **not** guaranteed current. Does not determine Australian flight legality. | OpenAIP (CC BY-NC-SA 4.0 or OpenAIP API terms). Requester-user credentials only; keys never logged or redistributed. |
| **NSW Rural Fire Service Major Incidents Feed** | `regulator_guidance` (public safety) | Dynamic (5 min cache) | Real-time incident polygons and point locations for active bushfires and emergency operations in NSW. Used to enforce CASR 101.238(e) emergency boundary caution. | Only covers NSW RFS incidents. Does not cover other state emergency services (SES, Police, Fire and Rescue NSW urban incidents, Ambulance NSW). Stale-on-error behavior requires explicit freshness warning. | State of New South Wales (NSW RFS) CC BY 4.0. |
| **PhotoScout Modelled Fire Buffer** | `product_policy` | Current codebase | Derives a 2 km advisory buffer around active RFS incidents as a conservative safety precaution to avoid interfering with aerial firefighting or emergency operations. | Product policy heuristic only. Not an official statutory exclusion boundary or NOTAM airspace restriction. | PhotoScout product design. |
| **OpenStreetMap & Built-up Context** | `provider_context` | Cached tiles / vectors | Heuristic spatial indicators for dense buildings, roads, gathering places to trigger `likely_populous` cautions. | Cannot conclusively determine statutory populous-area status under CASR 101.025. Pilot manual assessment always required. | OpenStreetMap contributors (ODbL). |
| **ADS-B Aircraft Feeds** | `provider_context` | Dynamic live | Real-time awareness of nearby manned aircraft activity in the vicinity of flight planning. | Incomplete coverage: aircraft without active ADS-B Out or operating below receiver horizons are not detected. Never used for clearance calculation. | Provider feed context. |
| **NOTAMs (Notice to Air Missions)** | `unknown` (Unintegrated) | Unintegrated | Official tactical airspace notices, temporary restricted areas, emergency airspace restrictions. | **Not checked in Phase 1.** PhotoScout does not currently connect to an authoritative Australian NOTAM provider. Marked explicitly as `Not checked`. | Requires future Airservices Australia / licensed provider integration. |
| **Non-Fire Emergency Operations** | `unknown` (Unintegrated) | Unintegrated | Police operations, search and rescue, disaster response not covered by NSW RFS. | **Not checked in Phase 1.** Remote pilot must check official state and local emergency alerts. | Not integrated. |

---

## Legal and Safety Policy Guardrails

1. **No Legal or Safety Verdicts:**
   The product must never declare a flight to be "legal", "safe", "approved", "cleared", or "authorised". The strongest positive outcome is:
   *`No mapped restriction found — pilot checks still required`*.
2. **User-Owned Credentials:**
   OpenAIP data is queried server-side using the signed-in user's API key stored securely in their account profile. No global key fallback exists. The key is never sent to the browser, logged, cached in request URLs, or exposed in errors.
3. **Freshness and Degraded States:**
   All data displays source attribution, fetch timestamp, and freshness status. Stale data must display a prominent stale/unknown warning and cannot be presented as current.
4. **Mandatory Pilot Responsibility Checklist:**
   Planning outputs always present a mandatory checklist of factors that cannot be automated:
   - Visual line of sight (VLOS)
   - Maximum height (<= 400 ft / 120 m AGL)
   - 30 m separation from people
   - Populous area assessment
   - Landowner access / launch permission
   - Weather / daylight conditions
   - Official NOTAM verification

---

## Geospatial Buffering Strategy and Limitations

1. **Implementation & Package:**
   Geospatial buffers are generated using `@turf/buffer` (v7.4.0 locked in `server/package.json`), which delegates to JSTS (Java Topology Suite port) for robust 2D topology operations and vertex offset curves.
2. **Units & Constants:**
   - **Controlled aerodrome buffer:** 3 Nautical Miles = 5,556 metres (`3 * 1852 m`). Only generated where `controlled === true` is positively verified in the provider dataset.
   - **Modelled fire-operation hazard buffer:** 2,000 metres (`2 km`). Sourced from `DRONE_FIRE_BUFFER_METRES` product policy constant.
3. **Supported Geometry Types:**
   - `Point`: Expands into a 32-segment circular polygon at the specified distance.
   - `Polygon` / `MultiPolygon`: Expands outward from polygon boundaries by the exact distance.
   - `GeometryCollection`: Buffers each component geometry and preserves collection topology.
4. **Limitations & Operational Assumptions:**
   - Local projection approximations used by Turf/JSTS produce negligible error (< 0.1%) over short distances (2 km to 5.5 km) at Australian latitudes (-10° to -45° S).
   - The 2 km fire buffer is explicitly a **modelled product-policy safety margin** to prevent conflicts with aerial firefighting operations under CASR 101.238(e); it is **not** an official or legally defined distance.
