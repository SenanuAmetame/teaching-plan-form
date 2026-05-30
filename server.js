require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { DatabaseSync } = require('node:sqlite');
const basicAuth = require('express-basic-auth');
const archiver = require('archiver');
const path = require('path');
const fs = require('fs');
const { Resend } = require('resend');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const NOTIFY_EMAILS = (process.env.NOTIFY_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);

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
app.post('/submit', upload.single('file'), async (req, res) => {
  try {
    const fullName = (req.body.full_name || '').trim();
    if (!fullName) return res.status(400).json({ error: 'Full name is required.' });
    if (!req.file) return res.status(400).json({ error: 'A file upload is required.' });

    db.prepare(`
      INSERT INTO submissions (full_name, original_filename, stored_filename, mime_type, file_size)
      VALUES (?, ?, ?, ?, ?)
    `).run(fullName, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size);

    res.json({ success: true });

    // Send email notification (non-blocking — doesn't affect the user's response)
    if (resend && NOTIFY_EMAILS.length) {
      try {
        const fileBuffer = fs.readFileSync(req.file.path);
        const submittedAt = new Date().toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' });

        await resend.emails.send({
          from: 'Salem Teaching Plan <onboarding@resend.dev>',
          to: NOTIFY_EMAILS,
          subject: `New Teaching Plan Submitted — ${fullName}`,
          html: `
            <div style="font-family:sans-serif;max-width:560px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
              <div style="background:#3730a3;padding:24px;text-align:center;">
                <h1 style="color:#fff;margin:0;font-size:20px;">Salem School</h1>
                <p style="color:#c7d2fe;margin:4px 0 0;font-size:14px;">Teaching Plan Submission</p>
              </div>
              <div style="padding:28px;">
                <p style="margin:0 0 20px;font-size:15px;color:#1e293b;">A new teaching plan has been submitted:</p>
                <table style="width:100%;border-collapse:collapse;font-size:14px;">
                  <tr>
                    <td style="padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-weight:600;color:#64748b;width:130px;">Teacher</td>
                    <td style="padding:10px 12px;border:1px solid #e2e8f0;color:#1e293b;">${fullName}</td>
                  </tr>
                  <tr>
                    <td style="padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-weight:600;color:#64748b;">File</td>
                    <td style="padding:10px 12px;border:1px solid #e2e8f0;color:#1e293b;">${req.file.originalname}</td>
                  </tr>
                  <tr>
                    <td style="padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-weight:600;color:#64748b;">Submitted</td>
                    <td style="padding:10px 12px;border:1px solid #e2e8f0;color:#1e293b;">${submittedAt}</td>
                  </tr>
                </table>
                <p style="margin:20px 0 0;font-size:13px;color:#64748b;">The file is attached to this email. You can also view all submissions in the admin dashboard.</p>
              </div>
            </div>
          `,
          attachments: [{
            filename: req.file.originalname,
            content: fileBuffer
          }]
        });
        console.log(`Email sent to ${NOTIFY_EMAILS.join(', ')} for submission by ${fullName}`);
      } catch (emailErr) {
        console.error('Email notification error:', emailErr.message);
      }
    }
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
