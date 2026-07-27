import {
  Schema,
  model,
  models,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

export interface SymbolRecord {
  repositoryId: Types.ObjectId;
  fileId: Types.ObjectId;
  name: string;
  type: string;
  startLine: number;
  endLine: number;
  imports: string[];
  references: string[];
  createdAt: Date;
  updatedAt: Date;
}

const symbolSchema = new Schema<SymbolRecord>(
  {
    repositoryId: {
      type: Schema.Types.ObjectId,
      ref: "Repository",
      required: true,
    },
    fileId: {
      type: Schema.Types.ObjectId,
      ref: "RepositoryFile",
      required: true,
    },
    name: { type: String, required: true, trim: true },
    type: { type: String, required: true, trim: true },
    startLine: { type: Number, required: true, min: 1 },
    endLine: { type: Number, required: true, min: 1 },
    imports: { type: [String], default: () => [] },
    references: { type: [String], default: () => [] },
  },
  { timestamps: true, collection: "symbols" },
);

symbolSchema.index({ repositoryId: 1, name: 1 });
symbolSchema.index({ fileId: 1, startLine: 1 });

symbolSchema.path("endLine").validate(function validateLineRange(endLine) {
  return endLine >= this.startLine;
}, "endLine must be greater than or equal to startLine");

export type SymbolDocument = HydratedDocument<SymbolRecord>;
export const SymbolModel =
  (models.SymbolRecord as Model<SymbolRecord> | undefined) ??
  model<SymbolRecord>("SymbolRecord", symbolSchema);
