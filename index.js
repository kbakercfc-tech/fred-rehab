const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const multer = require('multer');
require('dotenv').config();
const FitbitApiClient = require("fitbit-node");
const AdmZip = require("adm-zip");
const fs = require("fs");
const cron = require("node-cron");

const app = express();
const port = process.env.PORT || 3000; // Use process.env.PORT for Render

// Backup directory setup
const BACKUP_DIR = process.env.DATABASE_PATH ? '/var/data/backups' : path.join(__dirname, 'backups');
if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// Fitbit setup
const fitbitClient = new FitbitApiClient({
    clientId: process.env.FITBIT_CLIENT_ID,
    clientSecret: process.env.FITBIT_CLIENT_SECRET,
    apiVersion: '1.2'
});
const FITBIT_CALLBACK_URL = process.env.FITBIT_CALLBACK_URL || `http://localhost:${port}/auth/fitbit/callback`;

// Set up the database
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'rehab.db');
const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        console.error(`Error connecting to database at ${DB_PATH}:`, err.message);
    }
    console.log(`Connected to the rehab database at ${DB_PATH}.`);
});

// Set up multer for file uploads
const UPLOAD_DESTINATION_RELATIVE = process.env.UPLOAD_PATH || 'public/uploads/';
const UPLOAD_DESTINATION = path.join(__dirname, UPLOAD_DESTINATION_RELATIVE);
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
        weights_done TEXT NOT NULL
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
    db.run(`CREATE TABLE IF NOT EXISTS fitbit_tokens (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )`, () => {
        db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('backup_frequency', 'off')");
    });
});

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
// Additionally, serve uploaded video files from the UPLOAD_DESTINATION via the /uploads route
// This ensures that even if UPLOAD_PATH is set outside 'public', videos are accessible.
app.use('/uploads', express.static(UPLOAD_DESTINATION));

// API Endpoints
app.get('/api/exercises', (req, res) => {
    let sql = 'SELECT id, done, date, weights_done FROM exercises';
    const params = [];
    const conditions = [];

    if (req.query.startDate && req.query.endDate) {
        conditions.push('date BETWEEN ? AND ?');
        params.push(req.query.startDate, req.query.endDate);
        sql += ' WHERE ' + conditions.join(' AND ');
        sql += ' ORDER BY date DESC'; // Keep DESC for filtered ranges
    } else if (req.query.date) {
        conditions.push('date = ?');
        params.push(req.query.date);
        sql += ' WHERE ' + conditions.join(' AND ');
        sql += ' ORDER BY date DESC'; // Keep DESC for single date filter
    }
    // If no date parameters, no WHERE clause and no ORDER BY.
    // The client will handle sorting/ranging.

    db.all(sql, params, (err, rows) => {
        if (err) {
            console.error("API Error - /api/exercises:", err.message); // Debug log
            res.status(500).send(err.message);
            return;
        }
        console.log("API Response - /api/exercises (rows):", rows); // Debug log
        res.json(rows);
    });
});

