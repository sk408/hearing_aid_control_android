# MFI_BRANCH_NOTES — feature/mfi-control

Branch: `feature/mfi-control` (from `main` @ d6abce4)
Date: 2026-08-04
Tasks: TASK13 — MFi-only control branch. TASK14 — MFi adapter polish:
MFi-only device filter + auto-pairing of binaural sets.
TASK15 — detection priority flip: MFi claims all LEA-capable devices.

---

## TASK15 — detection priority flip (2026-08-04, third session)

### What changed
- `src/brand/detection.ts` — the LEA service check
  (`7d74f4bd-c74a-4431-862c-cce884371592`) moved from LAST to FIRST in
  `detectBrandFromDiscovery()`. Any device exposing the LEA service now
  gets the MFi adapter; brand-specific signatures (Starkey, ReSound
  e0262760/FEFE+GN, Philips, POLARIS) are only evaluated for devices that
  do NOT expose LEA.

### Rationale
- This branch is a universal-MFi remote. Before TASK15, ReSound GN aids —
  which expose both the GN proprietary services AND the standardized LEA
  service — matched the ReSound signature first and got the ReSound
  adapter, bypassing the MFi control surface this branch exists to
  exercise. TASK13/14's MFi-only UI filter already hides non-LEA devices,
  so brand adapters are unreachable in the UI anyway; flipping detection
  priority makes the connect path consistent with the filter.
- Scope: branch-only experiment. A comment in detection.ts notes that
  consolidation with `main` (where LEA must stay LAST so brand adapters
  win) comes later — do NOT cherry-pick this flip to main as-is.

### Effect on each device family
- ReSound GN aids (LEA + GN services): now → MFi adapter (was ReSound).
- Any other MFi aid exposing LEA + a brand signature: now → MFi adapter.
- Devices without the LEA service: unchanged — brand detection as before,
  and they remain hidden by the TASK14 MFi-only UI filter.

### Verification
- `tsc --noEmit`: clean.
- Release APK rebuilt (`cd android && gradlew.bat assembleRelease`): see
  "Build" section.

### Untested (needs live device)
1. ReSound Vivia/Lacerta aids now connect via the MFi adapter end-to-end
   (bond → LEA verify → battery/program/volume) instead of the ReSound
   adapter.
2. No regression for the TASK14 binaural set flow (grouping + connectMfiSet
   were already adapter-agnostic, but confirm the set entries still form).

---

## TASK14 — what changed (2026-08-04, second session)

Two user-requested improvements after the TASK13 live test PASSED on
ReSound aids. All changes are MFi-adapter-scoped; the 4 brand adapters
remain byte-identical to main.

### New files
- `src/ble/mfiSets.ts` — two-stage MFi device filter + brand-agnostic
  binaural set grouping.

### Edited files
- `src/ble/types.ts` — additive: `setMemberIds` / `memberSides` /
  `memberNames` on `DiscoveredDevice`.
- `src/adapters/types.ts` — additive: `batteryPercentSecondary` on
  `DriverState`.
- `src/adapters/mfiAdapter.ts` — dual GATT connections (binaural sets).
- `src/screens/HomeScreen.tsx` — MFi-only device list, two-stage
  verification, set list entries, shared-adapter disconnect handling.
- `src/screens/DeviceScreen.tsx` — set connect flow (`connectMfiSet`),
  `connecting_set` / `slot_conflict` UI states.
- `src/screens/ControlPanel.tsx` — deduped shared adapter (one write per
  linked control), per-ear volume sliders in unlinked mode, set-aware
  refresh.

### 1. MFi-only device filter (two-stage)

MFI_SPEC.md §4.4: whether the 128-bit LEA UUID appears in adv or scan
response is UNCONFIRMED, so a pure adv filter would be unreliable.
Implementation:

- **Stage 1 (adv):** scanned devices whose advertised service UUIDs include
  the LEA service appear in the list immediately.
- **Stage 2 (verify):** all other scan results (and OS-bonded BLE devices)
  are collected as candidates. After the scan stops, each candidate is
  briefly connected (6 s connect timeout, 8 s discovery timeout), services
  are discovered, and only devices exposing the LEA service are added to
  the list. Non-matches never appear. Verdicts are cached for the app
  session; verification is sequential, RSSI-sorted, capped at 10 devices
  per scan, and never touches an already-connected device.
