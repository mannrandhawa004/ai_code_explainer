import {
  Schema,
  model,
  models,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

export const indexingJobStatuses = [
  "waiting",
  "active",
  "completed",
  "failed",
  "delayed",
  "cancelled",
] as const;

export type IndexingJobStatus = (typeof indexingJobStatuses)[number];

export interface IndexingJob {
  repositoryId: Types.ObjectId;
  bullJobId: string;
  status: IndexingJobStatus;
  progress: number;
  currentStep?: string;
  startedAt?: Date;
  completedAt?: Date;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

const indexingJobSchema = new Schema<IndexingJob>(
  {
    repositoryId: {
      type: Schema.Types.ObjectId,
      ref: "Repository",
      required: true,
    },
    bullJobId: { type: String, required: true, unique: true, trim: true },
    status: {
      type: String,
      enum: indexingJobStatuses,
      required: true,
      default: "waiting",
    },
    progress: { type: Number, required: true, min: 0, max: 100, default: 0 },
    currentStep: { type: String },
    startedAt: { type: Date },
    completedAt: { type: Date },
    errorMessage: { type: String },
  },
  { timestamps: true, collection: "indexing_jobs" },
);

indexingJobSchema.index({ repositoryId: 1, createdAt: -1 });
indexingJobSchema.index({ status: 1, updatedAt: -1 });

export type IndexingJobDocument = HydratedDocument<IndexingJob>;
export const IndexingJobModel =
  (models.IndexingJob as Model<IndexingJob> | undefined) ??
  model<IndexingJob>("IndexingJob", indexingJobSchema);
