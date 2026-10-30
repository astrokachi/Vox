# Chat & Conversation API

## Base Paths

| Prefix | Feature |
|--------|---------|
| `/api/conversations` | Conversation CRUD |
| `/api/chat` | Chat messages, prompts, refinements |

All routes require `Authorization: Bearer <token>` via `authMiddleware`.

---

## Response Envelope

Every response follows this shape:

```typescript
{
  success: boolean;          // always true (errors handled by global error handler)
  message?: string;          // human-readable description
  data: T;                   // the payload
  pagination?: {             // present on cursor-paginated endpoints
    nextCursor: string | null;
    hasNextPage: boolean;
  };
}
```

---

## Conversation Routes (`/api/conversations`)

### `POST /api/conversations`

Create a standalone conversation (no initial message).

**Body:**
```typescript
{ title: string }
```

**Response `201`:**
```typescript
{
  id: string;          // UUID
  title: string;
  user_id: string;
  created_at: Date;
}
```

---

### `GET /api/conversations`

List user's conversations (cursor-paginated, newest first).

**Query:**
```typescript
cursor?: string;   // last item's id from previous page
take?: number;     // default 20, max 100
```

**Response `200`:**
```typescript
{
  data: {
    id: string;
    title: string;
    user_id: string;
    created_at: Date;
    published: boolean;  // a draft from this conversation has been posted to X
  }[];
  pagination: {
    nextCursor: string | null;
    hasNextPage: boolean;
  };
}
```

---

### `GET /api/conversations/:id`

Get a single conversation with all its message groups and messages.

**Response `200`:**
```typescript
{
  id: string;
  title: string;
  user_id: string;
  created_at: Date;
  message_groups: {
    id: string;
    conversation_id: string;
    created_at: Date;
    updated_at: Date;
    messages: Message[];   // all messages in group, ordered by created_at ASC
  }[];
  // The latest post published from any of its drafts (refinements included);
  // null until something is posted.
  published_post: { x_post_id: string | null; published_at: Date } | null;
}
```

Note: This endpoint eagerly loads the full nested tree (conversation → messageGroups → messages). Refined messages (those with `parent_id` but no `message_group_id`) are NOT included here — they only appear via the message tree endpoint.

---

### `PATCH /api/conversations/:id`

Update conversation title.

**Body:**
```typescript
{ title: string }
```

**Response `200`:**
```typescript
{
  id: string;
  title: string;
  user_id: string;
  created_at: Date;
}
```

---

### `DELETE /api/conversations/:id`

Delete conversation (cascades to messageGroups, messages, memories).

**Response `200`:**
```typescript
{ success: true }
```

---

## Chat Routes (`/api/chat`)

These are the core messaging endpoints. There are two distinct flows:

- **addMessage** — user sends a message in a conversation → AI responds with messages in a message group
- **refine** — user asks to rewrite an existing assistant message → AI responds with a refined message linked only by `parent_id`

### Free-tier draft allowance

Each user can generate **6 drafts in total**, across all conversations (`FREE_DRAFT_LIMIT` in `chat.usage.ts`). Every generated draft counts as one: a `MULTIPLE` prompt asks for up to 3, a `SINGLE` prompt or a refine for 1.

- Drafts are reserved when the request arrives, so a `MULTIPLE` prompt with 2 left asks the model for 2.
- With none left, `new/prompt`, `:id/prompt` and `refine` respond **`403`** (`You've used all 6 free drafts.`) and create nothing.
- Drafts the model didn't produce (fewer options than asked, or a job that failed every retry) are refunded.
- Every draft is capped at 280 characters: the model is told the limit, and longer output is cut at a word break.

### `GET /api/chat/usage`

The current user's draft allowance.

**Response `200`:**
```typescript
{
  used: number;       // drafts generated (or reserved for in-flight jobs)
  limit: number;      // 6
  remaining: number;  // limit - used, never below 0
}
```

---

### `POST /api/chat/new/prompt`

Create a new conversation with the first user message and enqueue an AI response job.

**Body:**
```typescript
{
  content: string;               // required, min 1 char
  title?: string;                // optional, defaults to "New Conversation"
  type?: 'SINGLE' | 'MULTIPLE';  // default 'SINGLE'
}
```

**Flow:**
1. Insert `Conversation` row
2. Insert `MessageGroup` row linked to conversation
3. Insert `Message` (role: `user`) into that group
4. Enqueue BullMQ job `chat:<conversationId>` with `operation: 'addMessage'`
5. Return conversation immediately (AI response is async)

