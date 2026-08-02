import {
  Schema,
  model,
  models,
  type HydratedDocument,
  type Model,
} from "mongoose";

export interface User {
  githubId: string;
  username: string;
  avatarUrl: string;
  email?: string;
  githubAccessTokenEncrypted?: string;
  githubAccessTokenExpiresAt?: Date;
  githubRefreshTokenEncrypted?: string;
  githubRefreshTokenExpiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<User>(
  {
    githubId: { type: String, required: true, unique: true, trim: true },
    username: { type: String, required: true, trim: true, maxlength: 100 },
    avatarUrl: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    githubAccessTokenEncrypted: { type: String, select: false },
    githubAccessTokenExpiresAt: { type: Date, select: false },
    githubRefreshTokenEncrypted: { type: String, select: false },
    githubRefreshTokenExpiresAt: { type: Date, select: false },
  },
  { timestamps: true, collection: "users" },
);

userSchema.index({ username: 1 });

export type UserDocument = HydratedDocument<User>;
export const UserModel =
  (models.User as Model<User> | undefined) ?? model<User>("User", userSchema);
