-- One board per circuit: easy and standard laps are ranked together, and each
-- row says which mode it was driven in.
--
-- Laps keep their `easy` column, and `submit_verified_lap` is unchanged: it
-- still keeps one replay per driver per mode, so a driver's standard ghost is
-- not deleted when their easy lap becomes the faster one. Only the listing
-- changes.
--
-- `leaderboard_page` is left in place so the Edge Function that is live while
-- this migration runs keeps working; drop it once the new function is deployed.

CREATE OR REPLACE FUNCTION public.leaderboard_board(
  p_track_id TEXT,
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
  easy BOOLEAN,
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
      l.tc, l.abs, l.preset, l.easy,
      EXISTS (SELECT 1 FROM public.lap_replays r WHERE r.lap_id = l.id) AS ghost_available
    FROM public.laps l
    JOIN public.players p ON p.id = l.player_id
    WHERE l.track_id = p_track_id
      AND l.ruleset = p_ruleset
    ORDER BY l.player_id, l.time ASC, l.recorded_at ASC, l.id ASC
  ), ranked AS (
    SELECT *, row_number() OVER (ORDER BY time ASC, recorded_at ASC, id ASC) AS rank
    FROM personal_bests
  )
  SELECT
    id, rank, player_id, username::TEXT, time, recorded_at,
    tc, abs, preset, easy, ghost_available
  FROM ranked
  ORDER BY rank
  LIMIT least(greatest(p_limit, 1), 10000);
$$;

-- The board no longer filters on `easy`, so index it the way it is read.
CREATE INDEX IF NOT EXISTS laps_track_ruleset_time_idx
  ON public.laps(track_id, ruleset, time, recorded_at);

REVOKE ALL ON FUNCTION public.leaderboard_board(TEXT, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leaderboard_board(TEXT, TEXT, INTEGER)
  TO service_role;