- The device list is now MFi-only on this branch. Brand adapters are still
  compiled in, but non-MFi devices are filtered out of the UI (the branch
  is a universal-MFi remote; brand-specific control stays on `main`).

### 2. Binaural set auto-pairing

- **Grouping heuristics** (brand-agnostic, in `buildMfiSetEntries`):
  1. Normalize device name, stripping a trailing side marker
     (` L`/` R`, `-L`, `_R`, `(L)`, `Left`, `LE`/`RE`, etc.).
  2. Group by normalized base name (min 2 chars; nameless devices stay
     single).
  3. Pair within a group: explicit L+R side match scores highest; RSSI
     delta ≤ 15 dB required otherwise; matching MAC OUI prefix is a weak
     corroborator. Two members with the SAME explicit side are never paired.
- **Primary selection:** the RIGHT member when sides are known (ear-to-ear
  convention), otherwise the stronger-RSSI member. The set list entry's id
  is the primary's id; name shows as "<Base> L+R" with an "L+R" badge.
- **Connect:** tapping a set runs `connectMfiSet` → one `MfiAdapter`
  bonds + connects BOTH aids (`connectSet(primary, secondary, side)`),
  reusing the same connect/bond/discover/LEA-verify path per aid. If the
  secondary fails (off / out of range), the adapter continues single-sided
  with the primary — no error. If side info was missing from names, the
  HAP side characteristic `8d17ac2f` is read opportunistically (generic,
  guarded — not brand logic).
- **Slots/UI:** the ONE shared adapter instance is assigned to BOTH ear
  slots, each with its own aid's battery via `refreshSetState()` →
  `DriverState.batteryPercent` (per-ear) / `batteryPercentSecondary`.
  Result: two battery indicators (existing slot cards + ControlPanel
  battery rows), one linked volume/program control surface.
- **Write policy (configurable):** binaural aids sync volume/program
  between ears over their own ear-to-ear link, so by default
  `adapter.writeToBoth = false` and volume/mute/program writes go to the
  PRIMARY aid only; the secondary is observed via notifications (its
  attenuation/program notifications confirm the sync and update the shared
  cache). Set `writeToBoth = true` for sets that don't sync between ears.
- **Per-ear writes:** in unlinked mode the left/right sliders call
  `setVolume(level, 'left'|'right')`, which the MFi adapter routes to the
  specific aid. Brand adapters ignore the `ear` param (one aid per
  adapter), so the shared ControlPanel change is safe for them.
- **Disconnect robustness:** tearing down a slot whose adapter is shared
  with the peer slot (MFi set) clears both slots. `ControlPanel` dedupes
  adapter instances so linked volume/mute/program write exactly once.
- **Slot conflict:** if a set is tapped while other devices occupy the
  slots, the UI offers "Replace & Connect Pair" (disconnects existing
  slots, then connects the set).

### TASK14 — untested (needs live binaural set)

1. Two-stage filter on real hardware: does the LEA UUID appear in adv
   (stage 1 fast path), or do aids only surface via stage-2 verification?
   How long does verification take in a busy BLE environment?
2. Set grouping on the ReSound Vivia pair: do the aids' advertised names
   differ only by an L/R marker the normalizer strips? If both aids share
   ONE identical name, grouping relies on base-name + RSSI + OUI and both
   will pair — verify no false pairing with a neighbor's aids (same model
   name, similar RSSI is possible in a clinic).
3. `connectSet`: both bonds complete (two Just Works prompts?); secondary
   connect during the aids' pairing window (both aids may need to be in
   pairing mode simultaneously on first bond).
4. Ear-to-ear sync assumption: volume/program written to primary only —
   confirm the secondary follows (watch its notifications in the log) on
   Vivia. If not, set `adapter.writeToBoth = true`.
5. Side detection: name-based L/R vs `8d17ac2f` read — confirm final slot
   assignment matches physical ears.
6. Per-ear (unlinked) volume writes routed to the correct aid.
7. Single-sided graceful operation: set entry tapped with only one aid
   powered → connects primary, right slot stays empty.
