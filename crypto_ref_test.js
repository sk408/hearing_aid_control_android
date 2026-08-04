// Reference implementation of P6TrustKeyHandler to verify against app
// Run from hearing_aid_control_android directory

const { p256 } = require('@noble/curves/p256');
const { sha256 } = require('@noble/hashes/sha256');
const Crypto = require('react-native-quick-crypto');

// Data from console log
const version = 2;
const keyIndex = 0;
const challengeHex = '1ef2750dc0ff4ee4143c24d992e99002906 52b33a6f36c73fe9f5c6c73c6ef91c04f7e6b5782c95da17c';
const challenge = Buffer.from(challengeHex.replace(/\s/g,''), 'hex');

// AppBaseKeys_2 (version != 1)
const appBaseKey = Buffer.from([
  84, 104, 169, 138, 255, 144, 217, 85, 196, 139,
  127, 31, 152, 23, 15, 83, 233, 81, 198, 225,
  126, 85, 162, 208, 91, 209, 139, 126, 65, 86,
  47, 100
]);

console.log('version:', version, 'keyIndex:', keyIndex);
console.log('challenge:', challenge.toString('hex'), '(' + challenge.length + ' bytes)');

// UpdateChallenge: version != 1 → SHA256(appBaseKey || challenge[0:20])
const hiidPart = challenge.slice(0, 20);
const secretPart = challenge.slice(20, 36);

const hikey = sha256(Buffer.concat([appBaseKey, hiidPart]));
console.log('hikey:', Buffer.from(hikey).toString('hex'));

const commonSecret = sha256(Buffer.concat([hikey, secretPart]));
console.log('commonSecret (after UpdateChallenge):', Buffer.from(commonSecret).toString('hex'));

// SetHIPublicKey — we need to use the SAME pubkey the app used
// From log: 7a 0e 3d ba ... (64 bytes)
const hiPubKeyHex = '7a0e3dbaeb0bac38ac143c460d29121f0404987 45d86e46c81a1afefaf63687be3145472 92dbef155958d9e4e3cb8403f386429c5cede7a5106cdb1e40a40aad';
const hiPubKey64 = Buffer.from(hiPubKeyHex.replace(/\s/g,''), 'hex');
const hiPubKey65 = Buffer.concat([Buffer.from([0x04]), hiPubKey64]);

console.log('\nHI pubkey (65 bytes):', hiPubKey65.toString('hex'));

// Generate our own ephemeral key (this will differ from what the app used)
const appPrivKey = p256.utils.randomPrivateKey();
const appPubKey = p256.getPublicKey(appPrivKey, false); // 65 bytes uncompressed
console.log('App ephemeral pubkey[0]:', appPubKey[0]); // should be 0x04

// ECDH
const sharedPoint = p256.getSharedSecret(appPrivKey, hiPubKey65);
const dhkey = sharedPoint.slice(1, 33); // X coordinate
console.log('dhkey (X coordinate, 32 bytes):', Buffer.from(dhkey).toString('hex'));

// commonSecret = SHA256(commonSecret || dhkey)
const cs2 = sha256(Buffer.concat([commonSecret, dhkey]));
console.log('commonSecret (after ECDH):', Buffer.from(cs2).toString('hex'));

// GenerateKeys
const appSession = sha256(Buffer.concat([cs2, Buffer.from('appsession')]));
const hiSession = sha256(Buffer.concat([cs2, Buffer.from('hisession ')])); // trailing space!
const sharedAppKeyDerived = sha256(Buffer.concat([cs2, Buffer.from('appSharedBaseKey')]));
console.log('\nappSession:', Buffer.from(appSession).toString('hex'));
console.log('hiSession:', Buffer.from(hiSession).toString('hex'));
console.log('sharedAppKey:', Buffer.from(sharedAppKeyDerived).toString('hex'));

// SetKeys: outkey = appSession[0:16], outcounter = appSession[16:32] with [12:16]=[0,0,0,1]
const outKey = appSession.slice(0, 16);
const outCounter = Buffer.from(appSession.slice(16, 32));
outCounter[12] = 0; outCounter[13] = 0; outCounter[14] = 0; outCounter[15] = 1;
console.log('\noutKey:', Buffer.from(outKey).toString('hex'));
console.log('outCounter:', outCounter.toString('hex'));

// Encrypt "APP says hi " using AES-ECB counter mode
function aesEcbBlock(key, block) {
  const cipher = Crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.from(cipher.update(block));
}

function cryptDecrypt(data, key, counter) {
  const c = Buffer.from(counter);
  let keystream = Buffer.alloc(0);
  const numBlocks = Math.ceil(data.length / 16);
  for (let i = 0; i < numBlocks; i++) {
    keystream = Buffer.concat([keystream, aesEcbBlock(key, c)]);
    // IncrementCounter: bytes 15..11
    for (let j = 15; j >= 11; j--) {
      c[j] = (c[j] + 1) & 0xFF;
      if (c[j] !== 0) break;
    }
  }
  return Buffer.from(data.map((b, i) => b ^ keystream[i]));
}

const plaintext = Buffer.from('APP says hi ');
const encrypted = cryptDecrypt(plaintext, outKey, outCounter);
console.log('\nEncrypted "APP says hi ":', encrypted.toString('hex'));

// GenerateAuth: [0,0,4,0,type=1,index=0] || encrypted || pubKey[1:]
const prefix = Buffer.from([0, 0, 4, 0, 1, 0]);
const pubKeySuffix = Buffer.from(appPubKey.slice(1)); // 64 bytes
const authPayload = Buffer.concat([prefix, encrypted, pubKeySuffix]);
console.log('\nAuth payload (' + authPayload.length + ' bytes):', authPayload.toString('hex'));
console.log('Expected 82 bytes:', authPayload.length === 82);

