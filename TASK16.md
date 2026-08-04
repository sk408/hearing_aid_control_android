# TASK16: MFi scan speed fix (feature/mfi-control)

Work in: C:\Projects\hearing_aid_control_android on branch feature/mfi-control.

PROBLEM: src/ble/mfiSets.ts currently verifies unknown scan candidates by SEQUENTIALLY CONNECTING to each one (6s connect + 8s discovery timeouts, up to 10 devices) DURING the scan flow. Device enumeration is perceptibly slow. The user is unhappy with the delay.

DECISION (already made by the user — implement exactly this, do NOT propose alternatives):

1. FAST LIST — during scanning, a device appears in the list immediately when:
   (a) its advertised service UUIDs include the LEA service 7d74f4bd-c74a-4431-862c-cce884371592, OR
   (b) its device id is in the persisted verified-MFi set (AsyncStorage key of your choice, e.g. @mfi_verified) — a device id is added to this set after any successful LEA-service confirmation.
2. REMOVE the eager connect-verification stage from scanning entirely. Unknown candidates are never connected-to during the scan; they simply do not appear (list stays MFi-only).
3. LAZY SIBLING WINDOW — when the user taps a listed device: keep BLE scanning running in the background for 10 seconds while displaying a "looking for the other ear…" indicator. Use the existing grouping heuristics in mfiSets.ts to identify the sibling from scan results. If found: run the existing dual connect/bond set flow for both. If not found after 10s: proceed single-sided connect.
4. PIGGYBACK VERIFICATION ONLY — LEA-service verification happens only as part of an actual connect flow (set or single), never as a standalone probe. Successful verifications update the AsyncStorage set.

Then:
- npx tsc --noEmit must be clean
- cd android && gradlew.bat assembleRelease must succeed
- Append a TASK16 section to MFI_BRANCH_NOTES.md describing the change
- git add -A && git commit on feature/mfi-control with message: feat: fast-list scan + lazy sibling window (TASK16)
- Do NOT push

Start now. If you finish early phases quickly, proceed to the next without stopping.
