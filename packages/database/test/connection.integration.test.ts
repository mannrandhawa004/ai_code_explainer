import { randomUUID } from "node:crypto";

import { describe, expect, it, afterAll, beforeAll } from "vitest";

import {
  UserModel,
  connectDatabase,
  disconnectDatabase,
  getDatabaseStatus,
  pingDatabase,
} from "../src/index.js";

const mongodbTestUri = process.env.MONGODB_TEST_URI;
const describeWithMongo = mongodbTestUri ? describe : describe.skip;

describeWithMongo("MongoDB connection", () => {
  beforeAll(async () => {
    await connectDatabase(mongodbTestUri as string);
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  it("connects, pings, and persists a model", async () => {
    expect(getDatabaseStatus()).toBe("connected");
    await expect(pingDatabase()).resolves.toBe(true);

    const githubId = randomUUID();
    const user = await UserModel.create({
      githubId,
      username: `test-${githubId}`,
      avatarUrl: "https://avatars.example/test",
    });

    expect(user.id).toEqual(expect.any(String));
    await UserModel.deleteOne({ _id: user._id });
  });
});
