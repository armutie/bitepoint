CREATE TABLE IF NOT EXISTS players (
  id UUID PRIMARY KEY,
  username VARCHAR(16) NOT NULL,
  username_key VARCHAR(16) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS player_tokens (
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  token_hash CHAR(64) PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS player_tokens_player_idx ON player_tokens(player_id);

CREATE TABLE IF NOT EXISTS laps (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL,
  easy BOOLEAN NOT NULL,
  ruleset TEXT NOT NULL,
  preset TEXT NOT NULL,
  tc BOOLEAN NOT NULL,
  abs BOOLEAN NOT NULL,
  time DOUBLE PRECISION NOT NULL CHECK (time > 0),
  sectors JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS laps_board_time_idx
  ON laps(track_id, easy, ruleset, time, recorded_at);
CREATE INDEX IF NOT EXISTS laps_player_board_time_idx
  ON laps(player_id, track_id, easy, ruleset, time, recorded_at);

-- Only a player's current PB needs a replay: every row on the public board is
-- one of those PBs, while ordinary laps keep their useful timing metadata.
CREATE TABLE IF NOT EXISTS lap_replays (
  lap_id UUID PRIMARY KEY REFERENCES laps(id) ON DELETE CASCADE,
  payload JSONB NOT NULL
);
