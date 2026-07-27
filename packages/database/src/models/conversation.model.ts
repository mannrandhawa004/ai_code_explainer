import {
  Schema,
  model,
  models,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

export interface Conversation {
  userId: Types.ObjectId;
  repositoryId: Types.ObjectId;
  title: string;
  branch: string;
  createdAt: Date;
  updatedAt: Date;
}

const conversationSchema = new Schema<Conversation>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    repositoryId: {
      type: Schema.Types.ObjectId,
      ref: "Repository",
      required: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    branch: { type: String, required: true, trim: true },
  },
  { timestamps: true, collection: "conversations" },
);

conversationSchema.index({ userId: 1, repositoryId: 1, updatedAt: -1 });

export type ConversationDocument = HydratedDocument<Conversation>;
export const ConversationModel =
  (models.Conversation as Model<Conversation> | undefined) ??
  model<Conversation>("Conversation", conversationSchema);
