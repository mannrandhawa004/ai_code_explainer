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
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith("A") ? "B" : "A"}`;

    expect(() => cipher.decrypt(tampered)).toThrowError(TokenCipherError);
  });

  it("requires an exact 32-byte base64 key", () => {
    expect(() => new TokenCipher("not-a-production-key")).toThrow(
      "ENCRYPTION_KEY",
    );
  });
});