**Response `201`:**
```typescript
{
  id: string;                    // conversation id
  title: string;
  user_id: string;
  created_at: Date;
  messages: Message[];           // the single user message
}
```

---

### `POST /api/chat/:id/prompt`

Add a user message to an existing conversation and enqueue an AI response.

**Body:** Same as `POST /new/prompt`.

**Flow:**
1. Verify conversation exists and belongs to user
2. Find latest `MessageGroup` (or create one)
3. Insert `Message` (role: `user`) into that group
4. Fetch last 10 messages in the group as `recentMessages` context
5. Enqueue BullMQ job `chat:<conversationId>` with `operation: 'addMessage'`
6. Return the user message (AI response is async)

**Response `201`:**
```typescript
{
  id: string;                    // the created message id
  message_group_id: string;
    role: 'user';
  content: string;
  type: 'SINGLE' | 'MULTIPLE';
  parent_id: null;
  created_at: Date;
}
```

---

### `GET /api/chat/:id/messages`

Get a conversation's top-level turns (cursor-paginated, oldest first). Refinement turns are excluded; they come from the thread endpoint.

**Query:**
```typescript
cursor?: string;   // turn (message group) id
take?: number;     // default 50
```

**Response `200`:**
```typescript
{
  data: {
    turnId: string;
    parentMessageId: string | null;
    question: Message | null;
    response: {
      type: "SINGLE" | "MULTIPLE";
      // Drafts in tone order (standard, playful, educative).
      options: (Message & {
        // Latest publish of this draft to X; null if never posted.
        // `content` is the text that went out (it can be edited before posting).
        posted: { x_post_id: string | null; content: string; published_at: Date } | null;
      })[];
    };
  }[];
  pagination: {
    nextCursor: string | null;
    hasNextPage: boolean;
  };
}
```

The thread endpoint's turns carry the same `posted` field on their options.

---

### `GET /api/chat/:id/messages/:messageId`

Get the recursive descendant tree of a message (for viewing refine chains).

Uses a PostgreSQL recursive CTE to find all messages where `parent_id` traces back to the given `messageId`.

**Response `200`:**
```typescript
{
  data: Message[];   // all descendants including the root
}
```

---

### `POST /api/chat/:id/messages/:messageId/refine`

