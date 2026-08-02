import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { TokenCipher, TokenCipherError } from "../src/services/token-cipher.js";

describe("TokenCipher", () => {
  it("round-trips tokens with authenticated encryption and random nonces", () => {
    const cipher = new TokenCipher(randomBytes(32).toString("base64"));
    const token = "github-user-token-fixture";
    const first = cipher.encrypt(token);
    const second = cipher.encrypt(token);

    expect(first).not.toBe(second);
    expect(first).not.toContain(token);
    expect(cipher.decrypt(first)).toBe(token);
    expect(cipher.decrypt(second)).toBe(token);
  });

  it("rejects tampered ciphertext", () => {
    const cipher = new TokenCipher(randomBytes(32).toString("base64"));
    const encrypted = cipher.encrypt("token");
    const components = encrypted.split(":");
    const encodedCiphertext = components[3];
    if (!encodedCiphertext) {
      throw new Error("Encrypted test token did not contain ciphertext");
    }
    const ciphertext = Buffer.from(encodedCiphertext, "base64url");
    ciphertext.writeUInt8(ciphertext.readUInt8(0) ^ 1, 0);
    components[3] = ciphertext.toString("base64url");
    const tampered = components.join(":");

    expect(() => cipher.decrypt(tampered)).toThrowError(TokenCipherError);
  });

  it("requires an exact 32-byte base64 key", () => {
    expect(() => new TokenCipher("not-a-production-key")).toThrow(
      "ENCRYPTION_KEY",
    );
  });
});
