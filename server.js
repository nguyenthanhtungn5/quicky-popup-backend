const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");

const app = express();
const db = new Database("database.sqlite");

app.use(cors());
app.use(express.json());

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    subtitle TEXT,
    capacity INTEGER NOT NULL,
    link TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS participants (
    id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    name TEXT NOT NULL,
    slot TEXT NOT NULL,
    PRIMARY KEY (id, session_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );
`);

const getSessionWithParticipants = (sessionId) => {
  const session = db
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .get(sessionId);

  if (!session) return null;

  const participants = db
    .prepare("SELECT id, name, slot FROM participants WHERE session_id = ?")
    .all(session.id);

  return { ...session, participants };
};

app.get("/api/sessions", (req, res) => {
  const sessions = db
    .prepare("SELECT * FROM sessions ORDER BY created_at DESC")
    .all();

  res.json(sessions);
});

app.get("/api/session", (req, res) => {
  const latestSession = db
    .prepare("SELECT * FROM sessions ORDER BY created_at DESC LIMIT 1")
    .get();

  if (!latestSession) {
    return res.status(404).json({ message: "No session found" });
  }

  res.json(getSessionWithParticipants(latestSession.id));
});

app.get("/api/session/:id", (req, res) => {
  const session = getSessionWithParticipants(req.params.id);

  if (!session) {
    return res.status(404).json({ message: "Session not found" });
  }

  res.json(session);
});

app.post("/api/session", (req, res) => {
  const { title, subtitle, capacity, link } = req.body;

  const id = `session-${Date.now()}`;

  db.prepare(
    `
    INSERT INTO sessions (id, title, subtitle, capacity, link, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    title || "CL -",
    subtitle || "-",
    Number(capacity) || 10,
    link || "https://www.auzora.de",
    Date.now(),
  );

  res.status(201).json(getSessionWithParticipants(id));
});

app.post("/api/session/:id/participants", (req, res) => {
  const { id, name, slot } = req.body;
  const sessionId = req.params.id;

  if (!id || !name || !slot) {
    return res.status(400).json({ message: "id, name and slot are required" });
  }

  const session = getSessionWithParticipants(sessionId);

  if (!session) {
    return res.status(404).json({ message: "Session not found" });
  }

  db.prepare("DELETE FROM participants WHERE id = ? AND session_id = ?").run(
    id,
    sessionId,
  );

  if (slot !== "NO") {
    db.prepare(
      `
      INSERT INTO participants (id, session_id, name, slot)
      VALUES (?, ?, ?, ?)
    `,
    ).run(id, sessionId, name, slot);
  }

  res.json(getSessionWithParticipants(sessionId));
});

app.delete(
  "/api/session/:sessionId/participants/:participantId",
  (req, res) => {
    db.prepare("DELETE FROM participants WHERE id = ? AND session_id = ?").run(
      req.params.participantId,
      req.params.sessionId,
    );

    res.status(204).send();
  },
);

app.listen(8080, () => {
  console.log("Backend läuft auf http://localhost:8080");
});
