// Run from: node --experimental-vm-modules crypto_ref2.mjs
// Uses @noble/* from node_modules, built-in crypto for AES

import { p256 } from './node_modules/@noble/curves/p256.js';
import { sha256 } from './node_modules/@noble/hashes/sha256.js';
import { createCipheriv } from 'crypto';

// Data from console log
const version = 2;
const challengeHex = '1ef2750dc0ff4ee4143c24d992e990029065 2b33a6f36c73fe9f5c6c73c6ef91c04f7e6b5782c95da17c';
const challenge = Buffer.from(challengeHex.replace(/\s/g,''), 'hex');
console.log('challenge len:', challenge.length); // should be 42

const appBaseKey = Buffer.from([
  84, 104, 169, 138, 255, 144, 217, 85, 196, 139,
  127, 31, 152, 23, 15, 83, 233, 81, 198, 225,
  126, 85, 162, 208, 91, 209, 139, 126, 65, 86, 47, 100
]);

// UpdateChallenge: version=2 (!=1) → SHA256(appBaseKey || challenge[0:20])
const hikey = sha256(new Uint8Array([...appBaseKey, ...challenge.slice(0,20)]));
const commonSecret = sha256(new Uint8Array([...hikey, ...challenge.slice(20,36)]));
console.log('hikey:', Buffer.from(hikey).toString('hex'));
console.log('commonSecret (pre-ECDH):', Buffer.from(commonSecret).toString('hex'));

// HI pubkey from log (64 bytes raw)
const hiPubHex = '7a0e3dbaeb0bac38ac143c460d29121f040498745d86e46c81a1afefaf63687be3145472 92dbef155958d9e4e3cb8403f386429c5cede7a5106cdb1e40a40aad';
const hiPub64 = Buffer.from(hiPubHex.replace(/\s/g,''), 'hex');
const hiPub65 = Buffer.concat([Buffer.from([0x04]), hiPub64]);
console.log('hiPub65 len:', hiPub65.length);

// ECDH
const appPriv = p256.utils.randomPrivateKey();
const appPub = p256.getPublicKey(appPriv, false);
const shared = p256.getSharedSecret(appPriv, hiPub65);
const dhkey = shared.slice(1, 33);
console.log('dhkey len:', dhkey.length, dhkey[0].toString(16));

// Update commonSecret
const cs2 = sha256(new Uint8Array([...commonSecret, ...dhkey]));

// GenerateKeys
const appSession = sha256(new Uint8Array([...cs2, ...Buffer.from('appsession')]));
const hiSession = sha256(new Uint8Array([...cs2, ...Buffer.from('hisession ')]));

// SetKeys: outkey=appSession[0:16], outcounter=appSession[16:32] with [12:16]=[0,0,0,1]
const outKey = Buffer.from(appSession.slice(0,16));
const outCounter = Buffer.from(appSession.slice(16,32));
outCounter[12]=0; outCounter[13]=0; outCounter[14]=0; outCounter[15]=1;

// AES-ECB counter mode encrypt
function aesEcb(key, block) {
  const c = createCipheriv('aes-128-ecb', key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(block), c.final()]);
}

function cryptDecrypt(data, key, ctr) {
  const c = Buffer.from(ctr);
  let ks = Buffer.alloc(0);
  const n = Math.ceil(data.length/16);
  for (let i=0; i<n; i++) {
    ks = Buffer.concat([ks, aesEcb(key, c)]);
    for (let j=15; j>=11; j--) { c[j]=(c[j]+1)&0xFF; if(c[j]!==0) break; }
  }
  return Buffer.from(data.map((b,i)=>b^ks[i]));
}

const encrypted = cryptDecrypt(Buffer.from('APP says hi '), outKey, outCounter);
console.log('\nEncrypted "APP says hi ":', encrypted.toString('hex'));

const prefix = Buffer.from([0,0,4,0,1,0]);
const auth = Buffer.concat([prefix, encrypted, Buffer.from(appPub.slice(1))]);
console.log('Auth payload len:', auth.length, '(expected 82)');
console.log('Auth payload:', auth.toString('hex'));

