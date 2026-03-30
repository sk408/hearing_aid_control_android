/**
 * P6 Trust Key Handler — port of BLE.HI.P6TrustKeyHandler from Smart 3D 1.3.0.
 *
 * Source: artifacts/decompiled/resound_smart3d_1.3.0_ble/BLE/HI/P6TrustKeyHandler.cs
 * Reference: docs/resound_gn_encryption_1.3.0_ilspy.md §3
 *
 * Derives AES session keys from:
 *   - Device challenge bytes (read from GNTrustedAppChallenge)
 *   - Hard-coded AppBaseKeys (embedded in APK)
 *   - Ephemeral ECDH P-256 key exchange
 *   - Optional passcode
 *
 * Flow:
 *   1. UpdateChallenge(challenge, version, index) → hikey → commonSecret
 *   2. SetHIPublicKey(hiPublicKeyBytes)           → ECDH → commonSecret updated
 *   3. [Optional] SetPasscode(hiid, passcode)     → commonSecret updated
 *   4. GenerateKeys(encoder)                      → appSession, hiSession, sharedAppKey
 *   5. GenerateAuth(connectType, sharedAppIndex)  → auth bytes for GNTrustedAppChallenge
 *
 * NOTE: react-native-quick-crypto must be installed.
 */

import Crypto from 'react-native-quick-crypto';
import { AESDeEncoder, getAppBaseKey } from './aesDeEncoder';
import { AUTH_APP_SAYS_HI } from './gnConstants';

/** SHA-256 hash of concatenated buffers */
function sha256(...parts: Uint8Array[]): Uint8Array {
  const hash = Crypto.createHash('sha256');
  for (const part of parts) {
    hash.update(part);
  }
  return new Uint8Array(hash.digest());
}

