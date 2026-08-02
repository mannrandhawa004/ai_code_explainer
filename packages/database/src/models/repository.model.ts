import mongoose, {
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

const { Schema, model, models } = mongoose;

export const repositoryStatuses = [
  "pending",
  "queued",
  "cloning",
  "scanning",
  "parsing",
  "embedding",
  "indexing",
  "ready",
  "failed",
] as const;

export type RepositoryStatus = (typeof repositoryStatuses)[number];
const gitObjectIdPattern = /^[0-9a-f]{40,64}$/u;

export interface Repository {
  userId: Types.ObjectId;
  githubRepositoryId?: number;
  installationId?: number;
  githubAccessRevokedAt?: Date;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  selectedBranch: string;
  defaultBranch: string;
  status: RepositoryStatus;
  lastIndexedCommit?: string;
  pendingIndexCommit?: string;
  indexedAt?: Date;
  errorMessage?: string;
  stats: {
    files: number;
    chunks: number;
    languages: Map<string, number>;
  };
  createdAt: Date;
  updatedAt: Date;
}

const statsSchema = new Schema<Repository["stats"]>(
  {
    files: { type: Number, min: 0, default: 0 },
    chunks: { type: Number, min: 0, default: 0 },
    languages: { type: Map, of: Number, default: () => new Map() },
  },
  { _id: false },
);

const repositorySchema = new Schema<Repository>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    githubRepositoryId: { type: Number },
    installationId: { type: Number },
    githubAccessRevokedAt: { type: Date },
    owner: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    fullName: { type: String, required: true, trim: true },
    private: { type: Boolean, required: true, default: false },
    selectedBranch: { type: String, required: true, trim: true },
    defaultBranch: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: repositoryStatuses,
      required: true,
      default: "pending",
    },
    lastIndexedCommit: { type: String, trim: true, match: gitObjectIdPattern },
    pendingIndexCommit: { type: String, trim: true, match: gitObjectIdPattern },
    indexedAt: { type: Date },
    errorMessage: { type: String },
    stats: { type: statsSchema, default: () => ({}) },
  },
  { timestamps: true, collection: "repositories" },
);

repositorySchema.index(
  { userId: 1, githubRepositoryId: 1 },
  {
    unique: true,
    partialFilterExpression: { githubRepositoryId: { $type: "number" } },
  },
);
repositorySchema.index({ userId: 1, fullName: 1 }, { unique: true });
repositorySchema.index({ userId: 1, status: 1 });
repositorySchema.index({ userId: 1, updatedAt: -1 });

export type RepositoryDocument = HydratedDocument<Repository>;
export const RepositoryModel =
  (models.Repository as Model<Repository> | undefined) ??
  model<Repository>("Repository", repositorySchema);
