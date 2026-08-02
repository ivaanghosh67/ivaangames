-- Iron Line — player progress and leaderboards.
--
-- Lives in its OWN database (`ironline`) with its own least-privilege user, so
-- it can never reach the business tables that share this MySQL instance.
--
-- Identity is deliberately two-layered:
--   * `token_hash` is the anonymous per-browser token the game already uses for
--     reconnects. It works with no sign-in at all, which keeps "click a link and
--     play in four seconds" intact.
--   * `google_sub` is filled in later if the player signs in. Signing in ADOPTS
--     the existing anonymous row rather than starting a fresh one, so nobody
--     loses progress by creating an account.
--
-- Personal data is kept to the minimum a game needs: a display name the player
-- chose, and their own game statistics. No email, no avatar, no profile.

CREATE DATABASE IF NOT EXISTS ironline
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE ironline;

CREATE TABLE IF NOT EXISTS players (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  token_hash    CHAR(64)     NOT NULL,           -- sha256 of the browser token
  google_sub    VARCHAR(64)  NULL,               -- set only if they sign in
  display_name  VARCHAR(24)  NOT NULL DEFAULT 'Player',
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                             ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_token  (token_hash),
  UNIQUE KEY uniq_google (google_sub),
  KEY idx_last_seen (last_seen)
) ENGINE=InnoDB;

-- Quest counters and lifetime totals. One row per player.
CREATE TABLE IF NOT EXISTS progress (
  player_id     BIGINT UNSIGNED NOT NULL,
  flyer_kills   INT UNSIGNED NOT NULL DEFAULT 0,
  boss_kills    INT UNSIGNED NOT NULL DEFAULT 0,
  best_wave     INT UNSIGNED NOT NULL DEFAULT 0,
  total_kills   BIGINT UNSIGNED NOT NULL DEFAULT 0,
  runs_played   INT UNSIGNED NOT NULL DEFAULT 0,
  runs_won      INT UNSIGNED NOT NULL DEFAULT 0,
  gold_earned   BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                          ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (player_id),
  CONSTRAINT fk_progress_player FOREIGN KEY (player_id)
    REFERENCES players(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Best result per difficulty, which is what the leaderboards read.
CREATE TABLE IF NOT EXISTS bests (
  player_id     BIGINT UNSIGNED NOT NULL,
  difficulty    VARCHAR(16)  NOT NULL,
  party_size    TINYINT UNSIGNED NOT NULL,
  best_wave     INT UNSIGNED NOT NULL DEFAULT 0,
  won           TINYINT(1)   NOT NULL DEFAULT 0,
  fastest_secs  INT UNSIGNED NULL,               -- only set on a win
  achieved_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (player_id, difficulty, party_size),
  KEY idx_board (difficulty, party_size, best_wave DESC, achieved_at ASC),
  KEY idx_fastest (difficulty, party_size, won, fastest_secs ASC),
  CONSTRAINT fk_bests_player FOREIGN KEY (player_id)
    REFERENCES players(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- How each unit performs, so "which turret earns its cost" can be answered from
-- real play rather than from the balance bot.
CREATE TABLE IF NOT EXISTS unit_stats (
  player_id     BIGINT UNSIGNED NOT NULL,
  unit          VARCHAR(24)  NOT NULL,
  built         INT UNSIGNED NOT NULL DEFAULT 0,
  gold_spent    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  kills         BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, unit),
  CONSTRAINT fk_unit_player FOREIGN KEY (player_id)
    REFERENCES players(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Completed runs, for history and for the fastest-clear board.
CREATE TABLE IF NOT EXISTS runs (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  player_id     BIGINT UNSIGNED NOT NULL,
  room_code     CHAR(5)      NULL,
  difficulty    VARCHAR(16)  NOT NULL,
  party_size    TINYINT UNSIGNED NOT NULL,
  map_name      VARCHAR(32)  NOT NULL,
  wave          INT UNSIGNED NOT NULL,
  won           TINYINT(1)   NOT NULL DEFAULT 0,
  kills         INT UNSIGNED NOT NULL DEFAULT 0,
  seconds       INT UNSIGNED NOT NULL DEFAULT 0,
  ended_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_player_time (player_id, ended_at DESC),
  CONSTRAINT fk_runs_player FOREIGN KEY (player_id)
    REFERENCES players(id) ON DELETE CASCADE
) ENGINE=InnoDB;
