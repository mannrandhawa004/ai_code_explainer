import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const algorithm = "aes-256-gcm";
const initializationVectorBytes = 12;
const formatVersion = "v1";

export class TokenCipherError extends Error {
  override readonly name = "TokenCipherError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

function decodeKey(encodedKey: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(encodedKey, "base64");
  } catch (cause) {
    throw new TokenCipherError("The token encryption key is invalid", { cause });
  }

  if (key.length !== 32 || key.toString("base64") !== encodedKey) {
    throw new TokenCipherError(
      "ENCRYPTION_KEY must be a canonical base64-encoded 32-byte key",
    );
  }
  return key;
}

export class TokenCipher {
  private readonly key: Buffer;

  constructor(encodedKey: string) {
    this.key = decodeKey(encodedKey);
  }

  encrypt(value: string): string {
    if (!value || value.includes("\0")) {
      throw new TokenCipherError("A non-empty token is required");
    }

    const initializationVector = randomBytes(initializationVectorBytes);
    const cipher = createCipheriv(algorithm, this.key, initializationVector);
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    const authenticationTag = cipher.getAuthTag();

    return [
      formatVersion,
      initializationVector.toString("base64url"),
      authenticationTag.toString("base64url"),
      encrypted.toString("base64url"),
    ].join(":");
  }

  decrypt(value: string): string {
    const [version, encodedIv, encodedTag, encodedCiphertext, ...extra] =
      value.split(":");
    if (
      version !== formatVersion ||
      !encodedIv ||
      !encodedTag ||
      !encodedCiphertext ||
      extra.length > 0
    ) {
      throw new TokenCipherError("The encrypted token format is invalid");
    }

    try {
      const initializationVector = Buffer.from(encodedIv, "base64url");
      const authenticationTag = Buffer.from(encodedTag, "base64url");
      if (initializationVector.length !== initializationVectorBytes) {
        throw new Error("Invalid initialization vector");
      }
      const decipher = createDecipheriv(
        algorithm,
        this.key,
        initializationVector,
      );
      decipher.setAuthTag(authenticationTag);
      return Buffer.concat([
        decipher.update(Buffer.from(encodedCiphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch (cause) {
      throw new TokenCipherError("The encrypted token could not be decrypted", {
        cause,
      });
    }
  }
}
