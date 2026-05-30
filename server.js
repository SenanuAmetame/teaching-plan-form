require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { DatabaseSync } = require('node:sqlite');
const basicAuth = require('express-basic-auth');
const archiver = require('archiver');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';

// Ensure directories exist
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
[UPLOADS_DIR, DATA_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Database setup
const db = new DatabaseSync(path.join(DATA_DIR, 'submissions.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    stored_filename TEXT NOT NULL,
    mime_type TEXT,
    file_size INTEGER,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// File upload storage
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${unique}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100 MB
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Public: submit form ────────────────────────────────────────────────────────
app.post('/submit', upload.single('file'), (req, res) => {
  try {
    const fullName = (req.body.full_name || '').trim();
    if (!fullName) return res.status(400).json({ error: 'Full name is required.' });
    if (!req.file) return res.status(400).json({ error: 'A file upload is required.' });

    db.prepare(`
      INSERT INTO submissions (full_name, original_filename, stored_filename, mime_type, file_size)
      VALUES (?, ?, ?, ?, ?)
    `).run(fullName, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size);

    res.json({ success: true });
  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ── Admin auth middleware ──────────────────────────────────────────────────────
const adminAuth = basicAuth({
  users: { [ADMIN_USER]: ADMIN_PASSWORD },
  challenge: true,
  realm: 'Teaching Plan Admin'
});

// Admin page
app.get('/admin', adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Admin API: list all submissions
app.get('/admin/submissions', adminAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT id, full_name, original_filename, mime_type, file_size, uploaded_at FROM submissions ORDER BY uploaded_at DESC'
  ).all();
  res.json(rows);
});

// Admin API: download a single file
app.get('/admin/download/:id', adminAuth, (req, res) => {
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });

  const filePath = path.join(UPLOADS_DIR, sub.stored_filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File missing from disk.' });
  }

  res.download(filePath, sub.original_filename);
});

// Admin API: download all files as ZIP
app.get('/admin/download-all', adminAuth, (req, res) => {
  const submissions = db.prepare('SELECT * FROM submissions ORDER BY uploaded_at DESC').all();
  if (!submissions.length) {
    return res.status(404).json({ error: 'No submissions yet.' });
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="teaching-plans-${Date.now()}.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => { console.error('Archive error:', err); res.destroy(); });
  archive.pipe(res);

  submissions.forEach((sub, i) => {
    const filePath = path.join(UPLOADS_DIR, sub.stored_filename);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(sub.original_filename);
      const safeName = sub.full_name.replace(/[^a-z0-9\s]/gi, '_').trim().replace(/\s+/g, '_');
      archive.file(filePath, { name: `${String(i + 1).padStart(3, '0')}_${safeName}${ext}` });
    }
  });

  archive.finalize();
});

app.listen(PORT, () => {
  console.log('\n  Teaching Plan Form');
  console.log(`  Form:  http://localhost:${PORT}`);
  console.log(`  Admin: http://localhost:${PORT}/admin`);
  console.log(`  Login: ${ADMIN_USER} / ${ADMIN_PASSWORD}\n`);
});
