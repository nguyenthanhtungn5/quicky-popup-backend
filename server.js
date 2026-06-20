const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");

const app = express();
const db = new Database("database.sqlite");

require("dotenv").config();
const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(cors());
app.use(express.json());

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    subtitle TEXT,
    capacity INTEGER NOT NULL,
    link TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    additional_info TEXT,
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
  
   CREATE TABLE IF NOT EXISTS calculations (
    session_id TEXT PRIMARY KEY,
    court_price REAL NOT NULL,
    shuttle_price REAL NOT NULL,
    payer_id TEXT NOT NULL,
    total REAL NOT NULL,
    person_count INTEGER NOT NULL,
    amount_per_person REAL NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );

  CREATE TABLE IF NOT EXISTS session_slots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  court_count INTEGER NOT NULL DEFAULT 1,
  max_players INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
  );

  CREATE TABLE IF NOT EXISTS participant_slots (
    session_id TEXT NOT NULL,
    participant_id TEXT NOT NULL,
    slot_id TEXT NOT NULL,
    PRIMARY KEY (session_id, participant_id, slot_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id),
    FOREIGN KEY (slot_id) REFERENCES session_slots(id)
  );

  CREATE TABLE IF NOT EXISTS waitlist (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  note TEXT,
  position INTEGER NOT NULL,
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
    .all(session.id)
    .map((p) => ({
      ...p,
      slotIds: db
        .prepare(
          `
        SELECT slot_id
        FROM participant_slots
        WHERE session_id = ? AND participant_id = ?
      `,
        )
        .all(session.id, p.id)
        .map((row) => row.slot_id),
    }));

  const slots = db
    .prepare(
      `
    SELECT id, start_time AS startTime, end_time AS endTime,
           court_count AS courtCount, max_players AS maxPlayers
    FROM session_slots
    WHERE session_id = ?
    ORDER BY start_time
  `,
    )
    .all(session.id);

  const waitlist = db
    .prepare(
      `
    SELECT id, name, note, position
    FROM waitlist
    WHERE session_id = ?
    ORDER BY position
  `,
    )
    .all(session.id);
  return { ...session, slots, participants, waitlist };
};

app.get("/api/sessions", (req, res) => {
  const sessions = db
    .prepare(
      "SELECT * FROM sessions WHERE archived = 0 ORDER BY created_at DESC",
    )
    .all();

  const result = sessions.map((session) => ({
    ...session,
    participants: db
      .prepare("SELECT id, name, slot FROM participants WHERE session_id = ?")
      .all(session.id),
  }));

  res.json(result);
});

app.get("/api/sessions/archived", (req, res) => {
  const sessions = db
    .prepare(
      "SELECT * FROM sessions WHERE archived = 1 ORDER BY created_at DESC",
    )
    .all();

  const result = sessions.map((session) => ({
    ...session,
    participants: db
      .prepare("SELECT id, name, slot FROM participants WHERE session_id = ?")
      .all(session.id),
  }));

  res.json(result);
});

app.patch("/api/session/:id/archive", (req, res) => {
  const sessionId = req.params.id;

  const session = getSessionWithParticipants(sessionId);
  if (!session) {
    return res.status(404).json({ message: "Session not found" });
  }

  db.prepare("UPDATE sessions SET archived = 1 WHERE id = ?").run(sessionId);

  res.json(getSessionWithParticipants(sessionId));
});

