import crypto from "node:crypto";

function decodeKey(value) {
  const key = Buffer.from(String(value || ""), "base64url");
  if (key.length !== 32 || !/^[A-Za-z0-9_-]{43,44}$/.test(String(value))) throw new TypeError("Encryption key must be a 32-byte base64url value");
  return key;
}

export function createSecretBox(key) {
  const keyBytes = decodeKey(key);
  return Object.freeze({
    encrypt(plaintext) {
      if (typeof plaintext !== "string" || !plaintext) throw new TypeError("A non-empty secret is required");
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", keyBytes, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
    },
    decrypt(ciphertext) {
      try {
        const [version, ivText, tagText, bodyText, extra] = String(ciphertext || "").split(".");
        if (version !== "v1" || !ivText || !tagText || bodyText === undefined || extra !== undefined) throw new Error("invalid");
        const decipher = crypto.createDecipheriv("aes-256-gcm", keyBytes, Buffer.from(ivText, "base64url"));
        decipher.setAuthTag(Buffer.from(tagText, "base64url"));
        return Buffer.concat([decipher.update(Buffer.from(bodyText, "base64url")), decipher.final()]).toString("utf8");
      } catch {
        throw Object.assign(new Error("Encrypted secret could not be opened"), { code: "SECRET_DECRYPTION_FAILED" });
      }
    },
  });
}
