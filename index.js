const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const multer = require('multer');

const app = express();
const port = process.env.PORT || 3000; // Use process.env.PORT for Render

// Set up the database
const DB_PATH = process.env.DATABASE_PATH || './rehab.db';
const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        console.error(`Error connecting to database at ${DB_PATH}:`, err.message);
    }
    console.log(`Connected to the rehab database at ${DB_PATH}.`);
});

// Set up multer for file uploads
const UPLOAD_DESTINATION = process.env.UPLOAD_PATH || 'public/uploads/';
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // Ensure the upload directory exists
        const fs = require('fs');
        if (!fs.existsSync(UPLOAD_DESTINATION)) {
            fs.mkdirSync(UPLOAD_DESTINATION, { recursive: true });
        }
        cb(null, UPLOAD_DESTINATION)
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname)
    }
});
const upload = multer({ storage: storage });

// Create tables if they don't exist
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS exercises (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        done TEXT NOT NULL,
        date TEXT NOT NULL,
        quantity INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        comments TEXT
    )`, () => { // Callback function for CREATE TABLE steps
        // Add comments column if it doesn't exist
        db.all(`PRAGMA table_info(steps)`, (err, columns) => { // Changed to db.all to get rows
            if (err) {
                console.error("Error checking steps table info:", err.message);
                return;
            }
            const commentsColumnExists = columns.some(column => column.name === 'comments');
            if (!commentsColumnExists) {
                db.run(`ALTER TABLE steps ADD COLUMN comments TEXT`, (err) => {
                    if (err) {
                        console.error("Error adding comments column to steps table:", err.message);
                    } else {
                        console.log("Added 'comments' column to 'steps' table.");
                    }
                });
            }
        });
    });
    db.run(`CREATE TABLE IF NOT EXISTS videos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        filename TEXT NOT NULL,
        filepath TEXT NOT NULL,
        upload_date TEXT NOT NULL
    )`);
});

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// API Endpoints
app.get('/api/exercises', (req, res) => {
    let sql = 'SELECT * FROM exercises ORDER BY date DESC';
    const params = [];
    if (req.query.date) {
        sql = 'SELECT * FROM exercises WHERE date = ? ORDER BY id DESC';
        params.push(req.query.date);
    }
    db.all(sql, params, (err, rows) => {
        if (err) {
            res.status(500).send(err.message);
            return;
        }
        res.json(rows);
    });
});

app.post('/api/exercises', (req, res) => {
    const { done, quantity, date } = req.body;
    db.serialize(() => {
        db.run('DELETE FROM exercises WHERE date = ?', [date], function(err) {
            if (err) {
                res.status(500).send(err.message);
                return;
            }
        });
        db.run('INSERT INTO exercises (done, quantity, date) VALUES (?, ?, ?)', [done, quantity, date], function(err) {
            if (err) {
                res.status(500).send(err.message);
                return;
            }
            res.status(201).json({ id: this.lastID });
        });
    });
});

app.get('/api/steps', (req, res) => {
    let sql = 'SELECT id, date, quantity, comments FROM steps ORDER BY date DESC';
    const params = [];
    if (req.query.date) {
        sql = 'SELECT id, date, quantity, comments FROM steps WHERE date = ? ORDER BY id DESC';
        params.push(req.query.date);
    }
    db.all(sql, params, (err, rows) => {
        if (err) {
            res.status(500).send(err.message);
            return;
        }
        res.json(rows);
    });
});

app.post('/api/steps', (req, res) => {
    const { quantity, date, comments } = req.body;
    db.serialize(() => {
        db.run('DELETE FROM steps WHERE date = ?', [date], function(err) {
            if (err) {
                res.status(500).send(err.message);
                return;
            }
        });
        db.run('INSERT INTO steps (quantity, date, comments) VALUES (?, ?, ?)', [quantity, date, comments], function(err) {
            if (err) {
                res.status(500).send(err.message);
                return;
            }
            res.status(201).json({ id: this.lastID });
        });
    });
});

// Video upload endpoints
app.get('/exercise-videos.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'exercise-videos.html'));
});

app.post('/upload-video', upload.single('video'), (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }
    const { title } = req.body;
    const filename = req.file.filename;
    const filepath = '/uploads/' + filename; // Stored in public/uploads

    db.run('INSERT INTO videos (title, filename, filepath, upload_date) VALUES (?, ?, ?, ?)',
        [title, filename, filepath, new Date().toISOString().slice(0, 10)], function(err) {
            if (err) {
                console.error(err.message);
                return res.status(500).send('Error saving video metadata.');
            }
            res.status(201).send('Video uploaded and saved.');
        });
});

app.get('/api/videos', (req, res) => {
    db.all('SELECT * FROM videos ORDER BY upload_date DESC', (err, rows) => {
        if (err) {
            res.status(500).send(err.message);
            return;
        }
        res.json(rows);
    });
});


app.get('/calendar-view.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'calendar-view.html'));
});

app.get('/steps-graph.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'steps-graph.html'));
});

app.get('/history.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'history.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`Fred Rehab app listening at http://localhost:${port}`);
  console.log(`Database path: ${DB_PATH}`);
  console.log(`Upload destination: ${UPLOAD_DESTINATION}`);
});