export interface ChatJobData {
  operation: "addMessage" | "refine";
  conversationId: string;
  // The turn (group) the worker inserts the response options into.
  messageGroupId: string;
  recentMessages: { role: "user" | "assistant"; content: string }[];
  currentUserMessage: string;
  type: "SINGLE" | "MULTIPLE";
  // Present for refine jobs: the assistant response this turn refines.
  parentMessageId?: string;
  // Owner of the draft reservation; drafts not generated are refunded to them.
  // Optional only for jobs queued before reservations existed.
  userId?: string;
  // Drafts reserved for this job: how many the model is asked to write.
  draftCount?: number;
}

export interface ChatJobResult {
  success: boolean;
  conversationId: string;
  messageGroupId?: string;
  parentMessageId?: string;
  error?: string;
}
