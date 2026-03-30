/**
 * GN AES session cipher — port of BLE.HI.AESDeEncoder from Smart 3D 1.3.0.
 *
 * Source: artifacts/decompiled/resound_smart3d_1.3.0_ble/BLE/HI/AESDeEncoder.cs
 * Reference: docs/resound_gn_encryption_1.3.0_ilspy.md §2
 *
 * Algorithm: custom CTR-like keystream (not standard AES-CTR).
 *   1. AES-ECB encrypt the counter block to produce keystream.
 *   2. XOR plaintext with keystream.
 *   3. IncrementCounter after each 16-byte block (carry stops at index 11).
 *
 * Key material layout (SetKeys):
 *   encryptKey[0..15]  = outgoing AES key
 *   encryptKey[16..31] = outgoing counter seed
 *   decryptKey[0..15]  = incoming AES key
 *   decryptKey[16..31] = incoming counter seed
 *   After copy, counter bytes [12..15] are reset to [0,0,0,1].
 *
 * NOTE: react-native-quick-crypto must be installed for AES operations.
 * Run `npm install react-native-quick-crypto` if not already installed.
 */

// react-native-quick-crypto provides Node.js-compatible crypto API
import Crypto from 'react-native-quick-crypto';

/** Passthrough encoder — identity transform for unencrypted sessions */
export class PassthroughDeEncoder {
  encrypt(data: Uint8Array): Uint8Array {
    return data;
  }

  decrypt(data: Uint8Array): Uint8Array {
    return data;
  }
}

/** AES counter-mode session encoder from GN protocol */
export class AESDeEncoder {
  private encryptKey: Uint8Array = new Uint8Array(16);
  private encryptCounter: Uint8Array = new Uint8Array(16);
  private decryptKey: Uint8Array = new Uint8Array(16);
  private decryptCounter: Uint8Array = new Uint8Array(16);

  /**
   * Set session keys from P6TrustKeyHandler.GenerateKeys output.
   *
   * @param decryptKey 32 bytes: [0..15]=AES key, [16..31]=counter seed (hiSession)
   * @param encryptKey 32 bytes: [0..15]=AES key, [16..31]=counter seed (appSession)
   * @param resetCounters If true (default), reset counter bytes [12..15] to [0,0,0,1]
   */
  setKeys(decryptKey: Uint8Array, encryptKey: Uint8Array, resetCounters = true): void {
    if (decryptKey.length < 32 || encryptKey.length < 32) {
      throw new Error('AESDeEncoder.setKeys: keys must be 32 bytes each');
    }

    this.encryptKey = encryptKey.slice(0, 16);
    this.encryptCounter = encryptKey.slice(16, 32);
    this.decryptKey = decryptKey.slice(0, 16);
    this.decryptCounter = decryptKey.slice(16, 32);

    if (resetCounters) {
      // Reset bytes [12..15] to [0,0,0,1] — counter starts at 1
      this.encryptCounter[12] = 0;
      this.encryptCounter[13] = 0;
      this.encryptCounter[14] = 0;
      this.encryptCounter[15] = 1;
      this.decryptCounter[12] = 0;
      this.decryptCounter[13] = 0;
      this.decryptCounter[14] = 0;
      this.decryptCounter[15] = 1;
    }
  }

  /** Encrypt outgoing data (app → HI) */
  encrypt(data: Uint8Array): Uint8Array {
    const result = this.cryptDecrypt(data, this.encryptKey, this.encryptCounter);
    return result;
  }

  /** Decrypt incoming data (HI → app) */
  decrypt(data: Uint8Array): Uint8Array {
    const result = this.cryptDecrypt(data, this.decryptKey, this.decryptCounter);
    return result;
  }

