import { issueToken } from "./services/user-service.ts";

export function login() {
  const token = issueToken("user");
  return token;
}
