CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  league_name TEXT NOT NULL DEFAULT 'Adabükü Yazlıklar Ligi',
  season TEXT NOT NULL DEFAULT '2026',
  primary_color TEXT NOT NULL DEFAULT '#0f766e',
  secondary_color TEXT NOT NULL DEFAULT '#f59e0b',
  logo_url TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (id = 1)
);
INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  short_name TEXT NOT NULL DEFAULT '',
  logo_url TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS players (
  id SERIAL PRIMARY KEY,
  team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position TEXT NOT NULL DEFAULT 'Oyuncu',
  shirt_number INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS matches (
  id SERIAL PRIMARY KEY,
  week INTEGER NOT NULL DEFAULT 1,
  match_date TIMESTAMPTZ,
  home_team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  away_team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  home_score INTEGER,
  away_score INTEGER,
  venue TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','played','postponed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (home_team_id <> away_team_id)
);

CREATE TABLE IF NOT EXISTS player_stats (
  id SERIAL PRIMARY KEY,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  match_id INTEGER REFERENCES matches(id) ON DELETE CASCADE,
  goals INTEGER NOT NULL DEFAULT 0,
  assists INTEGER NOT NULL DEFAULT 0,
  saves INTEGER NOT NULL DEFAULT 0,
  yellow_cards INTEGER NOT NULL DEFAULT 0,
  red_cards INTEGER NOT NULL DEFAULT 0,
  UNIQUE(player_id, match_id)
);

CREATE INDEX IF NOT EXISTS idx_matches_week ON matches(week);
CREATE INDEX IF NOT EXISTS idx_players_team ON players(team_id);
CREATE INDEX IF NOT EXISTS idx_stats_player ON player_stats(player_id);
