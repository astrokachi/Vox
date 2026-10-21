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
take?: number;     // default 20
```

**Response `200`:**
```typescript
{
  data: {
    id: string;
    title: string;
    user_id: string;
    created_at: Date;
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

Get all messages in a conversation (cursor-paginated, oldest first).

Uses `INNER JOIN` on `messageGroups`, so **refined messages (no `message_group_id`) are excluded**.

**Query:**
```typescript
cursor?: string;   // message id
take?: number;     // default 50
```

**Response `200`:**
```typescript
{
  data: Message[];
  pagination: {
    nextCursor: string | null;
    hasNextPage: boolean;
  };
}
```

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