8. Battery from BOTH aids displayed and updating via notifications.

### TASK14 — known limitations

- Stage-2 verification briefly connects to nearby non-HA BLE devices
  (headphones, trackers). No pairing is triggered (service discovery only),
  and weak-signal (< -85 dBm) devices are skipped, but in a crowded
  environment verification adds latency after each scan.
- Verdict cache is session-only; a device rejected while powered off will
  be re-verified next app start.
- If two aids of a set advertise identical names AND a third same-model
  aid is nearby with similar RSSI, mis-pairing is theoretically possible;
  the RSSI delta + OUI checks mitigate but don't eliminate this.

---

## TASK13 — original notes

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

- Command: `cd android && gradlew.bat assembleRelease` (`build_app.bat`
  does not exist in the repo)
- APK path: `android/app/build/outputs/apk/release/app-release.apk`
- TASK16 rebuild: **BUILD SUCCESSFUL** (2026-08-04, 82,364,946 bytes) —
  `tsc --noEmit` clean; fast-list scan + lazy sibling window.
- TASK14 rebuild: **BUILD SUCCESSFUL** (2026-08-04, 82,366,442 bytes) —
  `tsc --noEmit` clean; all 5 adapters still present, brand adapters
  byte-identical to main.
- TASK13 build: BUILD SUCCESSFUL (2026-08-04, 82,340,606 bytes).

## Commit

Single branch commit containing only the MFi additions listed above. Not
pushed (per task: push only if it builds clean).

---

# TASK16 — Fast-list scan + lazy sibling window (2026-08-04)

## Problem

TASK14 verified unknown scan candidates by SEQUENTIALLY CONNECTING to each
one during the scan flow (6s connect + 8s discovery timeouts, up to 10
devices). Device enumeration was perceptibly slow.

## Change

1. **Fast list** — during scanning a device now appears in the list
   immediately when (a) its advertised service UUIDs include the LEA service
   `7d74f4bd-…`, or (b) its device id is in the persisted verified-MFi set
   (AsyncStorage key `@mfi_verified`). Ids are added to that set after any
   successful LEA-service confirmation during a real connect flow.
2. **Eager connect-verification removed** — the stage-2 probe
   (`verifyMfiDevice`, `isVerificationCandidate`,
   `MAX_VERIFICATIONS_PER_SCAN`, verdict cache) is gone from `mfiSets.ts` and
   `HomeScreen.tsx`. Unknown candidates are never connected-to during scan;
   they simply do not appear (list stays MFi-only).
3. **Lazy sibling window** — tapping a listed single device keeps BLE
   scanning running in the background for 10s with a "Looking for the other
   ear…" indicator. Scan results (including pre-tap results held in
   `allScannedRef`) are matched with the existing grouping heuristics via the
   new `findSetSibling()` in `mfiSets.ts`. Sibling found → merged set entry →
   existing dual connect/bond set flow in `DeviceScreen`. No sibling after
   10s → single-sided connect. Already-grouped "L+R" set entries still
   navigate straight into the dual flow with no window.
4. **Piggyback verification only** — LEA-service confirmation now happens
   exclusively inside real connect flows (`piggybackVerifyLea` in
   `DeviceScreen.tsx`, called after single-device service discovery and after
   `MfiAdapter.connectSet` for both set members). Successful confirmations
   call `markVerifiedMfi()`, which updates the session cache and persists to
   AsyncStorage. No standalone probes remain.

## Files touched

- `src/ble/mfiSets.ts` — stage-2 verification deleted; added
  `initVerifiedMfiSet` / `isVerifiedMfi` / `markVerifiedMfi` (AsyncStorage
  `@mfi_verified`) and `findSetSibling`.
- `src/screens/HomeScreen.tsx` — fast-list scan callback, sibling-window
  state machine + indicator, bonded devices shown only when verified.
- `src/screens/DeviceScreen.tsx` — `piggybackVerifyLea` on both connect
  paths.

## Verification

- `npx tsc --noEmit`: clean.
- `cd android && gradlew.bat assembleRelease`: see Build section above
  (TASK16 rebuild recorded there).