app.patch("/api/session/:id/unarchive", (req, res) => {
  const sessionId = req.params.id;

  const session = getSessionWithParticipants(sessionId);
  if (!session) {
    return res.status(404).json({ message: "Session not found" });
  }

  db.prepare("UPDATE sessions SET archived = 0 WHERE id = ?").run(sessionId);

  res.json(getSessionWithParticipants(sessionId));
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
  const {
    title,
    subtitle,
    capacity,
    link,
    additionalInfo = "",
    slots = [],
    participants = [],
    waitlist = [],
  } = req.body;

  const id = `session-${Date.now()}`;

  db.prepare(
    `
    INSERT INTO sessions (
      id, title, subtitle, capacity, link, additional_info, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    title || "CL -",
    subtitle || "-",
    Number(capacity) || 10,
    link || "https://www.auzora.de",
    additionalInfo || "",
    Date.now(),
  );

  const insertSlot = db.prepare(`
    INSERT INTO session_slots (
      id, session_id, start_time, end_time, court_count, max_players
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  slots.forEach((slot, index) => {
    insertSlot.run(
      `${id}-slot-${index}`,
      id,
      slot.startTime,
      slot.endTime,
      Number(slot.courtCount) || 1,
      Number(slot.maxPlayers) || null,
    );
  });

  const insertParticipant = db.prepare(`
  INSERT INTO participants (id, session_id, name, slot)
  VALUES (?, ?, ?, ?)
`);

  participants.forEach((p, index) => {
    if (!p.name?.trim()) return;

    insertParticipant.run(
      `${id}-participant-${index}`,
      id,
      p.name.trim(),
      `${p.startTime || ""}-${p.endTime || ""}`,
    );
  });

  const insertWaitlist = db.prepare(`
  INSERT INTO waitlist (id, session_id, name, note, position)
  VALUES (?, ?, ?, ?, ?)
`);

  waitlist.forEach((p, index) => {
    if (!p.name?.trim()) return;

    insertWaitlist.run(
      `${id}-waitlist-${index}`,
      id,
      p.name.trim(),
      p.note || "",
      index + 1,
    );
  });

  res.status(201).json(getSessionWithParticipants(id));
});

app.post("/api/session/:id/participants", (req, res) => {
  const { id, name, slotIds = [] } = req.body;
  const sessionId = req.params.id;

  if (!id || !name) {
    return res.status(400).json({ message: "id and name are required" });
  }

  const session = getSessionWithParticipants(sessionId);
  if (!session) {
    return res.status(404).json({ message: "Session not found" });
  }

  db.prepare(
    `
    INSERT INTO participants (id, session_id, name, slot)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id, session_id) DO UPDATE SET
      name = excluded.name,
      slot = excluded.slot
  `,
  ).run(id, sessionId, name, slotIds.join(","));

  db.prepare(
    `
    DELETE FROM participant_slots
    WHERE session_id = ? AND participant_id = ?
  `,
  ).run(sessionId, id);

  for (const slotId of slotIds) {
    db.prepare(
      `
      INSERT INTO participant_slots (session_id, participant_id, slot_id)
      VALUES (?, ?, ?)
    `,
    ).run(sessionId, id, slotId);
  }

  res.json(getSessionWithParticipants(sessionId));
});

app.post("/api/session/:id/waitlist", (req, res) => {
  const sessionId = req.params.id;
  const { id, name, note = "" } = req.body;

  if (!id || !name) {
    return res.status(400).json({ message: "id and name are required" });
  }

  const maxPosition = db
    .prepare(
      "SELECT COALESCE(MAX(position), 0) AS max FROM waitlist WHERE session_id = ?",
    )
    .get(sessionId).max;

  db.prepare(
    `
    INSERT INTO waitlist (id, session_id, name, note, position)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id, session_id) DO UPDATE SET
      name = excluded.name,
      note = excluded.note
  `,
  ).run(id, sessionId, name, note, maxPosition + 1);

  res.json(getSessionWithParticipants(sessionId));
});

app.delete(
  "/api/session/:sessionId/participants/:participantId",
  (req, res) => {
    const { sessionId, participantId } = req.params;

    db.prepare("DELETE FROM participants WHERE id = ? AND session_id = ?").run(
      participantId,
      sessionId,
    );

    const firstWaitlist = db
      .prepare(
        `
      SELECT *
      FROM waitlist
      WHERE session_id = ?
      ORDER BY position
      LIMIT 1
    `,
      )
      .get(sessionId);

    if (firstWaitlist) {
      db.prepare(
        `
      INSERT INTO participants (id, session_id, name, slot)
      VALUES (?, ?, ?, ?)
    `,
      ).run(firstWaitlist.id, sessionId, firstWaitlist.name, "");

      db.prepare("DELETE FROM waitlist WHERE id = ? AND session_id = ?").run(
        firstWaitlist.id,
        sessionId,
      );
    }

    res.json(getSessionWithParticipants(sessionId));
  },
);

app.post("/api/session/:id/calculation", (req, res) => {
  const sessionId = req.params.id;
  const { courtPrice, shuttlePrice, payerId } = req.body;

  const session = getSessionWithParticipants(sessionId);

  if (!session) {
    return res.status(404).json({ message: "Session not found" });
  }

  if (!payerId) {
    return res.status(400).json({ message: "payerId is required" });
  }

  const personCount = session.participants.length;

  if (personCount === 0) {
    return res.status(400).json({ message: "No participants" });
  }

  const total = Number(courtPrice || 0) + Number(shuttlePrice || 0);
  const amountPerPerson = Math.round((total / personCount) * 100) / 100;

  db.prepare(
    `
    INSERT INTO calculations (
      session_id,
      court_price,
      shuttle_price,
      payer_id,
      total,
      person_count,
      amount_per_person
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      court_price = excluded.court_price,
      shuttle_price = excluded.shuttle_price,
      payer_id = excluded.payer_id,
      total = excluded.total,
      person_count = excluded.person_count,
      amount_per_person = excluded.amount_per_person
  `,
  ).run(
    sessionId,
    Number(courtPrice || 0),
    Number(shuttlePrice || 0),
    payerId,
    total,
    personCount,
    amountPerPerson,
  );

  const payer = session.participants.find((p) => p.id === payerId);

  res.json({
    sessionId,
    courtPrice: Number(courtPrice || 0),
    shuttlePrice: Number(shuttlePrice || 0),
    total,
    personCount,
    amountPerPerson,
    payer,
    debts: session.participants
      .filter((p) => p.id !== payerId)
      .map((p) => ({
        id: p.id,
        name: p.name,
        amount: amountPerPerson,
        payTo: payer?.name || "Admin",
      })),
  });
});

app.post("/api/parse-session", async (req, res) => {
  const { text } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ message: "text is required" });
  }

  try {
    const systemPrompt = `
      You parse messy badminton session text written in Vietnamese, German, English, or mixed language.

      Return ONLY valid JSON. No markdown. No explanation.

      Extract:
      - title: short session title, e.g. "CL 14.05"
      - date: if available, format "DD.MM"; if not available, empty string
      - capacity: max number of players. "max 12ng", "max. 12", "max 18" means capacity.
      - slots: court/time availability created by admin
      - participants: numbered player list
      - waitlist: players after "waitlist", "wartelist", "waiting list"
      - additionalInfo: all unclear/non-structured notes

      Vocabulary:
      - "sân" = court
      - "ng" = people/persons
      - "thêm ng thêm sân" = if more people join, add more court. Put this into additionalInfo.
      - "ab 14uhr", "ab 17h" = player starts from that time
      - "14-16", "14-16h", "(14-16)" = player availability

      Rules:
      - Do not invent data.
      - If one line says "2 sân 13-16h", create one slot from 13:00 to 16:00 with courtCount 2.
      - If one line says "14-17h: 4 sân", create one slot from 14:00 to 17:00 with courtCount 4.
      - If multiple court-time lines exist, create multiple slots.
      - If a court line contains a payer/person in parentheses, put it into note.
      - Participants without specific time get empty startTime/endTime.
      - Participants with "(14-16)" get startTime "14:00", endTime "16:00".
      - Participants with "ab 17h" get startTime "17:00", endTime "".
      - Keep original participant names clean without numbering and without time notes.
      - Preserve Vietnamese names and accents.
      - Players after "Wartelist", "Waitlist", "Waiting list" go into waitlist.
      - Empty waitlist numbers like "1." or "2." should be ignored.
      - Waitlist players are NOT participants and do not count for capacity/payment.

      JSON shape:
      {
        "title": string,
        "date": string,
        "capacity": number,
        "subtitle": string,
        "additionalInfo": string,
        "slots": [
          {
            "startTime": "HH:mm",
            "endTime": "HH:mm",
            "courtCount": number,
            "maxPlayers": number,
            "note": string
          }
        ],
        "participants": [
          {
            "name": string,
            "startTime": HH:mm,
            "endTime": HH:mm,
            "note": string
          }
        ],
        "waitlist": [
          {
            "name": string,
            "note": string
          }
        ]
      }
      `;
    const userPrompt = `
        Parse this badminton session text:

        ${text}
    `;
    const response = await openai.responses.create({
      model: "gpt-4.1-nano",
      input: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: text,
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "session_parse_result",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string" },
              date: { type: "string" },
              subtitle: { type: "string" },
              capacity: { type: "number" },
              additionalInfo: { type: "string" },

              slots: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    startTime: { type: "string" },
                    endTime: { type: "string" },
                    courtCount: { type: "number" },
                    maxPlayers: { type: "number" },
                    note: { type: "string" },
                  },
                  required: [
                    "startTime",
                    "endTime",
                    "courtCount",
                    "maxPlayers",
                    "note",
                  ],
                },
              },

              participants: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    name: { type: "string" },
                    startTime: { type: "string" },
                    endTime: { type: "string" },
                    note: { type: "string" },
                  },
                  required: ["name", "startTime", "endTime", "note"],
                },
              },

              waitlist: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    name: { type: "string" },
                    note: { type: "string" },
                  },
                  required: ["name", "note"],
                },
              },
            },
            required: [
              "title",
              "date",
              "subtitle",
              "capacity",
              "additionalInfo",
              "slots",
              "participants",
              "waitlist",
            ],
          },
        },
      },
    });

    res.json(JSON.parse(response.output_text));
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "AI parse failed" });
  }
});

app.listen(8080, () => {
  console.log("Backend läuft auf http://localhost:8080");
});
