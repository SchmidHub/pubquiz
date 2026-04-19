const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const DATA_FILE = path.join(__dirname, 'data', 'questions.json');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');

// Ensure data file exists
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ questions: [] }, null, 2));
}

// Game state (in-memory)
let gameState = {
  activeQuestionId: null,
  showAnswer: false,
  playerAnswers: {}, // { playerId: { name, answer, timestamp } }
  scores: {},        // { playerId: { name, points } }
  answersScored: false,
};

// Connected players { playerId: { name } }
let players = {};

// Helpers
function loadQuestions() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
}

function saveQuestions(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getActiveQuestion() {
  if (!gameState.activeQuestionId) return null;
  const { questions } = loadQuestions();
  return questions.find(q => q.id === gameState.activeQuestionId) || null;
}

function broadcastToAll(message) {
  const payload = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

function getQuestionType(q) {
  if (q.type) return q.type;
  if (q.options && q.options.length > 0) return 'multiple';
  if (q.correctAnswerNumber != null) return 'estimate';
  return 'freetext';
}

function buildGameUpdate() {
  const question = getActiveQuestion();
  return {
    type: 'game_update',
    activeQuestion: question
      ? {
          id: question.id,
          text: question.text,
          image: question.image || null,
          options: question.options,
          type: getQuestionType(question),
          // only send correct answer if showing
          correctAnswer: gameState.showAnswer ? question.correctAnswer : undefined,
          correctAnswerText: gameState.showAnswer ? (question.correctAnswerText || null) : undefined,
          correctAnswerNumber: gameState.showAnswer ? (question.correctAnswerNumber != null ? question.correctAnswerNumber : null) : undefined,
        }
      : null,
    showAnswer: gameState.showAnswer,
    scores: gameState.scores,
    players: Object.entries(players).map(([pid, p]) => ({
      playerId: pid,
      name: p.name,
      hasAnswered: !!gameState.playerAnswers[pid],
    })),
    playerAnswers: gameState.playerAnswers,
  };
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// File upload
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Nur Bilder erlaubt'));
  },
});

// ── REST API ──────────────────────────────────────────────

// Get all questions
app.get('/api/questions', (req, res) => {
  res.json(loadQuestions());
});

// Create question
app.post('/api/questions', (req, res) => {
  const { text, options, correctAnswer, correctAnswerText, type, correctAnswerNumber } = req.body;
  if (!text || typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ error: 'Fragetext erforderlich' });
  }
  const data = loadQuestions();
  const question = {
    id: uuidv4(),
    text: text.trim(),
    image: null,
    type: type || 'freetext',
    options: Array.isArray(options) ? options.filter(o => o && o.trim()) : [],
    correctAnswer: correctAnswer !== undefined ? correctAnswer : null,
    correctAnswerText: correctAnswerText ? correctAnswerText.trim() : null,
    correctAnswerNumber: correctAnswerNumber != null ? Number(correctAnswerNumber) : null,
    createdAt: new Date().toISOString(),
  };
  data.questions.push(question);
  saveQuestions(data);
  res.status(201).json(question);
});

