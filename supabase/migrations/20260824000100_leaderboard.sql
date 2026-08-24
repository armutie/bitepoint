CREATE TABLE public.players (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username VARCHAR(16) NOT NULL,
  username_key VARCHAR(16) GENERATED ALWAYS AS (lower(username)) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT players_username_format CHECK (
    char_length(username) BETWEEN 3 AND 16
    AND username ~ '^[A-Za-z0-9][A-Za-z0-9_-]*[A-Za-z0-9]$'
  ),
  CONSTRAINT players_username_key_unique UNIQUE (username_key)
);

CREATE TABLE public.laps (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL,
  easy BOOLEAN NOT NULL,
  ruleset TEXT NOT NULL,
  preset TEXT NOT NULL,
  tc BOOLEAN NOT NULL,
  abs BOOLEAN NOT NULL,
  time DOUBLE PRECISION NOT NULL CHECK (time > 0),
  sectors JSONB NOT NULL CHECK (
    jsonb_typeof(sectors) = 'array' AND jsonb_array_length(sectors) = 3
  ),
  recorded_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX laps_board_time_idx
  ON public.laps(track_id, easy, ruleset, time, recorded_at);
CREATE INDEX laps_player_board_time_idx
  ON public.laps(player_id, track_id, easy, ruleset, time, recorded_at);

-- Every lap keeps compact timing metadata. Only the current PB for each player
-- and board keeps the larger replay/ghost payload.
CREATE TABLE public.lap_replays (
  lap_id UUID PRIMARY KEY REFERENCES public.laps(id) ON DELETE CASCADE,
  payload JSONB NOT NULL
);

-- One row per user and minute is enough to stop repeated verification work.
CREATE TABLE public.submission_rate_limits (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  window_started TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts > 0),
  PRIMARY KEY (user_id, window_started)
);

ALTER TABLE public.players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.laps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lap_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.submission_rate_limits ENABLE ROW LEVEL SECURITY;

-- The browser never writes official data directly. The Edge Function uses the
-- service role after it has authenticated the user and replayed the lap.
REVOKE ALL ON public.players FROM anon, authenticated;
REVOKE ALL ON public.laps FROM anon, authenticated;
REVOKE ALL ON public.lap_replays FROM anon, authenticated;
REVOKE ALL ON public.submission_rate_limits FROM anon, authenticated;
GRANT ALL ON public.players TO service_role;
GRANT ALL ON public.laps TO service_role;
GRANT ALL ON public.lap_replays TO service_role;
GRANT ALL ON public.submission_rate_limits TO service_role;

CREATE OR REPLACE FUNCTION public.claim_submission_slot(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_attempts INTEGER;
  current_window TIMESTAMPTZ := date_trunc('minute', now());
BEGIN
  INSERT INTO public.submission_rate_limits (user_id, window_started, attempts)
  VALUES (p_user_id, current_window, 1)
  ON CONFLICT (user_id, window_started)
  DO UPDATE SET attempts = public.submission_rate_limits.attempts + 1
  RETURNING attempts INTO current_attempts;

  RETURN current_attempts <= 30;
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_verified_lap(
  p_id UUID,
  p_player_id UUID,
  p_track_id TEXT,
  p_easy BOOLEAN,
  p_ruleset TEXT,
  p_preset TEXT,
  p_tc BOOLEAN,
  p_abs BOOLEAN,
  p_time DOUBLE PRECISION,
  p_sectors JSONB,
  p_recorded_at TIMESTAMPTZ,
  p_replay JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  best_id UUID;
BEGIN
  -- Serialize PB replacement for the same driver and board.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_player_id::text || '|' || p_track_id || '|' || p_easy::text || '|' || p_ruleset,
    0
  ));

  INSERT INTO public.laps (
    id, player_id, track_id, easy, ruleset, preset, tc, abs,
    time, sectors, recorded_at
  ) VALUES (
    p_id, p_player_id, p_track_id, p_easy, p_ruleset, p_preset, p_tc, p_abs,
    p_time, p_sectors, p_recorded_at
  );

  SELECT id INTO best_id
  FROM public.laps
  WHERE player_id = p_player_id
    AND track_id = p_track_id
    AND easy = p_easy
    AND ruleset = p_ruleset
  ORDER BY time ASC, recorded_at ASC, id ASC
  LIMIT 1;

  IF best_id = p_id THEN
    DELETE FROM public.lap_replays
    WHERE lap_id IN (
      SELECT id FROM public.laps
      WHERE player_id = p_player_id
        AND track_id = p_track_id
        AND easy = p_easy
        AND ruleset = p_ruleset
        AND id <> p_id
    );

    INSERT INTO public.lap_replays (lap_id, payload)
    VALUES (p_id, p_replay)
    ON CONFLICT (lap_id) DO UPDATE SET payload = EXCLUDED.payload;
    RETURN true;
  END IF;

  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.leaderboard_page(
  p_track_id TEXT,
  p_easy BOOLEAN,
  p_ruleset TEXT,
  p_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
  entry_id UUID,
  entry_rank BIGINT,
  player_id UUID,
  username TEXT,
  lap_time DOUBLE PRECISION,
  recorded_at TIMESTAMPTZ,
  tc BOOLEAN,
  abs BOOLEAN,
  preset TEXT,
  ghost_available BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH personal_bests AS (
    SELECT DISTINCT ON (l.player_id)
      l.id, l.player_id, p.username, l.time, l.recorded_at,
      l.tc, l.abs, l.preset,
      EXISTS (SELECT 1 FROM public.lap_replays r WHERE r.lap_id = l.id) AS ghost_available
    FROM public.laps l
    JOIN public.players p ON p.id = l.player_id
    WHERE l.track_id = p_track_id
      AND l.easy = p_easy
      AND l.ruleset = p_ruleset
    ORDER BY l.player_id, l.time ASC, l.recorded_at ASC, l.id ASC
  ), ranked AS (
    SELECT *, row_number() OVER (ORDER BY time ASC, recorded_at ASC, id ASC) AS rank
    FROM personal_bests
  )
  SELECT
    id, rank, player_id, username::TEXT, time, recorded_at,
    tc, abs, preset, ghost_available
  FROM ranked
  ORDER BY rank
  LIMIT least(greatest(p_limit, 1), 10000);
$$;

REVOKE ALL ON FUNCTION public.claim_submission_slot(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_verified_lap(
  UUID, UUID, TEXT, BOOLEAN, TEXT, TEXT, BOOLEAN, BOOLEAN,
  DOUBLE PRECISION, JSONB, TIMESTAMPTZ, JSONB
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.leaderboard_page(TEXT, BOOLEAN, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_submission_slot(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.submit_verified_lap(
  UUID, UUID, TEXT, BOOLEAN, TEXT, TEXT, BOOLEAN, BOOLEAN,
  DOUBLE PRECISION, JSONB, TIMESTAMPTZ, JSONB
) TO service_role;
GRANT EXECUTE ON FUNCTION public.leaderboard_page(TEXT, BOOLEAN, TEXT, INTEGER)
  TO service_role;
