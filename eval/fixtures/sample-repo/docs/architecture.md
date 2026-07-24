# Architecture

The application follows a simple layered design:

1. **Entry point** (`src/index.ts`): starts the server and triggers login.
2. **Configuration** (`src/config.ts`): reads PORT from environment.
3. **Authentication** (`src/auth.ts`): implements login using the user service.
4. **User service** (`src/services/user-service.ts`): issues authentication tokens.

The authentication flow: index.ts calls login() in auth.ts, which calls
issueToken() in user-service.ts to generate a token.