// Update question
app.put('/api/questions/:id', (req, res) => {
  const data = loadQuestions();
  const idx = data.questions.findIndex(q => q.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Frage nicht gefunden' });

  const { text, options, correctAnswer, correctAnswerText, type, correctAnswerNumber } = req.body;
  if (text !== undefined) data.questions[idx].text = text.trim();
  if (options !== undefined) data.questions[idx].options = Array.isArray(options) ? options.filter(o => o && o.trim()) : [];
  if (correctAnswer !== undefined) data.questions[idx].correctAnswer = correctAnswer;
  if (correctAnswerText !== undefined) data.questions[idx].correctAnswerText = correctAnswerText ? correctAnswerText.trim() : null;
  if (type !== undefined) data.questions[idx].type = type;
  if (correctAnswerNumber !== undefined) data.questions[idx].correctAnswerNumber = correctAnswerNumber != null ? Number(correctAnswerNumber) : null;

  saveQuestions(data);
  res.json(data.questions[idx]);
});

// Delete question
app.delete('/api/questions/:id', (req, res) => {
  const data = loadQuestions();
  const idx = data.questions.findIndex(q => q.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Frage nicht gefunden' });

  const [removed] = data.questions.splice(idx, 1);
  // Clean up image
  if (removed.image) {
    const imgPath = path.join(__dirname, 'public', removed.image);
    if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
  }
  saveQuestions(data);

  if (gameState.activeQuestionId === req.params.id) {
    gameState.activeQuestionId = null;
    gameState.showAnswer = false;
    gameState.playerAnswers = {};
    broadcastToAll(buildGameUpdate());
  }
  res.json({ ok: true });
});

// Upload image for question
app.post('/api/questions/:id/image', upload.single('image'), (req, res) => {
  const data = loadQuestions();
  const question = data.questions.find(q => q.id === req.params.id);
  if (!question) return res.status(404).json({ error: 'Frage nicht gefunden' });

  // Remove old image
  if (question.image) {
    const old = path.join(__dirname, 'public', question.image);
    if (fs.existsSync(old)) fs.unlinkSync(old);
  }

  question.image = `/uploads/${req.file.filename}`;
  saveQuestions(data);
  res.json({ image: question.image });
});

// Remove image from question
app.delete('/api/questions/:id/image', (req, res) => {
  const data = loadQuestions();
  const question = data.questions.find(q => q.id === req.params.id);
  if (!question) return res.status(404).json({ error: 'Frage nicht gefunden' });

  if (question.image) {
    const imgPath = path.join(__dirname, 'public', question.image);
    if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
    question.image = null;
    saveQuestions(data);
  }
  res.json({ ok: true });
});

// ── WebSocket ─────────────────────────────────────────────

wss.on('connection', (ws) => {
  // Send current state immediately
  ws.send(JSON.stringify(buildGameUpdate()));

  ws.on('close', () => {
    if (ws._playerId && players[ws._playerId]) {
      delete players[ws._playerId];
      broadcastToAll(buildGameUpdate());
    }
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // Master: set active question
      case 'master_set_question': {
        const { questionId } = msg;
        const { questions } = loadQuestions();
        const found = questions.find(q => q.id === questionId);
        if (!found && questionId !== null) break;
        gameState.activeQuestionId = questionId;
        gameState.showAnswer = false;
        gameState.playerAnswers = {};
        gameState.answersScored = false;
        broadcastToAll(buildGameUpdate());
        break;
      }

      // Master: reveal answer
      case 'master_reveal_answer': {
        if (!gameState.answersScored) {
          const question = getActiveQuestion();
          if (question) {
            const qType = getQuestionType(question);
            if (qType === 'estimate' && question.correctAnswerNumber != null) {
              const correct = Number(question.correctAnswerNumber);
              const parsed = Object.entries(gameState.playerAnswers).map(([pid, pa]) => ({
                pid, pa, val: parseFloat(String(pa.answer).replace(',', '.')),
              })).filter(x => !isNaN(x.val));
              if (parsed.length > 0) {
                const minDist = Math.min(...parsed.map(x => Math.abs(x.val - correct)));
                parsed.forEach(({ pid, pa, val }) => {
                  if (!gameState.scores[pid]) gameState.scores[pid] = { name: pa.name, points: 0 };
                  gameState.scores[pid].name = pa.name;
                  if (Math.abs(val - correct) === minDist) gameState.scores[pid].points += 1;
                });
              }
            } else {
              Object.entries(gameState.playerAnswers).forEach(([pid, pa]) => {
                let correct = false;
                const hasCorrectIdx = question.correctAnswer !== null && question.correctAnswer !== undefined;
                if (hasCorrectIdx && question.options && question.options.length > 0) {
                  correct = Number(pa.answer) === Number(question.correctAnswer);
                } else if (question.correctAnswerText) {
                  correct = String(pa.answer).toLowerCase().trim() === String(question.correctAnswerText).toLowerCase().trim();
                }
                if (!gameState.scores[pid]) gameState.scores[pid] = { name: pa.name, points: 0 };
                gameState.scores[pid].name = pa.name;
                if (correct) gameState.scores[pid].points += 1;
              });
            }
            gameState.answersScored = true;
          }
        }
        gameState.showAnswer = true;
        broadcastToAll(buildGameUpdate());
        break;
      }

      // Master: hide answer / reset round
      case 'master_hide_answer': {
        gameState.showAnswer = false;
        gameState.playerAnswers = {};
        gameState.answersScored = false;
        broadcastToAll(buildGameUpdate());
        break;
      }

      // Master: reset scores
      case 'master_reset_scores': {
        gameState.scores = {};
        broadcastToAll(buildGameUpdate());
        break;
      }

      // Player: join game
      case 'player_join': {
        const { playerId, playerName } = msg;
        if (!playerId) break;
        ws._playerId = playerId;
        players[playerId] = { name: playerName || 'Anonym' };
        broadcastToAll(buildGameUpdate());
        break;
      }

      // Player: submit answer
      case 'player_answer': {
        const { playerId, playerName, answer } = msg;
        if (!playerId || answer === undefined || answer === null || answer === '') break;
        // Register player if not yet known
        if (!players[playerId]) {
          players[playerId] = { name: playerName || 'Anonym' };
          ws._playerId = playerId;
        }
        gameState.playerAnswers[playerId] = {
          name: playerName || 'Anonym',
          answer,
          timestamp: Date.now(),
        };
        broadcastToAll(buildGameUpdate());
        break;
      }
    }
  });
});

// ── Start ─────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`PubQuiz läuft auf http://localhost:${PORT}`);
  console.log(`  Master: http://localhost:${PORT}/master.html`);
  console.log(`  Spieler: http://localhost:${PORT}/player.html`);
});
