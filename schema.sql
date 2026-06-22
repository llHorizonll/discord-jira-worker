-- Store synced Jira issues
CREATE TABLE IF NOT EXISTS issues (
  key TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  issuetype TEXT NOT NULL,
  status TEXT NOT NULL,
  status_category TEXT NOT NULL,
  priority TEXT,
  story_points REAL DEFAULT 0,
  assignee_id TEXT, -- Jira Account ID
  created_at TEXT NOT NULL, -- ISO-8601
  updated_at TEXT NOT NULL, -- ISO-8601
  resolved_at TEXT, -- ISO-8601
  in_progress_at TEXT, -- ISO-8601
  reopened_count INTEGER DEFAULT 0,
  is_production_bug INTEGER DEFAULT 0,
  customer TEXT
);

-- Store daily KPI snapshots for developers
CREATE TABLE IF NOT EXISTS daily_snapshots (
  date TEXT NOT NULL, -- YYYY-MM-DD (e.g. 2026-06-19)
  developer_id TEXT NOT NULL, -- Jira Account ID
  score REAL DEFAULT 0,
  closed_tickets INTEGER DEFAULT 0,
  story_points REAL DEFAULT 0,
  lead_time_avg REAL DEFAULT 0,
  cycle_time_avg REAL DEFAULT 0,
  sla_compliance REAL DEFAULT 0,
  reopened_rate REAL DEFAULT 0,
  production_bug_rate REAL DEFAULT 0,
  PRIMARY KEY (date, developer_id)
);
