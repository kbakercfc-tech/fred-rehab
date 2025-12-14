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
    let sql = 'SELECT * FROM exercises';
    const params = [];
    const conditions = [];

    if (req.query.startDate && req.query.endDate) {
        conditions.push('date BETWEEN ? AND ?');
        params.push(req.query.startDate, req.query.endDate);
    } else if (req.query.date) { // Keep existing single date filter
        conditions.push('date = ?');
        params.push(req.query.date);
    }

    if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY date DESC';

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
    let sql = 'SELECT id, date, quantity, comments FROM steps';
    const params = [];
    const conditions = [];

    if (req.query.startDate && req.query.endDate) {
        conditions.push('date BETWEEN ? AND ?');
        params.push(req.query.startDate, req.query.endDate);
    } else if (req.query.date) { // Keep existing single date filter
        conditions.push('date = ?');
        params.push(req.query.date);
    }

    if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY date DESC';

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

app.delete('/api/videos/:id', (req, res) => {
    const videoId = req.params.id;
    db.get('SELECT filename, filepath FROM videos WHERE id = ?', [videoId], (err, row) => {
        if (err) {
            console.error("Error fetching video to delete:", err.message);
            return res.status(500).send("Failed to fetch video for deletion.");
        }
        if (!row) {
            return res.status(404).send("Video not found.");
        }

        const fs = require('fs');
        const videoFilePath = path.join(__dirname, 'public', row.filepath); // Full path to the file

        fs.unlink(videoFilePath, (err) => {
            if (err && err.code !== 'ENOENT') { // ENOENT means file not found, which is fine if DB entry is also gone
                console.error("Error deleting video file from filesystem:", err);
                // Even if file deletion fails, try to remove from DB
            } else if (!err) {
                console.log(`Successfully deleted file: ${videoFilePath}`);
            }

            db.run('DELETE FROM videos WHERE id = ?', [videoId], function(err) {
                if (err) {
                    console.error("Error deleting video from database:", err.message);
                    return res.status(500).send("Failed to delete video from database.");
                }
                res.status(200).send("Video deleted successfully.");
            });
        });
    });
});

// Clear History endpoint
app.delete('/api/history', (req, res) => {
    db.serialize(() => {
        db.run('DELETE FROM exercises', (err) => {
            if (err) {
                console.error("Error clearing exercises table:", err.message);
                return res.status(500).send("Failed to clear exercises history.");
            }
        });
        db.run('DELETE FROM steps', (err) => {
            if (err) {
                console.error("Error clearing steps table:", err.message);
                return res.status(500).send("Failed to clear steps history.");
            }
            res.status(200).send("All history cleared successfully.");
        });
    });
});

// Batch save data endpoint
app.post('/api/batch-save-data', bodyParser.json(), (req, res) => {
    const dataToSave = req.body; // Expecting an array of data objects

    if (!Array.isArray(dataToSave)) {
        return res.status(400).send('Request body must be an array of data objects.');
    }

    db.serialize(() => {
        db.run('BEGIN TRANSACTION;');
        const stmtExerciseDelete = db.prepare('DELETE FROM exercises WHERE date = ?');
        const stmtExerciseInsert = db.prepare('INSERT INTO exercises (done, quantity, date) VALUES (?, ?, ?)');
        const stmtStepsDelete = db.prepare('DELETE FROM steps WHERE date = ?');
        const stmtStepsInsert = db.prepare('INSERT INTO steps (quantity, date, comments) VALUES (?, ?, ?)');

        dataToSave.forEach(data => {
            const { date, exerciseDone, repetitions, stepsCount, comments } = data;

            // Save Exercise data
            stmtExerciseDelete.run(date);
            if (exerciseDone && exerciseDone !== 'No') { // Only insert if exercise was done
                stmtExerciseInsert.run(exerciseDone, repetitions, date);
            }
            
            // Save Steps data
            stmtStepsDelete.run(date);
            if (stepsCount > 0 || comments) { // Only insert if steps or comments are provided
                stmtStepsInsert.run(stepsCount, date, comments);
            }
        });

        stmtExerciseDelete.finalize();
        stmtExerciseInsert.finalize();
        stmtStepsDelete.finalize();
        stmtStepsInsert.finalize();

        db.run('COMMIT;', (err) => {
            if (err) {
                db.run('ROLLBACK;');
                console.error("Error committing batch save transaction:", err.message);
                return res.status(500).send("Failed to save all data.");
            }
            res.status(200).send("All data saved successfully.");
        });
    });
});


app.get('/enter-data-tabular.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'enter-data-tabular.html'));
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