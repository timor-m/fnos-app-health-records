export type IdentityProvider = "fnos_gateway" | "local" | "development";

export type RequestUser = {
  id: string;
  displayName: string;
  /** Original UID from the trusted fnOS gateway; never use the mapped application ID for platform ACLs. */
  fnosUid?: string;
  provider: IdentityProvider;
  authenticated: boolean;
  isAdmin?: boolean;
  mustChangePassword?: boolean;
  /** @deprecated Kept for API and backup compatibility with existing fnOS releases. */
  isGatewayAdmin: boolean;
};

export function isAdministrator(user: Pick<RequestUser, "isAdmin" | "isGatewayAdmin">) {
  return user.isAdmin ?? user.isGatewayAdmin;
}
