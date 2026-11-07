CREATE TABLE owner_users (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE application_memberships (
  application_id TEXT NOT NULL REFERENCES applications(application_id),
  user_id TEXT NOT NULL REFERENCES owner_users(user_id),
  role TEXT NOT NULL CHECK(role IN ('owner','admin','member')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(application_id,user_id)
);
CREATE INDEX application_memberships_user_idx ON application_memberships(user_id,role);

CREATE TABLE owner_invites (
  invite_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(application_id),
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','member')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX owner_invites_due_idx ON owner_invites(token_hash,expires_at,claimed_at);

CREATE TABLE owner_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES owner_users(user_id),
  session_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT
);
CREATE INDEX owner_sessions_lookup_idx ON owner_sessions(session_hash,expires_at,revoked_at);

CREATE TABLE owner_password_resets (
  reset_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES owner_users(user_id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
