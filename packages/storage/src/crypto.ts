import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface EncryptedSecret {
  readonly ciphertext: string;
  readonly iv: string;
  readonly tag: string;
}

export const encryptSecret = (plainText: string, key: Uint8Array): EncryptedSecret => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key), iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64")
  };
};

export const decryptSecret = (encrypted: EncryptedSecret, key: Uint8Array): string => {
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");
};

export const maskSecret = (secret: string): string => {
  if (secret.length <= 8) {
    return "****";
  }
  return `${secret.slice(0, 3)}...${secret.slice(-4)}`;
};
