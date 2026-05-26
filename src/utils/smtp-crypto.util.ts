import crypto from "crypto";

function getPrivateKeyPem(): string {
  const b64 = process.env.SMTP_RSA_PRIVATE_KEY_B64;
  if (!b64) throw new Error("SMTP_RSA_PRIVATE_KEY_B64 not set in environment");
  return Buffer.from(b64, "base64").toString("utf8");
}

function getAesKey(): Buffer {
  const hex = process.env.SMTP_AES_KEY;
  if (!hex) throw new Error("SMTP_AES_KEY not set in environment");
  return Buffer.from(hex, "hex");
}

/** Derive RSA public key PEM from the stored private key. */
export function getPublicKeyPem(): string {
  const privateKeyObj = crypto.createPrivateKey(getPrivateKeyPem());
  const publicKeyObj = crypto.createPublicKey(privateKeyObj);
  return publicKeyObj.export({ type: "spki", format: "pem" }) as string;
}

/** RSA-OAEP (SHA-256) decrypt – used when receiving credentials from the browser. */
export function rsaDecrypt(encryptedB64: string): string {
  const buffer = Buffer.from(encryptedB64, "base64");
  return crypto
    .privateDecrypt(
      {
        key: getPrivateKeyPem(),
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      buffer
    )
    .toString("utf8");
}

/** AES-256-GCM encrypt for database storage. Returns iv:tag:ciphertext (all base64). */
export function aesEncrypt(plaintext: string): string {
  const key = getAesKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

/** AES-256-GCM decrypt from database. Handles legacy plaintext values gracefully. */
export function aesDecrypt(stored: string): string {
  // Legacy records stored before encryption was added — return as-is
  if (!stored || !stored.includes(":")) return stored;

  const parts = stored.split(":");
  if (parts.length !== 3) return stored;

  const [ivB64, tagB64, encB64] = parts as [string, string, string];
  const key = getAesKey();
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const enc = Buffer.from(encB64, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc).toString("utf8") + decipher.final("utf8");
}
