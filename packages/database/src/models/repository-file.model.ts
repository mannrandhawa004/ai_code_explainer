import {
  Schema,
  model,
  models,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

export interface RepositoryFile {
  repositoryId: Types.ObjectId;
  branch: string;
  commitSha: string;
  path: string;
  language: string;
  hash: string;
  size: number;
  chunkCount?: number;
  imports: string[];
  exports: string[];
  symbols: string[];
  createdAt: Date;
  updatedAt: Date;
}

const repositoryFileSchema = new Schema<RepositoryFile>(
  {
    repositoryId: {
      type: Schema.Types.ObjectId,
      ref: "Repository",
      required: true,
    },
    branch: { type: String, required: true, trim: true },
    commitSha: { type: String, required: true, trim: true },
    path: { type: String, required: true, trim: true },
    language: { type: String, required: true, trim: true },
    hash: { type: String, required: true, trim: true },
    size: { type: Number, required: true, min: 0 },
    chunkCount: { type: Number, min: 0 },
    imports: { type: [String], default: () => [] },
    exports: { type: [String], default: () => [] },
    symbols: { type: [String], default: () => [] },
  },
  { timestamps: true, collection: "repository_files" },
);

repositoryFileSchema.index(
  { repositoryId: 1, branch: 1, path: 1 },
  { unique: true },
);
repositoryFileSchema.index({ repositoryId: 1, hash: 1 });

export type RepositoryFileDocument = HydratedDocument<RepositoryFile>;
export const RepositoryFileModel =
  (models.RepositoryFile as Model<RepositoryFile> | undefined) ??
  model<RepositoryFile>("RepositoryFile", repositoryFileSchema);
