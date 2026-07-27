import mongoose, { type ConnectOptions } from "mongoose";

export type DatabaseStatus =
  | "disconnected"
  | "connected"
  | "connecting"
  | "disconnecting"
  | "uninitialized";

export type ConnectDatabaseOptions = Pick<
  ConnectOptions,
  "maxPoolSize" | "minPoolSize" | "serverSelectionTimeoutMS"
>;

const defaultOptions: ConnectDatabaseOptions = {
  maxPoolSize: 10,
  minPoolSize: 1,
  serverSelectionTimeoutMS: 5_000,
};

export function getDatabaseStatus(): DatabaseStatus {
  switch (mongoose.connection.readyState) {
    case 0:
      return "disconnected";
    case 1:
      return "connected";
    case 2:
      return "connecting";
    case 3:
      return "disconnecting";
    default:
      return "uninitialized";
  }
}

export async function connectDatabase(
  uri: string,
  options: ConnectDatabaseOptions = {},
): Promise<void> {
  if (!uri.trim()) {
    throw new Error("MongoDB connection URI is required");
  }

  if (mongoose.connection.readyState === 1) {
    return;
  }

  mongoose.set("strictQuery", true);
  mongoose.set("sanitizeFilter", true);

  await mongoose.connect(uri, {
    ...defaultOptions,
    ...options,
    autoIndex: process.env.NODE_ENV !== "production",
  });
}

export async function pingDatabase(): Promise<boolean> {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    return false;
  }

  try {
    await mongoose.connection.db.admin().ping();
    return true;
  } catch {
    return false;
  }
}

export async function disconnectDatabase(): Promise<void> {
  if (mongoose.connection.readyState === 0) {
    return;
  }

  await mongoose.disconnect();
}
