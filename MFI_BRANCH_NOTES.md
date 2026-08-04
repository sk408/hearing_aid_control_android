# MFI_BRANCH_NOTES — feature/mfi-control

Branch: `feature/mfi-control` (from `main` @ d6abce4)
Date: 2026-08-04
Task: TASK13 — MFi-only control branch. Universal adapter using ONLY the
standardized MFi/LEA control surface. No brand cores, no GN crypto, no
POLARIS, no ASHA.

## What was built

### New files
- `src/adapters/mfiAdapter.ts` — universal MFi/LEA adapter (imports no
  brand-core code).

### Additive edits (no brand adapter code paths touched)
- `src/ble/types.ts` — added `'mfi'` to the `Brand` union.
- `src/adapters/factory.ts` — `'mfi'` → `new MfiAdapter()`.
- `src/brand/detection.ts` — LEA service `7d74f4bd-c74a-4431-862c-cce884371592`
  detection added as the LAST check, so devices matching a brand-specific
  signature first (e.g. ReSound GN aids, which also expose LEA) keep their
  dedicated adapter. Only devices with no brand-specific match but with the
  LEA service get the MFi adapter.
- `src/screens/HomeScreen.tsx` / `src/screens/DeviceScreen.tsx` — label/color
  entries: "MFi (Universal)".
- `MFI_BRANCH_NOTES.md` — this file.

The 4 brand adapters (philips/rexton/starkey/resound) are byte-identical to
main on this branch.

## Implemented per spec (MFI_SPEC.md §4.1 minimum viable client)

| Feature | Status | Notes |
|---|---|---|
| Discovery | Implemented | LEA service UUID checked after connect + service discovery (spec §4.4: whether the 128-bit LEA UUID appears in adv is unconfirmed, so no scan filter) |
| Connect + bond | Implemented | Standard Android `createBond()` (Just Works / LESC) per spec §4.3; re-discovery after bonding |
| Service discovery + char cache | Implemented | All 8 required LEA characteristics addressed by UUID (handles are per-device discovered, per spec §4.7 #6) |
| Battery read | Implemented | LEABatteryLevel `24e1dff3-…-bf87`, 1 byte 0–100, + notify subscription |
| Available programs | Implemented | LEAAvailablePrograms 4-byte LE bitmask → fitted indices |
| Current program R/W | Implemented | LEACurrentActiveProgram; index validated against bitmask before write (firmware rejects invalid) |
| Program names | Implemented | Selector write → 60-byte UTF-8 name read; category char noted but not surfaced in UI |
| Volume (mic) set/read | Implemented | UI 0–100 ↔ GATT 1–255 linear map (128 ≈ mid, matches RC step 6); writes use Write Request for error codes |
| Streaming volume | Implemented | `setStreamingVolume()` → LEAStreamAttenuation (not yet exposed by the shared UI) |
| Notifications | Implemented | Subscribed: MicAttenuation, StreamAttenuation, CurrentActiveProgram, BatteryLevel — UI cache tracks hardware button presses |
| Mute | Implemented — EXPERIMENTAL | Emulated per spec §3.1: write 0, restore stored value (fallback 128) |
| Brand detection label | Implemented | "MFi hearing aid" + DIS 0x180A manufacturer name for display only — no brand logic |

## Deviations from spec / task

1. **No `build_app.bat` exists in the repo.** Built with
   `cd android && gradlew.bat assembleRelease` instead.
2. **Volume UI step count:** the shared `ControlPanel` slider is 0–100 with
   step 1 and is reused as-is (task: "reuse existing volume/program UI
   components; do not fork them"). The adapter maps linearly onto the full
   1–255 GATT range rather than quantizing to the 13-step RC table — spec
   §3.1 confirms GATT clients may write the full range and the RC table only
   quantizes the physical remote.
3. **Mute writes byte 0** (not min=1). Spec §3.1/§4.7 #4 leaves 0-vs-1
   treatment unconfirmed; labeled experimental. If testing shows 0 clamps or
   errors, switch to 1.
4. **MFi auth (verifier role) not implemented.** Spec §4.2 proves LEA control
   is not gated on MFi auth, and the task's minimum viable client omits it.
   The cert/challenge flow (§2) is documented but unnecessary for control.
5. **LEAProgramCategory is not surfaced in the UI** — the shared Program UI
   shows names only. The characteristic is read-capable in the adapter if
   needed later.

## What works (verified)

- `tsc --noEmit`: clean.
- Release APK build: see "Build" below.
- Existing 4 adapters untouched and present in the same build.

## What's untested (needs live device)

Everything BLE-facing. No hearing aid was available during this session.
Smoke-test checklist (ReSound Lacerta aids expose the LEA service — March
2026 scan confirmed ProgramName `7be94a55`):

1. Scan → connect a Lacerta aid → confirm brand shows "MFi (Universal)"
   (NOTE: if the aid matches the ReSound GN signature first it will use the
   ReSound adapter by design — to force the MFi path, test with an aid that
   exposes LEA but no GN/FEFE/e0262760 services, or temporarily bypass
   detection).
2. Bond completes silently (Just Works) or via system pairing UI.
3. Read battery % — matches aid state.
4. Read programs — names match fitting (e.g. "All-Around", "Restaurant").
5. Change program → aid switches; notification fires; `refreshState` agrees.
6. Set volume via slider → audible change; read-back matches.
7. Press hardware button on aid → app volume/program updates via notification.
8. Mute toggle (experimental) → aid silences and restores.
9. Write an invalid program index → adapter rejects locally before BLE write.
10. Streaming volume while streaming from an MFi streamer.

## Open questions

- Does firmware treat attenuation byte 0 as mute or clamp to 1? (spec §4.7 #4)
- ProgramCategory enum values and ProgramName charset/terminator on
  non-GN MFi aids (spec §4.7 #5).
- Do other vendors' MFi aids use these exact LEA UUIDs? (Spec is a GN
  Palpatine6 dump; UUIDs are the standardized MFi HA service set and should
  be stable, handles are not.)
- Pairing-window behavior: aid is bondable only in pairing windows
  (spec §4.3) — first-time users may need to open the battery door / long-press
  to enter pairing mode before `createBond()` succeeds.

## Build

- Command: `cd android && gradlew.bat assembleRelease`
- APK path: `android/app/build/outputs/apk/release/app-release.apk`
- Result: **BUILD SUCCESSFUL** (2026-08-04, 82,340,606 bytes) — compiles
  clean with all 5 adapters present. `tsc --noEmit` also clean.

## Commit

Single branch commit containing only the MFi additions listed above. Not
pushed (per task: push only if it builds clean).
