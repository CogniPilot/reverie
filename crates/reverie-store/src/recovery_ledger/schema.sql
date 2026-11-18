BEGIN IMMEDIATE;
CREATE TABLE ledger_meta(version INTEGER NOT NULL, clock_floor INTEGER NOT NULL);
INSERT INTO ledger_meta VALUES(1,0);
CREATE TABLE attempts(
  id TEXT PRIMARY KEY, employee TEXT NOT NULL, goal TEXT NOT NULL,
  session TEXT NOT NULL, issued INTEGER NOT NULL, binding TEXT NOT NULL,
  key TEXT NOT NULL, fingerprint TEXT NOT NULL, UNIQUE(employee,key));
CREATE INDEX employee_budget ON attempts(employee,issued);
CREATE INDEX goal_budget ON attempts(goal,issued);
CREATE INDEX session_budget ON attempts(session,issued);
CREATE TABLE events(
  id TEXT PRIMARY KEY, attempt TEXT NOT NULL, sequence INTEGER NOT NULL,
  state TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL,
  body TEXT NOT NULL CHECK(length(body)<=2048),
  UNIQUE(attempt,sequence), UNIQUE(attempt,key));
CREATE TABLE alerts(
  id TEXT PRIMARY KEY, dimension TEXT NOT NULL, subject TEXT NOT NULL,
  blocked_until INTEGER NOT NULL, body TEXT NOT NULL CHECK(length(body)<=2048),
  UNIQUE(dimension,subject,blocked_until));
CREATE TRIGGER attempts_no_update BEFORE UPDATE ON attempts
  BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER attempts_no_delete BEFORE DELETE ON attempts
  BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER alerts_no_update BEFORE UPDATE ON alerts
  BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER alerts_no_delete BEFORE DELETE ON alerts
  BEGIN SELECT RAISE(ABORT,'immutable'); END;
PRAGMA user_version=1;
COMMIT;