/** Convert a string to UTF-8 bytes (manual — avoids TextEncoder dependency) */
function utf8Bytes(str: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
      const next = str.charCodeAt(++i);
      c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
      bytes.push(
        0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f),
      );
    } else {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

export class P6TrustKeyHandler {
  /** Accumulated secret — built up through the trust flow stages */
  private commonSecret: Uint8Array = new Uint8Array(0);

  /** App ephemeral ECDH key pair (secp256r1 / P-256) */
  private appPrivateKey: Uint8Array | null = null;
  private appPublicKey: Uint8Array | null = null;

  /** Shared app key — derived during GenerateKeys, persisted for reconnect */
  private sharedAppKey: Uint8Array = new Uint8Array(0);

  /**
   * Stage 1: Process the challenge from GNTrustedAppChallenge read.
   *
   * challenge layout:
   *   [0..19]  = HIID (20 bytes)
   *   [20..35] = random/secret (16 bytes, mixed into commonSecret)
   *   [36..]   = BT address etc.
   *
   * From P6TrustKeyHandler.UpdateChallenge:
   *   version == 1: hikey = SHA256(challenge[0:20] || appBaseKey)
   *   else:         hikey = SHA256(appBaseKey || challenge[0:20])
   *   commonSecret = SHA256(hikey || challenge[20:36])
   */
  updateChallenge(challenge: Uint8Array, version: number, index: number): void {
    const appBaseKey = getAppBaseKey(version, index);
    const hiidPart = challenge.slice(0, 20);
    const secretPart = challenge.slice(20, 36);

    let hikey: Uint8Array;
    if (version === 1) {
      hikey = sha256(hiidPart, appBaseKey);
    } else {
      hikey = sha256(appBaseKey, hiidPart);
    }

    this.commonSecret = sha256(hikey, secretPart);
  }

  /**
   * Stage 2: ECDH key exchange with the hearing instrument's public key.
   *
   * From P6TrustKeyHandler.SetHIPublicKey:
   *   1. Generate ephemeral EC key pair on secp256r1.
   *   2. ECDH shared secret = computeSharedSecret(appPrivate, hiPublicKey).
   *   3. commonSecret = SHA256(commonSecret || dhkey).
   */
  setHIPublicKey(hiPublicKeyBytes: Uint8Array): void {
    // Generate ephemeral P-256 key pair
    const ecdh = Crypto.createECDH('prime256v1');
    ecdh.generateKeys();

    this.appPrivateKey = new Uint8Array(ecdh.getPrivateKey());
    // Full uncompressed public key (0x04 || X || Y) — 65 bytes
    this.appPublicKey = new Uint8Array(ecdh.getPublicKey());

    // Compute ECDH shared secret
    const dhkey = new Uint8Array(ecdh.computeSecret(hiPublicKeyBytes));

    // Mix into common secret
    this.commonSecret = sha256(this.commonSecret, dhkey);
  }

  /**
   * Stage 2b (optional): Mix passcode into common secret.
   *
   * From P6TrustKeyHandler.SetPasscode:
   *   passHash = SHA256(hiid || UTF8(passcode))
   *   commonSecret = SHA256(commonSecret || passHash)
   *
   * @param hiid First 20 bytes of the challenge (the HIID)
   * @param passcode User-entered passcode string
   */
  setPasscode(hiid: Uint8Array, passcode: string): void {
    const passHash = sha256(hiid, utf8Bytes(passcode));
    this.commonSecret = sha256(this.commonSecret, passHash);
  }

  /**
   * Stage 2c (reconnect): Mix stored shared app key into common secret.
   *
   * From P6TrustKeyHandler.SetSharedAppKey:
   *   commonSecret = SHA256(commonSecret || sharedAppKey[0:16])
   * Then caller re-runs GenerateKeys.
   */
  setSharedAppKey(storedSharedAppKey: Uint8Array): void {
    this.commonSecret = sha256(this.commonSecret, storedSharedAppKey.slice(0, 16));
  }

  /**
   * Stage 3: Derive session keys and configure the encoder.
   *
   * From P6TrustKeyHandler.GenerateKeys:
   *   appSession  = SHA256(commonSecret || UTF8("appsession"))     — 32 bytes
   *   hiSession   = SHA256(commonSecret || UTF8("hisession "))     — note trailing space
   *   sharedAppKey = SHA256(commonSecret || UTF8("appSharedBaseKey"))
   *   encoder.SetKeys(hiSession, appSession)
   *
   * Outgoing encrypt uses appSession; incoming decrypt uses hiSession.
   */
  generateKeys(encoder: AESDeEncoder): void {
    const appSession = sha256(this.commonSecret, utf8Bytes('appsession'));
    const hiSession = sha256(this.commonSecret, utf8Bytes('hisession ')); // trailing space!
    this.sharedAppKey = sha256(this.commonSecret, utf8Bytes('appSharedBaseKey'));

    encoder.setKeys(hiSession, appSession);
  }

  /**
   * Stage 4: Build the auth payload to write to GNTrustedAppChallenge.
   *
   * From P6TrustKeyHandler.GenerateAuth / HandleBasedPlatform.RespondeWithAuth:
   *   encrypted = encoder.Encrypt(UTF8("APP says hi "))  — note trailing space
   *   prefix    = [0, 0, 4, 0, appConnectType, sharedAppIndex]
   *   suffix    = appPublicKey[1..]                       — skip 0x04 prefix byte
   *   result    = prefix || encrypted || suffix
   *
   * Written to GNTrustedAppChallenge; response on GNNotify decrypted and
   * checked for "HI says hi".
   *
   * @param encoder The AES encoder (after GenerateKeys)
   * @param appConnectType Bond type: 1=boot1, 2=boot2, 3=passcode, 4=reconnect, 5=DFU
   * @param sharedAppIndex Index from security capability or stored bond
   */
  generateAuth(
    encoder: AESDeEncoder,
    appConnectType: number,
    sharedAppIndex: number,
  ): Uint8Array {
    // Encrypt the auth string
    const authPlaintext = utf8Bytes(AUTH_APP_SAYS_HI);
    const encrypted = encoder.encrypt(authPlaintext);

    // Build prefix
    const prefix = new Uint8Array([0, 0, 4, 0, appConnectType, sharedAppIndex]);

    // App public key without the 0x04 uncompressed prefix byte
    const pubKeyBytes = this.appPublicKey
      ? this.appPublicKey.slice(1)
      : new Uint8Array(0);

    // Concatenate: prefix || encrypted || pubKeyBytes
    const result = new Uint8Array(prefix.length + encrypted.length + pubKeyBytes.length);
    result.set(prefix, 0);
    result.set(encrypted, prefix.length);
    result.set(pubKeyBytes, prefix.length + encrypted.length);

    return result;
  }

  /** Get the derived shared app key (for persistence after bond) */
  getSharedAppKey(): Uint8Array {
    return this.sharedAppKey;
  }

  /** Get HIID from challenge bytes (first 20 bytes) */
  static getHIID(challenge: Uint8Array): Uint8Array {
    return challenge.slice(0, 20);
  }

  /** Get BT address from challenge bytes (last 6 bytes) */
  static getBluetoothAddress(challenge: Uint8Array): Uint8Array {
    return challenge.slice(challenge.length - 6);
  }
}