app.post('/api/exercises', (req, res) => {
    const { done, weights_done, date } = req.body; // Change quantity to weights_done
    db.serialize(() => {
        db.run('DELETE FROM exercises WHERE date = ?', [date], function(err) {
            if (err) {
                res.status(500).send(err.message);
                return;
            }
        });
        db.run('INSERT INTO exercises (done, weights_done, date) VALUES (?, ?, ?)', [done, weights_done, date], function(err) {
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
        sql += ' WHERE ' + conditions.join(' AND ');
        sql += ' ORDER BY date DESC'; // Keep DESC for filtered ranges
    } else if (req.query.date) {
        conditions.push('date = ?');
        params.push(req.query.date);
        sql += ' WHERE ' + conditions.join(' AND ');
        sql += ' ORDER BY date DESC'; // Keep DESC for single date filter
    }
    // If no date parameters, no WHERE clause and no ORDER BY.
    // The client will handle sorting/ranging.

    db.all(sql, params, (err, rows) => {
        if (err) {
            console.error("API Error - /api/steps:", err.message); // Debug log
            res.status(500).send(err.message);
            return;
        }
        console.log("API Response - /api/steps (rows):", rows); // Debug log
        res.json(rows);
    });
});

app.get('/api/steps/max', (req, res) => {
    let sql = 'SELECT MAX(quantity) as max_steps FROM steps';
    let params = [];
    if (req.query.exclude_dates) {
        const dates = req.query.exclude_dates.split(',');
        if (dates.length > 0 && dates[0]) { // Ensure there are dates to exclude
            const placeholders = dates.map(() => '?').join(',');
            sql += ` WHERE date NOT IN (${placeholders})`;
            params = dates;
        }
    }
    db.get(sql, params, (err, row) => {
        if (err) {
            res.status(500).send(err.message);
            return;
        }
        res.json(row);
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
        const stmtExerciseInsert = db.prepare('INSERT INTO exercises (done, weights_done, date) VALUES (?, ?, ?)'); // Changed quantity to weights_done
        const stmtStepsDelete = db.prepare('DELETE FROM steps WHERE date = ?');
        const stmtStepsInsert = db.prepare('INSERT INTO steps (quantity, date, comments) VALUES (?, ?, ?)');

        dataToSave.forEach(data => {
            const { date, exerciseDone, weightsDone, stepsCount, comments } = data; // Changed repetitions to weightsDone

            // Save Exercise data
            stmtExerciseDelete.run(date);
            // Always insert exercise data, regardless of exerciseDone status
            stmtExerciseInsert.run(exerciseDone, weightsDone, date);
            
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

// Fitbit OAuth Routes
app.get("/auth/fitbit", (req, res) => {
    const state = req.query.from || '/';
    res.redirect(fitbitClient.getAuthorizeUrl('activity', FITBIT_CALLBACK_URL, state));
});

app.get("/auth/fitbit/callback", (req, res) => {
    const state = req.query.state || '/';
    fitbitClient.getAccessToken(req.query.code, FITBIT_CALLBACK_URL).then(result => {
        const { access_token, refresh_token, expires_in } = result;
        const expires_at = Math.floor(Date.now() / 1000) + expires_in;

        db.run('REPLACE INTO fitbit_tokens (id, access_token, refresh_token, expires_at) VALUES (1, ?, ?, ?)',
            [access_token, refresh_token, expires_at], (err) => {
                if (err) {
                    console.error("Error saving Fitbit tokens:", err.message);
                    return res.status(500).send("Error saving Fitbit tokens.");
                }
                res.redirect(`${state}?fitbit=connected`);
            });
    }).catch(err => {
        console.error("Fitbit Auth Error:", err);
        res.status(500).send("Fitbit Authentication Failed.");
    });
});

app.get('/api/fitbit/status', (req, res) => {
    db.get('SELECT id FROM fitbit_tokens WHERE id = 1', (err, row) => {
        if (err) return res.status(500).send(err.message);
        res.json({ connected: !!row });
    });
});

app.post('/api/fitbit/disconnect', (req, res) => {
    console.log("Attempting to disconnect Fitbit...");
    db.run('DELETE FROM fitbit_tokens WHERE id = 1', function(err) {
        if (err) {
            console.error("Disconnect Error:", err.message);
            return res.status(500).send("Failed to disconnect Fitbit.");
        }
        console.log("Successfully deleted Fitbit tokens. Rows affected:", this.changes);
        res.status(200).send("Disconnected successfully.");
    });
});

app.post('/api/fitbit/sync', (req, res) => {
    const { date } = req.body;
    db.get('SELECT * FROM fitbit_tokens WHERE id = 1', async (err, row) => {
        if (err || !row) return res.status(401).send("Fitbit not connected.");

        let { access_token, refresh_token, expires_at } = row;

        // Refresh token if expired
        if (Date.now() / 1000 > expires_at - 60) {
            try {
                const result = await fitbitClient.refreshAccessToken(access_token, refresh_token);
                access_token = result.access_token;
                refresh_token = result.refresh_token;
                expires_at = Math.floor(Date.now() / 1000) + result.expires_in;

                db.run('UPDATE fitbit_tokens SET access_token = ?, refresh_token = ?, expires_at = ? WHERE id = 1',
                    [access_token, refresh_token, expires_at]);
            } catch (refreshErr) {
                console.error("Error refreshing Fitbit token:", refreshErr);
                return res.status(401).send("Fitbit session expired. Please reconnect.");
            }
        }

        fitbitClient.get(`/activities/steps/date/${date}/1d.json`, access_token).then(results => {
            const steps = results[0]["activities-steps"][0].value;
            res.json({ steps: parseInt(steps, 10) });
        }).catch(apiErr => {
            console.error("Fitbit API Error:", apiErr);
            res.status(500).send("Failed to fetch steps from Fitbit.");
        });
    });
});

// Data Backup Endpoint
app.get('/api/backup', (req, res) => {
    try {
        const zip = new AdmZip();
        
        // Add database
        if (fs.existsSync(DB_PATH)) {
            zip.addLocalFile(DB_PATH);
        }

        // Add uploads
        if (fs.existsSync(UPLOAD_DESTINATION)) {
            zip.addLocalFolder(UPLOAD_DESTINATION, "uploads");
        }

        const date = new Date().toISOString().slice(0, 10);
        const filename = `fred-rehab-backup-${date}.zip`;
        const buffer = zip.toBuffer();

        res.set('Content-Type', 'application/zip');
        res.set('Content-Disposition', `attachment; filename=${filename}`);
        res.send(buffer);
    } catch (err) {
        console.error("Backup Error:", err);
        res.status(500).send("Failed to create backup.");
    }
});

// Data Restore Endpoint
app.post('/api/restore', upload.single('backup'), (req, res) => {
    if (!req.file) return res.status(400).send("No backup file provided.");

    try {
        const zip = new AdmZip(req.file.path);
        
        // 1. Close DB connection
        db.close((err) => {
            if (err) console.error("Error closing DB for restore:", err);

            // 2. Extract files
            // adm-zip's extractAllTo handles overwriting
            zip.extractEntryTo("rehab.db", path.dirname(DB_PATH), false, true);
            
            // Extract uploads folder contents
            const zipEntries = zip.getEntries();
            zipEntries.forEach(entry => {
                if (entry.entryName.startsWith("uploads/")) {
                    zip.extractEntryTo(entry, UPLOAD_DESTINATION, false, true);
                }
            });

            // 3. Re-open DB connection
            global.db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (openErr) => {
                if (openErr) console.error("Error re-opening DB:", openErr);
                
                // Cleanup temporary uploaded zip
                fs.unlinkSync(req.file.path);
                res.status(200).send("Data restored successfully! Please refresh the page.");
            });
        });
    } catch (err) {
        console.error("Restore Error:", err);
        res.status(500).send("Failed to restore backup.");
    }
});

// Settings API
app.get('/api/settings', (req, res) => {
    db.all('SELECT * FROM settings', (err, rows) => {
        if (err) return res.status(500).send(err.message);
        const settings = {};
        rows.forEach(row => settings[row.key] = row.value);
        res.json(settings);
    });
});

app.post('/api/settings', (req, res) => {
    const { key, value } = req.body;
    db.run('REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value], (err) => {
        if (err) return res.status(500).send(err.message);
        res.status(200).send("Setting updated.");
    });
});

// Automated Backups API
app.get('/api/backups/list', (req, res) => {
    fs.readdir(BACKUP_DIR, (err, files) => {
        if (err) return res.status(500).send("Failed to list backups.");
        const backups = files
            .filter(f => f.endsWith('.zip'))
            .map(f => ({
                filename: f,
                date: fs.statSync(path.join(BACKUP_DIR, f)).mtime
            }))
            .sort((a, b) => b.date - a.date);
        res.json(backups);
    });
});

app.get('/api/backups/download/:filename', (req, res) => {
    const filePath = path.join(BACKUP_DIR, req.params.filename);
    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).send("Backup not found.");
    }
});

app.post('/api/backups/run-now', async (req, res) => {
    try {
        await runAutomatedBackup();
        res.status(200).send("Automated backup triggered successfully.");
    } catch (err) {
        res.status(500).send("Failed to trigger backup.");
    }
});

// Helper function for automated backup
async function runAutomatedBackup() {
    try {
        console.log(`[${new Date().toISOString()}] Starting automated backup...`);
        const zip = new AdmZip();
        if (fs.existsSync(DB_PATH)) zip.addLocalFile(DB_PATH);
        if (fs.existsSync(UPLOAD_DESTINATION)) zip.addLocalFolder(UPLOAD_DESTINATION, "uploads");

        const date = new Date().toISOString().replace(/:/g, '-').slice(0, 19);
        const filename = `auto-backup-${date}.zip`;
        zip.writeZip(path.join(BACKUP_DIR, filename));

        // Cleanup: keep last 7
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith('auto-backup-'))
            .map(f => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtime }))
            .sort((a, b) => b.time - a.time);

        if (files.length > 7) {
            files.slice(7).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f.name)));
        }
        console.log(`Automated backup complete: ${filename}`);
    } catch (err) {
        console.error("Automated Backup Failed:", err);
    }
}

// CRON JOB: Run every day at 2:00 AM
cron.schedule('0 2 * * *', () => {
    db.get("SELECT value FROM settings WHERE key = 'backup_frequency'", (err, row) => {
        if (err || !row || row.value === 'off') return;

        const freq = row.value;
        const now = new Date();
        
        if (freq === 'daily') {
            runAutomatedBackup();
        } else if (freq === 'weekly' && now.getDay() === 0) { // Sunday
            runAutomatedBackup();
        } else if (freq === 'monthly' && now.getDate() === 1) { // 1st of month
            runAutomatedBackup();
        }
    });
});


app.get('/enter-data-tabular.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'enter-data-tabular.html'));
});

app.get('/help.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'help.html'));
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