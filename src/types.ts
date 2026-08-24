export type OAuthClientKind = "confidential" | "public";

/**
 * Non-secret target identity persisted with OAuth credentials. The binding is
 * deliberately redundant: every field must still agree before a credential
 * can be used, so changing an origin or copying a store fails closed.
 */
export interface OAuthBindingTarget {
  binding_version: 1;
  instance_id: string;
  instance_fingerprint: string;
  public_origin: string;
  connection_key: string;
  connection_fingerprint: string;
  resource: string;
}

export interface OAuthCredentialBinding extends OAuthBindingTarget {
  client_kind: OAuthClientKind;
}

export interface OAuthClient {
  client_id: string;
  client_secret_hash: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method?: "client_secret_post" | "client_secret_basic" | "none";
  scope: string;
  created_at: string;
  disabled_at?: string;
  secret_rotated_at?: string;
  token_version?: number;
  /** Absent only on records created before instance-aware OAuth binding. */
  binding?: OAuthCredentialBinding;
}

export interface AuthorizationCode {
  code: string;
  client_id: string;
  client_version: number;
  redirect_uri: string;
  resource?: string;
  scope: string;
  code_challenge: string;
  code_challenge_method: "S256" | "plain";
  expires_at: number;
}

export interface TokenPayload {
  sub: string;
  scope: string;
  iss: string;
  aud: string;
  jti: string;
  client_version?: number;
  iat?: number;
  exp?: number;
}

export interface ClientStore {
  clients: OAuthClient[];
}

export interface RefreshTokenRecord {
  token_hash: string;
  client_id: string;
  scope: string;
  created_at: string;
  expires_at: number;
  client_version?: number;
  /** Absent only on records created before instance-aware OAuth binding. */
  binding?: OAuthCredentialBinding;
}

export interface RefreshTokenStore {
  tokens: RefreshTokenRecord[];
}

/**
 * Private, non-secret ownership marker for PI_DATA_DIR. The legacy target is
 * immutable after creation and anchors one-time upgrades of pre-binding OAuth
 * records, including across later public-origin changes.
 */
export interface OAuthDataDirectoryMetadata {
  metadata_version: 1;
  instance_id: string;
  instance_fingerprint: string;
  legacy_binding_target: OAuthBindingTarget;
  created_at: string;
}
