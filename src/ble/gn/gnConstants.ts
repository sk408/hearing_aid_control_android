/**
 * GN BLE constants — mirrored from GNConstants.cs (BLE.dll, Smart 3D 1.3.0 ILSpy decompile).
 *
 * Source: artifacts/decompiled/resound_smart3d_1.3.0_ble/BLE/GNConstants.cs
 * Reference: docs/resound_gn_encryption_1.3.0_ilspy.md §1
 */

// ── Services ──

/** Primary GN proprietary service (Smart 3D 1.3.0, legacy Smart 3.3.1) */
export const GN_FEFE_SERVICE = '0000fefe-0000-1000-8000-00805f9b34fb';

/** GN Palpatine 5 service — secondary GN service */
export const GN_PALPATINE_SERVICE = '4d56d4f5-af39-4885-9525-9f68c18ff451';

/** e0262760 family — appears on newer stacks (Smart 3D 1.43.1+) */
export const GN_E026_SERVICE = 'e0262760-08c2-11e1-9073-0e8ac72ea010';

/** DFU service — used during firmware update mode */
export const GN_DFU_SERVICE = '213885c7-488a-412c-ba95-e36436b88c42';

// ── Command / Notify characteristics (under FEFE or DFU service) ──

/** GN command writes — handle-multiplexed protocol */
export const GN_COMMAND_CHAR = '1959a468-3234-4c18-9e78-8daf8d9dbf61';

/** GN notify responses / events */
export const GN_NOTIFY_CHAR = '8b51a2ca-5bed-418b-b54b-22fe666aadd2';

/** DFU command writes */
export const GN_DFU_COMMAND_CHAR = 'b69669b0-effb-4568-9862-7d82f3391170';

/** DFU notify responses */
export const GN_DFU_NOTIFY_CHAR = '1bcd1f06-1e72-4dad-8edb-8bfaeb4fe812';

/** DFU version */
export const GN_DFU_VERSION_CHAR = '53df4e1c-43e1-497e-8edf-589f48aafd9a';

/** DFU security capability */
export const GN_DFU_SECURITY_CAP_CHAR = 'deb1c8c1-ec5e-42d3-9d0f-4d108a3c612c';

/** DFU trusted-app challenge */
export const GN_DFU_TRUSTED_APP_CHALLENGE_CHAR = '6eae2d11-57a1-43bf-be4a-6326d0d94e88';

/** DFU firmware image write */
export const GN_DFU_FLASH_WRT_CHAR = '7009c09b-b94f-42d4-8d68-676059f153ab';

/** DFU certificate write */
export const GN_DFU_CERTIFICATE_WRT_CHAR = 'c853ac0b-2175-4d1d-8396-8f866d1ba821';

/** DFU MTU */
export const GN_DFU_MTU_CHAR = 'de1e1fd9-6056-4d89-8c49-5c3907ab694f';

// ── Security / trust characteristics ──

/** GN version — read to get protocol version */
export const GN_VERSION_CHAR = '97c1c193-ea53-4312-9bd9-e52207d5e03d';

/** Security capability — read version + index; write [4,0,0,0,0] for trust bootstrap */
export const GN_SECURITY_CAP_CHAR = '12257119-ddcb-4a12-9a08-1cd4df7921bb';

/** Trusted-app challenge — read challenge bytes, write auth response */
export const GN_TRUSTED_APP_CHALLENGE_CHAR = 'add69bfc-edc7-40a4-ba5e-5f0107c3b3ac';

/** HI ECDH public key — read the hearing instrument's P-256 public key */
export const GN_HI_PUBLIC_KEY_CHAR = '98e3949e-d4dd-421c-87b2-5a5ddc1ac26f';

/** Passcode attempts left — read remaining passcode attempts */
export const GN_PASSCODE_ATTEMPTS_CHAR = '6d27fe99-0bfc-4c5e-9a3f-a4a271bb3d2a';

// ── Direct-write characteristics (under FEFE / P5 service) ──

/** Microphone / HA gain attenuation — 0=mute, 1..255 */
export const GN_MIC_ATTENUATION_CHAR = '32c9322d-6b17-11cf-0234-6f0da5eafd75';

/** Streaming attenuation — 0=mute, 1..255 */
export const GN_STREAM_ATTENUATION_CHAR = '054e99c7-ff34-1c12-59cd-e2c20d2e6743';

/** Current active program index */
export const GN_ACTIVE_PROGRAM_CHAR = 'dc82f820-63ac-f82f-1e89-372fde4151f4';

/** HI state */
export const GN_HI_STATE_CHAR = '8d552f91-15d0-4628-a03f-1a64fc88fa51';

/** Feature support — 4-byte bitfield */
export const GN_FEATURE_SUPPORT_CHAR = '650c3a00-cb6d-467d-a20b-3544f189d8af';

/** GN battery enum: 1=low(5%), 5=prev_low(30%), 10=OK(100%) */
export const GN_BATTERY_CHAR = '86e2c601-d90a-2628-19b9-bdb38d5c7cf0';

/** GN battery level (from GNConstants.cs — different from the direct-read battery above) */
export const GN_BATTERY_LEVEL_CHAR = '24e1dff3-ae90-41bf-bfbd-2cf8df42bf87';

/** Client Characteristic Configuration Descriptor */
export const GN_CC_DESCRIPTOR = '00002902-0000-1000-8000-00805f9b34fb';

/** Ear side — 0=left, 1=right */
export const GN_SIDE_CHAR = '8d17ac2f-1d54-4742-a49a-ef4b20784eb3';

/** Melody UUID — from legacy Java client */
export const GN_MELODY_CHAR = '23e2faf2-2e54-4e53-b2e7-87c9a02c21c1';

// ── Handle IDs (GN command tunnel) ──

export const GN_HANDLE_MIC_ATTENUATION = 0x05;
export const GN_HANDLE_STREAM_ATTENUATION = 0x06;
export const GN_HANDLE_ACTIVE_PROGRAM = 0x08;
export const GN_HANDLE_STREAM_STATUS = 0x15;

// ── GN notify opcodes (HandleBasedPlatform.Notification) ──

export const GN_OPCODE_BOND_ACK = 0x01;
export const GN_OPCODE_NOTIFICATION_VECTOR = 0x02;
export const GN_OPCODE_READ_OUT = 0x03;
export const GN_OPCODE_NOTIFICATION_PAYLOAD = 0x04;
export const GN_OPCODE_BLOB = 0x05;
export const GN_OPCODE_DISCOVER = 0x06;
export const GN_OPCODE_DISCOVER_END = 0x07;
export const GN_OPCODE_ERROR = 0x08;

// ── Auth constants ──

/** App sends this (encrypted) during bond handshake — note trailing space */
export const AUTH_APP_SAYS_HI = 'APP says hi ';

/** Device response must decrypt to this to confirm trust */
export const AUTH_HI_SAYS_HI = 'HI says hi';

// ── Bond connect types (GenerateAuth appConnectType parameter) ──

export const BOND_TYPE_BOOT_STAGE1 = 1;
export const BOND_TYPE_BOOT_STAGE2 = 2;
export const BOND_TYPE_PASSCODE = 3;
export const BOND_TYPE_RECONNECT = 4;
export const BOND_TYPE_DFU = 5;
