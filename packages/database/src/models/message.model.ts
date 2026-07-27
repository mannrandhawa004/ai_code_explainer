import {
  Schema,
  model,
  models,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

export const messageRoles = ["user", "assistant"] as const;
export const messageFeedbackValues = ["positive", "negative"] as const;
export type MessageRole = (typeof messageRoles)[number];
export type MessageFeedback = (typeof messageFeedbackValues)[number];

export interface MessageSource {
  filePath: string;
  startLine: number;
  endLine: number;
  symbolName?: string;
}

export interface Message {
  conversationId: Types.ObjectId;
  role: MessageRole;
  content: string;
  sources: MessageSource[];
  feedback?: MessageFeedback;
  model?: string;
  latencyMs?: number;
  createdAt: Date;
  updatedAt: Date;
}

const messageSourceSchema = new Schema<MessageSource>(
  {
    filePath: { type: String, required: true, trim: true },
    startLine: { type: Number, required: true, min: 1 },
    endLine: { type: Number, required: true, min: 1 },
    symbolName: { type: String, trim: true },
  },
  { _id: false },
);

const messageSchema = new Schema<Message>(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
    },
    role: { type: String, enum: messageRoles, required: true },
    content: { type: String, required: true },
    sources: { type: [messageSourceSchema], default: () => [] },
    feedback: { type: String, enum: messageFeedbackValues },
    model: { type: String, trim: true },
    latencyMs: { type: Number, min: 0 },
  },
  { timestamps: true, collection: "messages" },
);

messageSchema.index({ conversationId: 1, createdAt: 1 });

export type MessageDocument = HydratedDocument<Message>;
export const MessageModel =
  (models.Message as Model<Message> | undefined) ??
  model<Message>("Message", messageSchema);
