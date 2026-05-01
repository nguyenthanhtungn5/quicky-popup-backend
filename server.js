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
    link TEXT
  );

  CREATE TABLE IF NOT EXISTS participants (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    name TEXT NOT NULL,
    slot TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );
`);

const existing = db
  .prepare("SELECT id FROM sessions WHERE id = ?")
  .get("Test-Session-1");

if (!existing) {
  db.prepare(
    `
    INSERT INTO sessions (id, title, subtitle, capacity, link)
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(
    "Test-Session-1",
    "CL 29.05",
    "15–16h · 16–18h",
    10,
    "https://www.auzora.de",
  );

  const insertParticipant = db.prepare(`
    INSERT INTO participants (id, session_id, name, slot)
    VALUES (?, ?, ?, ?)
  `);

  insertParticipant.run("1", "Test-Session-1", "Bin", "15h");
  insertParticipant.run("2", "Test-Session-1", "Thanh", "15h");
  insertParticipant.run("3", "Test-Session-1", "Nga", "16h");
}

app.get("/api/session", (req, res) => {
  const session = db.prepare("SELECT * FROM sessions LIMIT 1").get();

  const participants = db
    .prepare("SELECT id, name, slot FROM participants WHERE session_id = ?")
    .all(session.id);

  res.json({
    ...session,
    participants,
  });
});

app.post("/api/session/participants", (req, res) => {
  const { id, name, slot } = req.body;

  if (!id || !name || !slot) {
    return res.status(400).json({ message: "id, name and slot are required" });
  }

  const session = db.prepare("SELECT * FROM sessions LIMIT 1").get();

  db.prepare("DELETE FROM participants WHERE id = ? AND session_id = ?").run(
    id,
    session.id,
  );

  if (slot !== "NO") {
    db.prepare(
      `
      INSERT INTO participants (id, session_id, name, slot)
      VALUES (?, ?, ?, ?)
    `,
    ).run(id, session.id, name, slot);
  }

  const participants = db
    .prepare("SELECT id, name, slot FROM participants WHERE session_id = ?")
    .all(session.id);

  res.json({
    ...session,
    participants,
  });
});

app.delete("/api/session/participants/:id", (req, res) => {
  db.prepare("DELETE FROM participants WHERE id = ?").run(req.params.id);
  res.status(204).send();
});

app.listen(8080, () => {
  console.log("Backend läuft auf http://localhost:8080");
});
