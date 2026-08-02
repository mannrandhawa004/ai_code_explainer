import mongoose, {
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

const { Schema, model, models } = mongoose;

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

export interface MessageTokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface Message {
  conversationId: Types.ObjectId;
  role: MessageRole;
  content: string;
  sources: MessageSource[];
  feedback?: MessageFeedback;
  model?: string;
  providerResponseId?: string;
  tokenUsage?: MessageTokenUsage;
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

const messageTokenUsageSchema = new Schema<MessageTokenUsage>(
  {
    inputTokens: { type: Number, required: true, min: 0 },
    outputTokens: { type: Number, required: true, min: 0 },
    reasoningTokens: { type: Number, required: true, min: 0 },
    totalTokens: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

messageSourceSchema.path("endLine").validate(function validateLineRange(endLine) {
  return endLine >= this.startLine;
}, "endLine must be greater than or equal to startLine");

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
    providerResponseId: { type: String, trim: true },
    tokenUsage: { type: messageTokenUsageSchema },
    latencyMs: { type: Number, min: 0 },
  },
  { timestamps: true, collection: "messages" },
);

messageSchema.index({ conversationId: 1, createdAt: 1 });

export type MessageDocument = HydratedDocument<Message>;
export const MessageModel =
  (models.Message as Model<Message> | undefined) ??
  model<Message>("Message", messageSchema);