  /**
   * Core cipher: generate AES-ECB keystream from counter blocks, XOR with data.
   * Counter is mutated in place (incremented after each 16-byte block).
   *
   * From AESDeEncoder.CryptDecrypt in decompiled C#.
   */
  private cryptDecrypt(
    data: Uint8Array,
    key: Uint8Array,
    counter: Uint8Array,
  ): Uint8Array {
    if (data.length === 0) return new Uint8Array(0);

    // Number of 16-byte blocks needed for keystream
    const numBlocks = Math.ceil(data.length / 16);

    // Generate keystream: AES-ECB encrypt each counter block
    const keystream = new Uint8Array(numBlocks * 16);
    for (let i = 0; i < numBlocks; i++) {
      const block = aesEcbEncryptBlock(key, counter);
      keystream.set(block, i * 16);
      incrementCounter(counter);
    }

    // XOR data with keystream (only data.length bytes)
    const result = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      result[i] = data[i] ^ keystream[i];
    }

    return result;
  }
}

/**
 * AES-ECB encrypt a single 16-byte block.
 * Uses react-native-quick-crypto's createCipheriv with ECB mode.
 */
function aesEcbEncryptBlock(key: Uint8Array, block: Uint8Array): Uint8Array {
  // ECB mode doesn't use an IV, pass empty buffer
  const cipher = Crypto.createCipheriv(
    'aes-128-ecb',
    key,
    null,
  );
  cipher.setAutoPadding(false);
  const encrypted = cipher.update(block);
  cipher.final(); // ECB with exact block size produces no extra output
  return new Uint8Array(encrypted);
}

/**
 * Increment the 16-byte counter (little-endian from byte 15, carry stops at byte 11).
 *
 * From AESDeEncoder.IncrementCounter: increments from the least significant byte (index 15),
 * carrying leftward but stopping at index 11 (throws if byte 11 would wrap).
 * Only bytes [11..15] participate in the counter evolution.
 */
function incrementCounter(counter: Uint8Array): void {
  for (let i = 15; i >= 11; i--) {
    counter[i]++;
    if (counter[i] !== 0) return; // no carry needed
    // Byte wrapped to 0 — carry to next position
    if (i === 11) {
      throw new Error(
        'AESDeEncoder: counter overflow at byte 11 — session counter exhausted',
      );
    }
  }
}

// ── Hard-coded app base keys ──
//
// From AESDeEncoder.cs — GetAppBaseKey(version, index):
//   version == 1 → AppBaseKeys[index]
//   else         → AppBaseKeys_2[index]
// 1.3.0 defines one row each (index 0).
//
// These are shared secrets embedded in the APK. They mix with per-device
// challenge + ECDH to derive session keys. Treat as obfuscation, not
// user-isolated secrecy (see ILSpy doc §5.1).
//
/** AppBaseKeys — version 1 base key (32 bytes, one row). From decompiled AESDeEncoder.cs. */
export const APP_BASE_KEYS: Uint8Array[] = [
  new Uint8Array([
    213, 232, 229, 12, 62, 139, 100, 133, 134, 38, 234, 67, 247, 36, 122, 230,
    214, 101, 61, 219, 62, 136, 213, 87, 193, 137, 138, 229, 45, 246, 104, 147,
  ]),
];

/** AppBaseKeys_2 — version != 1 base key (32 bytes, one row). From decompiled AESDeEncoder.cs. */
export const APP_BASE_KEYS_2: Uint8Array[] = [
  new Uint8Array([
    84, 104, 169, 138, 255, 144, 217, 85, 196, 139, 127, 31, 152, 23, 15, 83,
    233, 81, 198, 225, 126, 85, 162, 208, 91, 209, 139, 126, 65, 86, 47, 100,
  ]),
];

/**
 * Get the app base key for the given protocol version and key index.
 * From AESDeEncoder.GetAppBaseKey.
 */
export function getAppBaseKey(version: number, index: number): Uint8Array {
  const keys = version === 1 ? APP_BASE_KEYS : APP_BASE_KEYS_2;
  if (index < 0 || index >= keys.length) {
    throw new Error(`AESDeEncoder: invalid key index ${index} for version ${version}`);
  }
  return keys[index];
}
