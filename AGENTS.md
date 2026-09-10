# AGENTS.md - x-bot

## Project Overview

Node.js/TypeScript backend (ES modules) powering an X (Twitter) bot with AI chat, automated tweet replies, and user management.

**Stack:** Express 5, Prisma 7, PostgreSQL + pgvector, KeyDB/Valkey (Redis protocol) + BullMQ, Socket.io, Vercel AI SDK, Joi validation.

## Commands

### Package Manager
Always use **pnpm** (not npm). Lock file: `pnpm-lock.yaml`.

### Development
```bash
pnpm dev              # Hot-reload with tsx watch
pnpm build            # Compile TypeScript → dist/
pnpm start            # Run compiled output
pnpm typecheck        # Type-check without emitting (tsc --noEmit)
```

### Database
```bash
pnpm prisma generate           # Regenerate Prisma client
pnpm prisma migrate dev        # Run pending migrations
pnpm prisma migrate status     # Check migration status
pnpm prisma studio             # Open Prisma Studio UI
```

### Testing
**No test framework is currently configured.** When adding tests, use **Vitest** (compatible with ESM + TypeScript). Run a single test with:
```bash
pnpm vitest run path/to/file.test.ts
pnpm vitest run -t "specific test name"
```

### Adding Dependencies
```bash
pnpm add <package>              # Production dependency
pnpm add -D <package>           # Dev dependency
```

## Architecture

### Feature-Based Structure
Each feature in `src/features/<name>/` contains:
```
<feature>/
  <feature>.controller.ts   # Express request handlers
  <feature>.service.ts      # Business logic (no Express types)
  <feature>.route.ts        # Express router + route definitions
  <feature>.validation.ts   # Joi schemas
  <feature>.queue.ts        # BullMQ workers (if async)
  <feature>.types.ts        # Feature-specific types (if needed)
```

### Shared Code (`src/shared/`)
- `lib/` — Core singletons (prisma, errors, jwt, s3)
- `middleware/` — Express middleware (auth, error handler, loggers)
- `services/` — Cross-cutting services (AI, S3, Socket.io, X API)
- `types/` — Global TypeScript declarations
- `utils/` — Pure utility functions (response, validate, logger, keydb)

## Code Style

### Imports
- **ESM only** — `"type": "module"` in package.json
- Internal imports **must** use `.js` extension (required by ESM):
  ```typescript
  import { sendResponse } from "../../shared/utils/response.js";
  ```
- Group imports: external libraries first, then internal modules
- No path aliases — use relative imports only

### Formatting
- 2-space indentation
- Double quotes for strings
- Semicolons required
- Trailing commas in multi-line structures
- Max line length: 120 chars (soft limit)

### TypeScript
- **Strict mode fully enabled** — no `any` unless absolutely necessary
- `noUnusedLocals` and `noUnusedParameters` are enforced
- Use `interface` for object shapes, `type` for unions/aliases
- Extend Express Request via module augmentation (see `src/shared/types/express.d.ts`):
  ```typescript
  declare module "express" {
    interface Request {
      user?: { user_id: string };
    }
  }
  ```
- Prefer explicit return types on exported functions

### Naming Conventions
| Element | Convention | Example |
|---------|-----------|---------|
| Files | kebab-case | `auth.controller.ts` |
| Directories | kebab-case | `tweet-reply/`, `x-account/` |
| Functions/variables | camelCase | `sendResponse`, `keydbClient` |
| Classes | PascalCase | `AIService`, `AppError` |
| Interfaces/types | PascalCase | `ChatJobData`, `Tokens` |
| Constants | UPPER_SNAKE_CASE | `INSTRUCTIONS`, `SECRET_KEY` |
| DB columns (Prisma) | snake_case | `user_id`, `created_at` |

### Error Handling
- Use custom error classes from `src/shared/lib/errors.ts`:
  - `AppError` (base), `AuthenticationError` (401), `UnauthorizedError` (401)
  - `ValidationError` (400), `NotFoundError` (404), `InvalidTokenError` (401)
- Controllers wrap logic in `try/catch`, pass errors to `next(error)`:
  ```typescript
  export async function handler(req: Request, res: Response, next: NextFunction) {
    try {
      // logic
    } catch (error) {
      next(error);
    }
  }
  ```
- Use `sendResponse()` from `src/shared/utils/response.js` for all successful responses:
  ```typescript
  sendResponse(res, 200, "Success message", data);
  ```
- Global error handler middleware formats all errors into JSON responses

### Validation
- Use **Joi** schemas in `.validation.ts` files
- Apply via `validateBody()`, `validatePrompt()` middleware from `src/shared/utils/validate.js`

### Async/Queues
- Long-running AI operations use **BullMQ** queues
- Workers live in `<feature>.queue.ts`
- Queue workers log errors and re-throw for BullMQ retry handling

### Logging
- Use **Pino** via `src/shared/utils/logger.js`
- Import and use the exported logger instance:
  ```typescript
  import { logger } from "../shared/utils/logger.js";
  logger.info({ userId }, "User logged in");
  ```

## Git Conventions
- Commit messages: imperative mood, concise (`"Add tweet reply queue"`)
- Never commit `.env` or generated files
- Run `pnpm typecheck` before committing