Request an AI refinement of a specific assistant message. The AI response will be a **special message** — it has a `parent_id` pointing to the refined message but **no `message_group_id`** (it is owned by the message, not by the conversation's message group).

**Body:**
```typescript
{
  content?: string;   // optional refinement instruction (e.g. "make it more professional")
}
```

**Flow:**
1. Verify conversation exists and belongs to user
2. Find target message (must be role `assistant`)
3. Fetch all messages in the same message group for context
4. Determine `currentUserContent`: use provided `content`, or the last `User` message in the group, or fall back to the target message's content
5. Insert a `Message` (role: `user`, `parent_id: target.id`) into the same message group — this records the refinement request in the conversation history
6. Enqueue BullMQ job `refine:<conversationId>:<messageId>` with `operation: 'refine'` and `parentId: messageId`
7. Return the user's refinement request message (AI response is async)

**Response `200`:**
```typescript
{
  message: {
    id: string;
    message_group_id: string;    // the original message's group
    role: 'user';
    content: string;
    type: 'SINGLE' | 'MULTIPLE';
    parent_id: string;           // the original assistant message being refined
    created_at: Date;
  };
}
```

---

## Post Routes (`/api/post`)

### `POST /api/post`

Publish a post to X now. `multipart/form-data`.

**Body:**
```typescript
message: string;     // required
draft_id?: string;   // the assistant message being published; must belong to the user
media?: File[];      // images
```

**Response `201`:** the post as X returned it: `{ id, text, edit_history_tweet_ids }`.

**Double-post guard.** The same text (compared after trimming) is published at most once per user. Before
calling X the server reserves a `Tweet` row (`status = 'DRAFT'`, `content_hash`), guarded by a unique
index; it becomes `SENT` when X accepts the post, or `FAILED` if X rejects it (which frees the text).
A reservation older than 2 minutes is treated as abandoned.

**Errors:**
- `404` — `draft_id` doesn't exist or isn't the user's.
- `409` `"You've already posted this."` — `data: { x_post_id: string | null }`, the earlier post.
- `409` `"This post is already being published."` — another request for the same text is in flight.

---

### `GET /api/post/sent`

The user's published posts (cursor-paginated, newest first by `published_at`).

**Query:**
```typescript
cursor?: string;   // last item's id from previous page
take?: number;     // default 20, max 100
```

**Response `200`:**
```typescript
{
  data: {
    id: string;
    content: string;
    x_post_id: string | null;
    conversation_id: string | null;      // null if not published from a draft, or the conversation was deleted
    conversation_title: string | null;
    message_id: string | null;
    published_at: Date;
  }[];
  pagination: { nextCursor: string | null; hasNextPage: boolean };
}
```

---

## BullMQ Queue: `chat-response`

Single queue with two operation types, dispatched via `ChatJobData.operation`:

### `ChatJobData`

```typescript
{
  operation: 'addMessage' | 'refine';
  conversationId: string;        // used for context, memory, socket emission
  recentMessages: { role: 'user' | 'assistant'; content: string }[];
  currentUserMessage: string;
  type: 'SINGLE' | 'MULTIPLE';    // always 'SINGLE' for refine
  parentId?: string;              // only for refine
}
```

### Worker Behavior

Both operations call `AIService.generateChatResponse()` with the same params, then split the response on `---OPTION_SEPARATOR---` for MULTIPLE type.

#### `operation: 'addMessage'`
1. Find or create the latest `MessageGroup` for the conversation
2. For each response option, insert `Message` with `message_group_id`, role `assistant`
3. Emit `message:received` to `conversation:<conversationId>` room
4. Store memories (conversation-scoped RAG)

#### `operation: 'refine'`
1. For each response option, insert `Message` with `parent_id` (from job data), **no `message_group_id`**, role `assistant`
2. Emit `message:refined` to `conversation:<conversationId>` room with payload `{ parentId, message }`
3. Store memories (conversation-scoped RAG)

### `ChatJobResult`

```typescript
{
  success: boolean;
  conversationId: string;
  messageGroupId?: string;   // only for addMessage
  parentId?: string;         // only for refine
  error?: string;
}
```

---

## Socket.io Events

Clients join rooms via `conversation:join` and `conversation:leave`.

| Event | Direction | Payload | When |
|-------|-----------|---------|------|
| `message:typing` | Server → Room | `{ conversationId }` | Job starts processing |
| `message:received` | Server → Room | `Message` | Assistant message saved (addMessage) |
| `message:refined` | Server → Room | `{ parentId, message: Message }` | Refined assistant message saved |
| `message:error` | Server → Room | `{ conversationId, error }` | Job fails after retries |

---

## Database Schema (Drizzle ORM)

### `Conversation`

```
id              text PK     (UUID)
title           text        not null
user_id         text        not null
created_at      timestamp   default now()
```

### `Tweet`

```
id              text PK     (UUID)
user_id         text FK     -> User.id (cascade delete)
content         text        not null
status          enum        'DRAFT' (publish in flight) | 'SENT' | 'SCHEDULED' | 'CANCELLED' | 'FAILED'
dateScheduled   timestamp   not null (publish time for immediate posts)
x_post_id       text?       set once X accepts the post
published_at    timestamp?  set when SENT
conversation_id text FK?    -> Conversation.id (set null on delete)
message_id      text FK?    -> Message.id (set null on delete)
content_hash    text?       sha256 of the trimmed text; unique per user among DRAFT/SENT rows
```

### `MessageGroup`

```
id              text PK     (UUID)
conversation_id text FK     -> Conversation.id (cascade delete)
created_at      timestamp   not null
updated_at      timestamp   not null
```

### `Message`

```
id              text PK     (UUID)
message_group_id text FK?  -> MessageGroup.id (cascade delete) — NULLABLE
role            enum        'user' | 'assistant'
content         text        not null
type            enum        'SINGLE' | 'MULTIPLE' (default 'SINGLE')
created_at      timestamp   default now()
parent_id       text FK?   -> Message.id (self-referencing)
```

The `message_group_id` is **nullable** specifically to support refined messages — they exist outside any message group, linked only by `parent_id` to the original message they refine.

### Relationships

- `Conversation` 1→many `MessageGroup`
- `MessageGroup` 1→many `Message`
- `Message` 1→many `Message` (self-referencing `parent_id` / `children` relation)

### Ownership Chains

```
Conversation ── owns ──> MessageGroup ── owns ──> Message  (addMessage flow)
                                                          │
                                                          └── owns ──> Message (refine flow, via parent_id)
```

Messages in the `addMessage` chain are fetched via `GET /api/chat/:id/messages` (INNER JOIN on messageGroups). Refined messages (children of a message) are fetched via `GET /api/chat/:id/messages/:messageId` (recursive CTE on parent_id).
