import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;
const DB_HOST = process.env.DB_HOST;

app.get('/health', (req, res) => res.json({ ok: true }));
app.post('/api/users', (req, res) => res.json({ created: true }));
app.get('/api/users/:id', (req, res) => res.json({ id: req.params.id }));

const q = "SELECT id, name FROM users WHERE active = 1";
const q2 = "INSERT INTO audit_log (action) VALUES ('login')";

app.listen(PORT);
