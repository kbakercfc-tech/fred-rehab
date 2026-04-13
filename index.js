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
const session = require('express-session');

const app = express();
const port = process.env.PORT || 3000; // Use process.env.PORT for Render

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback-secret-for-local-only',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Auth mode: set AUTH_ENABLED=false in .env to disable login entirely (open access, everyone is editor)
const AUTH_ENABLED = process.env.AUTH_ENABLED !== 'false';

// Auth Middlewares
const requireLogin = (req, res, next) => {
    if (!AUTH_ENABLED) return next();
    if (!req.session.role) return res.redirect('/login.html');
    next();
};

const requireEditor = (req, res, next) => {
    if (!AUTH_ENABLED) return next();
    if (req.session.role !== 'editor') return res.status(403).send('Editor role required.');
    next();
};

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
let db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
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
    db.run(`CREATE TABLE IF NOT EXISTS achievements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        start_date TEXT NOT NULL,
        end_date TEXT
    )`, () => {
        // Migration: Check if old 'date' column exists and migrate to 'start_date'
        db.all(`PRAGMA table_info(achievements)`, (err, columns) => {
            if (err) return;
            const hasDate = columns.some(c => c.name === 'date');
            const hasStartDate = columns.some(c => c.name === 'start_date');
            
            if (hasDate && !hasStartDate) {
                // This shouldn't happen if CREATE TABLE IF NOT EXISTS worked with new schema, 
                // but for safety in SQLite environments where schema might be cached:
                db.serialize(() => {
                    db.run(`ALTER TABLE achievements ADD COLUMN start_date TEXT`);
                    db.run(`ALTER TABLE achievements ADD COLUMN end_date TEXT`);
                    db.run(`UPDATE achievements SET start_date = date`);
                    // We can't easily drop columns in old SQLite, so we'll just leave 'date'
                });
            } else if (!hasDate && !hasStartDate) {
                // New table was created with start_date already
            }
        });
    });
    db.run(`CREATE TABLE IF NOT EXISTS achievement_media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        achievement_id INTEGER NOT NULL,
        filename TEXT NOT NULL,
        filepath TEXT NOT NULL,
        media_type TEXT NOT NULL,
        FOREIGN KEY (achievement_id) REFERENCES achievements(id) ON DELETE CASCADE
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

// Auth Endpoints
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    const editorPassword = process.env.EDITOR_PASSWORD;
    const viewerPassword = process.env.VIEWER_PASSWORD;

    if (password === editorPassword) {
        req.session.role = 'editor';
        res.json({ success: true, role: 'editor' });
    } else if (password === viewerPassword) {
        req.session.role = 'viewer';
        res.json({ success: true, role: 'viewer' });
    } else {
        res.status(401).json({ success: false, message: 'Invalid password' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/user-status', (req, res) => {
    if (!AUTH_ENABLED) return res.json({ role: 'editor', authEnabled: false });
    res.json({ role: req.session.role || null, authEnabled: true });
});

// Serve login page without restriction
app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Special protection for Data Management (Editor only)
app.get('/data-management.html', requireLogin, requireEditor, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'data-management.html'));
});

app.get('/', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Additionally, serve uploaded video files from the UPLOAD_DESTINATION via the /uploads route
app.use('/uploads', requireLogin, express.static(UPLOAD_DESTINATION));

// API Endpoints - Protected
app.get('/api/exercises', requireLogin, (req, res) => {
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

app.post('/api/exercises', requireLogin, requireEditor, (req, res) => {
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

app.get('/api/steps', requireLogin, (req, res) => {
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

app.get('/api/steps/total', requireLogin, (req, res) => {
    const sql = 'SELECT quantity FROM steps';
    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error("Error fetching total steps:", err.message);
            res.status(500).send(err.message);
            return;
        }
        const total = rows.reduce((sum, row) => sum + (parseInt(row.quantity, 10) || 0), 0);
        console.log("Total steps calculated (manual sum):", total);
        res.json({ total_steps: total });
    });
});

app.get('/api/steps/club-status', requireLogin, (req, res) => {
    const sql = 'SELECT COUNT(*) as count FROM steps WHERE CAST(quantity AS INTEGER) >= 10000';
    db.get(sql, [], (err, row) => {
        if (err) {
            res.status(500).send(err.message);
            return;
        }
        const count = row.count || 0;
        let level = 'None';
        if (count >= 15) level = 'Gold';
        else if (count >= 10) level = 'Silver';
        else if (count >= 5) level = 'Bronze';
        else if (count >= 1) level = 'Member';
        
        res.json({ count, level });
    });
});

app.get('/api/steps/max', requireLogin, (req, res) => {
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

app.post('/api/steps', requireLogin, requireEditor, (req, res) => {
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

// Web Share Target fallback (service worker handles this when installed;
// this catches the rare case where the SW isn't active yet)
app.post('/share-target', requireLogin, (req, res) => {
    res.redirect('/exercise-videos.html');
});

// Video upload endpoints
app.get('/exercise-videos.html', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'exercise-videos.html'));
});

app.post('/upload-video', requireLogin, requireEditor, upload.single('video'), (req, res) => {
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

app.get('/api/videos', requireLogin, (req, res) => {
    db.all('SELECT * FROM videos ORDER BY upload_date DESC', (err, rows) => {
        if (err) {
            res.status(500).send(err.message);
            return;
        }
        res.json(rows);
    });
});

app.delete('/api/videos/:id', requireLogin, requireEditor, (req, res) => {
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
app.delete('/api/history', requireLogin, requireEditor, (req, res) => {
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
app.post('/api/batch-save-data', requireLogin, requireEditor, bodyParser.json(), (req, res) => {
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
app.get("/auth/fitbit", requireLogin, requireEditor, (req, res) => {
    // 1. Try 'from' query param
    // 2. Try 'Referer' header (the page you were just on)
    // 3. Default to '/'
    let fromPage = req.query.from;
    
    if (!fromPage && req.get('Referer')) {
        const url = new URL(req.get('Referer'));
        fromPage = url.pathname;
    }
    
    fromPage = fromPage || '/';
    
    console.log(`Fitbit Auth started from: ${fromPage}`);
    const authorizeUrl = fitbitClient.getAuthorizeUrl('activity', FITBIT_CALLBACK_URL, fromPage);
    res.redirect(authorizeUrl);
});

app.get("/auth/fitbit/callback", (req, res) => {
    const state = req.query.state || '/';
    console.log(`Fitbit Auth callback received. State (target page): ${state}`);
    
    fitbitClient.getAccessToken(req.query.code, FITBIT_CALLBACK_URL).then(result => {
        const { access_token, refresh_token, expires_in } = result;
        const expires_at = Math.floor(Date.now() / 1000) + expires_in;

        db.run('REPLACE INTO fitbit_tokens (id, access_token, refresh_token, expires_at) VALUES (1, ?, ?, ?)',
            [access_token, refresh_token, expires_at], (err) => {
                if (err) {
                    console.error("Error saving Fitbit tokens:", err.message);
                    return res.status(500).send("Error saving Fitbit tokens.");
                }
                console.log(`Redirecting user back to: ${state}`);
                res.redirect(`${state}?fitbit=connected`);
            });
    }).catch(err => {
        console.error("Fitbit Auth Error:", err);
        res.status(500).send("Fitbit Authentication Failed.");
    });
});

app.get('/api/fitbit/status', requireLogin, (req, res) => {
    db.get('SELECT id FROM fitbit_tokens WHERE id = 1', (err, row) => {
        if (err) return res.status(500).send(err.message);
        res.json({ connected: !!row });
    });
});

app.post('/api/fitbit/disconnect', requireLogin, requireEditor, (req, res) => {
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

// Promisify db helpers for use in async functions
const dbGet = (sql, params) => new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
const dbRun = (sql, params) => new Promise((resolve, reject) =>
    db.run(sql, params, (err) => err ? reject(err) : resolve()));

// Helper: fetch yesterday's steps from Fitbit and save to DB
async function runFitbitAutoSync() {
    console.log(`[${new Date().toISOString()}] Starting Fitbit auto-sync...`);

    const tokenRow = await dbGet('SELECT * FROM fitbit_tokens WHERE id = 1', []);
    if (!tokenRow) {
        console.log('[Fitbit Auto-Sync] No Fitbit token found, skipping.');
        return { skipped: true, reason: 'Fitbit is not connected' };
    }

    let { access_token, refresh_token, expires_at } = tokenRow;

    if (Date.now() / 1000 > expires_at - 60) {
        console.log('[Fitbit Auto-Sync] Token expired, refreshing...');
        const refreshed = await fitbitClient.refreshAccessToken(access_token, refresh_token);
        access_token = refreshed.access_token;
        refresh_token = refreshed.refresh_token;
        expires_at = Math.floor(Date.now() / 1000) + refreshed.expires_in;
        await dbRun('UPDATE fitbit_tokens SET access_token = ?, refresh_token = ?, expires_at = ? WHERE id = 1',
            [access_token, refresh_token, expires_at]);
    }

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().slice(0, 10);

    const results = await fitbitClient.get(`/activities/steps/date/${dateStr}/1d.json`, access_token);
    const body = results[0];
    if (!body['activities-steps'] || !body['activities-steps'][0]) {
        throw new Error('Unexpected Fitbit API response: ' + JSON.stringify(body));
    }
    const steps = parseInt(body['activities-steps'][0].value, 10);

    // Preserve user-entered comments; only auto-set comment if empty or previously auto-sourced
    const existing = await dbGet('SELECT comments FROM steps WHERE date = ?', [dateStr]);
    const preserveComment = existing && existing.comments && !existing.comments.includes('Auto-sourced from Fitbit');
    const comment = preserveComment ? existing.comments : 'Auto-sourced from Fitbit';

    await dbRun('DELETE FROM steps WHERE date = ?', [dateStr]);
    await dbRun('INSERT INTO steps (date, quantity, comments) VALUES (?, ?, ?)', [dateStr, steps, comment]);
    await dbRun("REPLACE INTO settings (key, value) VALUES ('fitbit_last_sync', ?)", [new Date().toISOString()]);

    console.log(`[Fitbit Auto-Sync] Saved ${steps} steps for ${dateStr}`);
    return { date: dateStr, steps };
}

app.post('/api/fitbit/auto-sync-now', requireLogin, requireEditor, async (req, res) => {
    try {
        const result = await runFitbitAutoSync();
        if (result.skipped) return res.status(400).json({ error: result.reason });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message || 'Sync failed' });
    }
});

app.post('/api/fitbit/sync', requireLogin, requireEditor, (req, res) => {
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
app.get('/api/backup', requireLogin, requireEditor, (req, res) => {
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
app.post('/api/restore', requireLogin, requireEditor, upload.single('backup'), (req, res) => {
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
            db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (openErr) => {
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
app.get('/api/settings', requireLogin, (req, res) => {
    db.all('SELECT * FROM settings', (err, rows) => {
        if (err) return res.status(500).send(err.message);
        const settings = {};
        rows.forEach(row => settings[row.key] = row.value);
        res.json(settings);
    });
});

app.post('/api/settings', requireLogin, requireEditor, (req, res) => {
    const { key, value } = req.body;
    db.run('REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value], (err) => {
        if (err) return res.status(500).send(err.message);
        res.status(200).send("Setting updated.");
    });
});

// Automated Backups API
app.get('/api/backups/list', requireLogin, (req, res) => {
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

app.get('/api/backups/download/:filename', requireLogin, requireEditor, (req, res) => {
    const filePath = path.join(BACKUP_DIR, req.params.filename);
    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).send("Backup not found.");
    }
});

app.post('/api/backups/run-now', requireLogin, requireEditor, async (req, res) => {
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

// CRON JOB: Nightly Fitbit auto-sync at 2:00 AM GMT
cron.schedule('0 2 * * *', () => {
    db.get("SELECT value FROM settings WHERE key = 'fitbit_auto_sync'", (err, row) => {
        if (err || !row || row.value !== 'on') return;
        runFitbitAutoSync().catch(err => console.error('[Fitbit Auto-Sync Cron] Error:', err));
    });
}, { timezone: 'GMT' });

// CRON JOB: Automated backup at 2:00 AM GMT
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


// Achievement endpoints
app.get('/achievements.html', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'achievements.html'));
});

app.get('/api/achievements', requireLogin, (req, res) => {
    const sql = `
        SELECT a.*, 
               (SELECT json_group_array(json_object('id', m.id, 'filepath', m.filepath, 'media_type', m.media_type))
                FROM achievement_media m 
                WHERE m.achievement_id = a.id) as media
        FROM achievements a 
        ORDER BY a.start_date DESC
    `;
    db.all(sql, [], (err, rows) => {
        if (err) {
            res.status(500).send(err.message);
            return;
        }
        // Parse the JSON string from the subquery
        const achievements = rows.map(row => ({
            ...row,
            media: JSON.parse(row.media)
        }));
        res.json(achievements);
    });
});

app.post('/api/achievements', requireLogin, requireEditor, upload.array('media'), (req, res) => {
    const { name, description, start_date, end_date } = req.body;
    const files = req.files || [];

    db.run('INSERT INTO achievements (name, description, start_date, end_date) VALUES (?, ?, ?, ?)',
        [name, description, start_date, end_date || null], function(err) {
            if (err) {
                console.error("Error inserting achievement:", err.message);
                return res.status(500).send('Error saving achievement.');
            }
            const achievementId = this.lastID;

            if (files.length === 0) {
                return res.status(201).json({ id: achievementId });
            }

            const mediaPromises = files.map(file => {
                const filename = file.filename;
                const filepath = '/uploads/' + filename;
                const mediaType = file.mimetype.startsWith('video/') ? 'video' : 'photo';
                
                return new Promise((resolve, reject) => {
                    db.run('INSERT INTO achievement_media (achievement_id, filename, filepath, media_type) VALUES (?, ?, ?, ?)',
                        [achievementId, filename, filepath, mediaType], function(err) {
                            if (err) reject(err);
                            else resolve();
                        });
                });
            });

            Promise.all(mediaPromises)
                .then(() => res.status(201).json({ id: achievementId }))
                .catch(err => {
                    console.error("Error saving media metadata:", err.message);
                    res.status(500).send('Error saving media metadata.');
                });
        });
});

app.put('/api/achievements/:id', requireLogin, requireEditor, (req, res) => {
    const { id } = req.params;
    const { name, description, start_date, end_date } = req.body || {};
    if (!name || !start_date) return res.status(400).send('Name and start date are required.');
    db.run(
        'UPDATE achievements SET name = ?, description = ?, start_date = ?, end_date = ? WHERE id = ?',
        [name, description || null, start_date, end_date || null, id],
        function(err) {
            if (err) return res.status(500).send(err.message);
            if (this.changes === 0) return res.status(404).send('Achievement not found.');
            res.status(200).send('Achievement updated.');
        }
    );
});

app.delete('/api/achievements/:id', requireLogin, requireEditor, (req, res) => {
    const achievementId = req.params.id;
    
    // First get all media associated with this achievement to delete files
    db.all('SELECT filepath FROM achievement_media WHERE achievement_id = ?', [achievementId], (err, rows) => {
        if (err) {
            console.error("Error fetching media for deletion:", err.message);
            return res.status(500).send("Failed to fetch media for deletion.");
        }

        const fs = require('fs');
        rows.forEach(row => {
            const fullPath = path.join(__dirname, 'public', row.filepath);
            fs.unlink(fullPath, (err) => {
                if (err && err.code !== 'ENOENT') {
                    console.error("Error deleting file:", fullPath, err);
                }
            });
        });

        // Now delete from database (cascading delete if enabled, but let's be explicit if not)
        db.serialize(() => {
            db.run('DELETE FROM achievement_media WHERE achievement_id = ?', [achievementId]);
            db.run('DELETE FROM achievements WHERE id = ?', [achievementId], function(err) {
                if (err) {
                    console.error("Error deleting achievement:", err.message);
                    return res.status(500).send("Failed to delete achievement.");
                }
                res.status(200).send("Achievement deleted successfully.");
            });
        });
    });
});

app.get('/enter-data-tabular.html', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'enter-data-tabular.html'));
});

app.get('/calendar-view.html', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'calendar-view.html'));
});

app.get('/steps-graph.html', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'steps-graph.html'));
});

app.get('/history.html', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'history.html'));
});

app.get('/help.html', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'help.html'));
});

app.listen(port, () => {
    console.log(`Fred Rehab app listening at http://localhost:${port}`);
    console.log(`Database path: ${DB_PATH}`);
    console.log(`Upload destination: ${UPLOAD_DESTINATION}`);
});