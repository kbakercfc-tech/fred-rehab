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
const Anthropic = require('@anthropic-ai/sdk');

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
    db.run(`CREATE TABLE IF NOT EXISTS achievement_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        achievement_id INTEGER NOT NULL,
        update_date TEXT NOT NULL,
        comments TEXT,
        FOREIGN KEY (achievement_id) REFERENCES achievements(id) ON DELETE CASCADE
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS achievement_update_media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        update_id INTEGER NOT NULL,
        filename TEXT NOT NULL,
        filepath TEXT NOT NULL,
        media_type TEXT NOT NULL,
        FOREIGN KEY (update_id) REFERENCES achievement_updates(id) ON DELETE CASCADE
    )`, () => {
        // Migration: for each achievement with a start_date and no existing achievement_updates,
        // create an achievement_update record using the start_date.
        db.all(
            `SELECT a.id, a.start_date FROM achievements a
             WHERE a.start_date IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM achievement_updates u WHERE u.achievement_id = a.id)`,
            [],
            (err, achievements) => {
                if (err) {
                    console.error("Migration error (achievement_updates check):", err.message);
                    return;
                }
                achievements.forEach(achievement => {
                    db.run(
                        `INSERT INTO achievement_updates (achievement_id, update_date, comments) VALUES (?, ?, ?)`,
                        [achievement.id, achievement.start_date, ''],
                        function(err) {
                            if (err) {
                                console.error("Migration error (insert achievement_update):", err.message);
                                return;
                            }
                            const updateId = this.lastID;
                            // For each achievement_media record that doesn't yet have a matching
                            // achievement_update_media record (matched by filepath), create one.
                            db.all(
                                `SELECT am.id, am.filename, am.filepath, am.media_type
                                 FROM achievement_media am
                                 WHERE am.achievement_id = ?
                                   AND NOT EXISTS (
                                       SELECT 1 FROM achievement_update_media aum WHERE aum.filepath = am.filepath
                                   )`,
                                [achievement.id],
                                (err, mediaRows) => {
                                    if (err) {
                                        console.error("Migration error (achievement_media fetch):", err.message);
                                        return;
                                    }
                                    mediaRows.forEach(media => {
                                        db.run(
                                            `INSERT INTO achievement_update_media (update_id, filename, filepath, media_type) VALUES (?, ?, ?, ?)`,
                                            [updateId, media.filename, media.filepath, media.media_type],
                                            (err) => {
                                                if (err) {
                                                    console.error("Migration error (insert achievement_update_media):", err.message);
                                                }
                                            }
                                        );
                                    });
                                }
                            );
                        }
                    );
                });
            }
        );
    });
    db.run(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )`, () => {
        db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('backup_frequency', 'off')");
    });
    db.run(`CREATE TABLE IF NOT EXISTS story_sections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        phase TEXT,
        sort_date TEXT,
        display_order INTEGER DEFAULT 0
    )`);
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

app.post('/api/achievements', requireLogin, requireEditor, (req, res) => {
    const { name, description } = req.body || {};
    if (!name) return res.status(400).send('Achievement name is required.');
    const today = new Date().toISOString().slice(0, 10);
    db.run('INSERT INTO achievements (name, description, start_date) VALUES (?, ?, ?)',
        [name, description || null, today], function(err) {
            if (err) {
                console.error("Error inserting achievement:", err.message);
                return res.status(500).send('Error saving achievement.');
            }
            res.status(201).json({ id: this.lastID });
        });
});

app.put('/api/achievements/:id', requireLogin, requireEditor, (req, res) => {
    const { id } = req.params;
    const { name, description } = req.body || {};
    if (!name) return res.status(400).send('Achievement name is required.');
    db.run(
        'UPDATE achievements SET name = ?, description = ? WHERE id = ?',
        [name, description || null, id],
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

// Achievement Updates Endpoints

app.get('/api/achievement-updates/:achievementId', requireLogin, (req, res) => {
    const { achievementId } = req.params;
    const sql = `
        SELECT u.*,
               (SELECT json_group_array(json_object('id', m.id, 'filepath', m.filepath, 'media_type', m.media_type))
                FROM achievement_update_media m
                WHERE m.update_id = u.id) as media
        FROM achievement_updates u
        WHERE u.achievement_id = ?
        ORDER BY u.update_date DESC
    `;
    db.all(sql, [achievementId], (err, rows) => {
        if (err) {
            return res.status(500).send(err.message);
        }
        const updates = rows.map(row => ({
            ...row,
            media: JSON.parse(row.media)
        }));
        res.json(updates);
    });
});

app.post('/api/achievement-updates', requireLogin, requireEditor, upload.array('media'), (req, res) => {
    const { achievement_id, update_date, comments } = req.body;
    const files = req.files || [];

    db.run(
        'INSERT INTO achievement_updates (achievement_id, update_date, comments) VALUES (?, ?, ?)',
        [achievement_id, update_date, comments || ''],
        function(err) {
            if (err) {
                console.error("Error inserting achievement update:", err.message);
                return res.status(500).send('Error saving achievement update.');
            }
            const updateId = this.lastID;

            if (files.length === 0) {
                return res.status(201).json({ id: updateId });
            }

            const mediaPromises = files.map(file => {
                const filename = file.filename;
                const filepath = '/uploads/' + filename;
                const mediaType = file.mimetype.startsWith('video/') ? 'video' : 'photo';

                return new Promise((resolve, reject) => {
                    db.run(
                        'INSERT INTO achievement_update_media (update_id, filename, filepath, media_type) VALUES (?, ?, ?, ?)',
                        [updateId, filename, filepath, mediaType],
                        function(err) {
                            if (err) reject(err);
                            else resolve();
                        }
                    );
                });
            });

            Promise.all(mediaPromises)
                .then(() => res.status(201).json({ id: updateId }))
                .catch(err => {
                    console.error("Error saving update media metadata:", err.message);
                    res.status(500).send('Error saving update media metadata.');
                });
        }
    );
});

app.put('/api/achievement-updates/:id', requireLogin, requireEditor, (req, res) => {
    const { id } = req.params;
    const { update_date, comments } = req.body || {};
    if (!update_date) return res.status(400).send('update_date is required.');
    db.run(
        'UPDATE achievement_updates SET update_date = ?, comments = ? WHERE id = ?',
        [update_date, comments || '', id],
        function(err) {
            if (err) return res.status(500).send(err.message);
            if (this.changes === 0) return res.status(404).send('Achievement update not found.');
            res.status(200).send('Achievement update updated.');
        }
    );
});

app.delete('/api/achievement-updates/:id', requireLogin, requireEditor, (req, res) => {
    const updateId = req.params.id;

    db.all('SELECT filepath FROM achievement_update_media WHERE update_id = ?', [updateId], (err, rows) => {
        if (err) {
            console.error("Error fetching update media for deletion:", err.message);
            return res.status(500).send("Failed to fetch update media for deletion.");
        }

        rows.forEach(row => {
            const fullPath = path.join(__dirname, 'public', row.filepath);
            fs.unlink(fullPath, (err) => {
                if (err && err.code !== 'ENOENT') {
                    console.error("Error deleting file:", fullPath, err);
                }
            });
        });

        db.serialize(() => {
            db.run('DELETE FROM achievement_update_media WHERE update_id = ?', [updateId]);
            db.run('DELETE FROM achievement_updates WHERE id = ?', [updateId], function(err) {
                if (err) {
                    console.error("Error deleting achievement update:", err.message);
                    return res.status(500).send("Failed to delete achievement update.");
                }
                res.status(200).send("Achievement update deleted successfully.");
            });
        });
    });
});

app.delete('/api/achievement-update-media/:id', requireLogin, requireEditor, (req, res) => {
    const mediaId = req.params.id;

    db.get('SELECT filepath FROM achievement_update_media WHERE id = ?', [mediaId], (err, row) => {
        if (err) {
            console.error("Error fetching update media record:", err.message);
            return res.status(500).send("Failed to fetch media record.");
        }
        if (!row) {
            return res.status(404).send("Media record not found.");
        }

        const fullPath = path.join(__dirname, 'public', row.filepath);
        fs.unlink(fullPath, (err) => {
            if (err && err.code !== 'ENOENT') {
                console.error("Error deleting file:", fullPath, err);
            }
        });

        db.run('DELETE FROM achievement_update_media WHERE id = ?', [mediaId], function(err) {
            if (err) {
                console.error("Error deleting update media record:", err.message);
                return res.status(500).send("Failed to delete media record.");
            }
            res.status(200).send("Media deleted successfully.");
        });
    });
});

// Add media files to an existing update
app.post('/api/achievement-update-media', requireLogin, requireEditor, upload.array('media'), (req, res) => {
    const { update_id } = req.body;
    const files = req.files || [];
    if (!update_id) return res.status(400).send('update_id is required.');
    if (files.length === 0) return res.status(400).send('No files uploaded.');

    const inserts = files.map(file => new Promise((resolve, reject) => {
        const filepath = '/uploads/' + file.filename;
        const mediaType = file.mimetype.startsWith('video/') ? 'video' : 'photo';
        db.run('INSERT INTO achievement_update_media (update_id, filename, filepath, media_type) VALUES (?, ?, ?, ?)',
            [update_id, file.filename, filepath, mediaType],
            function(err) { err ? reject(err) : resolve(); });
    }));

    Promise.all(inserts)
        .then(() => res.status(201).send('Media added.'))
        .catch(err => {
            console.error('Error adding update media:', err.message);
            res.status(500).send('Failed to add media.');
        });
});

// ── Story Sections API ──
app.get('/api/story-sections', requireLogin, (req, res) => {
    db.all('SELECT * FROM story_sections ORDER BY display_order ASC, sort_date ASC, id ASC', [], (err, rows) => {
        if (err) return res.status(500).send(err.message);
        res.json(rows);
    });
});

function clearStoryCache() {
    db.run("DELETE FROM settings WHERE key IN ('story_cache', 'story_cache_stale')");
}

app.post('/api/story-sections', requireLogin, requireEditor, (req, res) => {
    const { title, content, phase, sort_date, display_order } = req.body || {};
    if (!content) return res.status(400).send('content is required.');
    db.run(
        'INSERT INTO story_sections (title, content, phase, sort_date, display_order) VALUES (?, ?, ?, ?, ?)',
        [title || 'Note', content, phase || null, sort_date || null, display_order || 0],
        function(err) {
            if (err) return res.status(500).send(err.message);
            clearStoryCache();
            res.status(201).json({ id: this.lastID });
        }
    );
});

app.put('/api/story-sections/:id', requireLogin, requireEditor, (req, res) => {
    const { id } = req.params;
    const { title, content, phase, sort_date, display_order } = req.body || {};
    if (!content) return res.status(400).send('content is required.');
    db.run(
        'UPDATE story_sections SET title = ?, content = ?, phase = ?, sort_date = ?, display_order = ? WHERE id = ?',
        [title || 'Note', content, phase || null, sort_date || null, display_order || 0, id],
        function(err) {
            if (err) return res.status(500).send(err.message);
            if (this.changes === 0) return res.status(404).send('Section not found.');
            clearStoryCache();
            res.status(200).send('Section updated.');
        }
    );
});

app.delete('/api/story-sections/:id', requireLogin, requireEditor, (req, res) => {
    db.run('DELETE FROM story_sections WHERE id = ?', [req.params.id], function(err) {
        if (err) return res.status(500).send(err.message);
        if (this.changes === 0) return res.status(404).send('Section not found.');
        clearStoryCache();
        res.status(200).send('Section deleted.');
    });
});

// ── AI Story generation ──

app.get('/api/story/cache', requireLogin, (req, res) => {
    const style = ['factual', 'prose', 'children'].includes(req.query.style) ? req.query.style : 'factual';
    const cacheKey = `story_cache_${style}`;
    db.get("SELECT value FROM settings WHERE key = ?", [cacheKey], (err, row) => {
        if (err) return res.status(500).send(err.message);
        if (!row) return res.json(null);
        try { res.json(JSON.parse(row.value)); }
        catch { res.json(null); }
    });
});

app.post('/api/story/generate', requireLogin, async (req, res) => {
    if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured on this server.' });
    }

    try {
        // Gather all data in parallel
        const dbAll = (sql, params) => new Promise((resolve, reject) =>
            db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));

        const [stepsRows, exerciseRows, achievementRows, noteRows] = await Promise.all([
            dbAll('SELECT * FROM steps ORDER BY date', []),
            dbAll('SELECT * FROM exercises ORDER BY date', []),
            dbAll('SELECT * FROM achievements ORDER BY start_date', []),
            dbAll('SELECT * FROM story_sections ORDER BY display_order ASC, id ASC', []),
        ]);

        // Fetch achievement updates with media counts
        const achWithUpdates = await Promise.all(achievementRows.map(async ach => {
            const updates = await dbAll(
                `SELECT au.update_date, au.comments,
                 (SELECT COUNT(*) FROM achievement_update_media m WHERE m.update_id = au.id AND m.media_type = 'photo') as photos,
                 (SELECT COUNT(*) FROM achievement_update_media m WHERE m.update_id = au.id AND m.media_type = 'video') as videos
                 FROM achievement_updates au WHERE au.achievement_id = ? ORDER BY au.update_date`,
                [ach.id]);
            return { ...ach, updates };
        }));

        // Step stats
        const totalSteps   = stepsRows.reduce((s, r) => s + r.quantity, 0);
        const activeDays   = stepsRows.filter(r => r.quantity > 0);
        const avgSteps     = activeDays.length > 0 ? Math.round(totalSteps / activeDays.length) : 0;
        const bestDay      = stepsRows.reduce((b, r) => r.quantity > (b ? b.quantity : 0) ? r : b, null);
        const tenKDays     = stepsRows.filter(r => r.quantity >= 10000).length;
        const sortedDates  = stepsRows.map(s => s.date).sort();
        const firstDate    = sortedDates[0] || null;
        const lastDate     = sortedDates[sortedDates.length - 1] || null;
        const totalDays    = firstDate && lastDate
            ? Math.round((new Date(lastDate) - new Date(firstDate)) / 86400000) + 1 : 0;

        // Exercise stats
        const exDone   = exerciseRows.filter(e => e.done === 'yes').length;
        const exWeight = exerciseRows.filter(e => e.weights_done === 'yes').length;
        const exPct    = exerciseRows.length > 0 ? Math.round((exDone / exerciseRows.length) * 100) : 0;

        // Fun milestones progress
        const funMilestones = [
            { name: 'Stoke to London',       steps: 300000,    miles: 150  },
            { name: 'Stoke to Paris',         steps: 800000,    miles: 400  },
            { name: 'Stoke to Berlin',        steps: 1500000,   miles: 750  },
            { name: 'Stoke to Moscow',        steps: 3200000,   miles: 1600 },
            { name: 'Stoke to Johannesburg',  steps: 12000000,  miles: 6000 },
        ];
        const milestoneSummary = funMilestones.map(m => {
            const pct = Math.min(100, Math.round((totalSteps / m.steps) * 100));
            const status = pct >= 100
                ? 'COMPLETED'
                : `${pct}% complete (${totalSteps.toLocaleString()} of ${m.steps.toLocaleString()} steps)`;
            return `- ${m.name} (${m.miles} miles / ${m.steps.toLocaleString()} steps): ${status}`;
        }).join('\n');

        // Build the data summary for the prompt
        const stepsSummary = totalSteps > 0
            ? `Journey started: ${firstDate}\nTotal days in programme: ${totalDays}\nTotal steps recorded: ${totalSteps.toLocaleString()}\nAverage steps (active days): ${avgSteps.toLocaleString()}\nBest single day: ${bestDay ? bestDay.quantity.toLocaleString() + ' steps on ' + bestDay.date + (bestDay.comments ? ' (Fred noted: "' + bestDay.comments + '")' : '') : 'N/A'}\nDays with 10,000+ steps: ${tenKDays}`
            : 'No step data recorded yet.';

        const exerciseSummary = exerciseRows.length > 0
            ? `Exercise sessions completed: ${exDone} of ${exerciseRows.length} tracked days (${exPct}% compliance)\nStrength/weights sessions: ${exWeight}`
            : 'No exercise data recorded yet.';

        const achievementsSummary = achWithUpdates.length > 0
            ? achWithUpdates.map(a => {
                let s = `- ${a.name}${a.description ? ': ' + a.description : ''}`;
                a.updates.forEach(u => {
                    const media = [];
                    if (u.photos > 0) media.push(`${u.photos} photo${u.photos > 1 ? 's' : ''}`);
                    if (u.videos > 0) media.push(`${u.videos} video${u.videos > 1 ? 's' : ''}`);
                    s += `\n    [${u.update_date}]${u.comments ? ' ' + u.comments : ''}${media.length ? ' (' + media.join(', ') + ' attached)' : ''}`;
                });
                return s;
              }).join('\n')
            : 'No achievements recorded yet.';

        const notesSummary = noteRows.length > 0
            ? noteRows.map((n, i) =>
                `Note ${i + 1}${n.title && !/^Note\s*\d*$/i.test(n.title.trim()) ? ' — "' + n.title + '"' : ''}:\n${n.content}`
              ).join('\n\n---\n\n')
            : 'No personal notes recorded yet.';

        const style = ['factual', 'prose', 'children'].includes(req.body && req.body.style) ? req.body.style : 'factual';

        const dataBlock = `REHABILITATION DATA:

Steps & Walking:
${stepsSummary}

Exercise & Strength:
${exerciseSummary}

Personal Achievements (some updates have photos/videos attached — mention these where relevant, e.g. "a photo from this occasion is included below"):
${achievementsSummary}

Fun Step Challenges (distance milestones based on total steps):
${milestoneSummary}

FRED'S OWN NOTES (written by Fred during his recovery):
${notesSummary}`;

        const jsonSchema = `Return ONLY a valid JSON object (no markdown, no preamble) in this exact structure:
{
  "chapters": [
    { "num": "Chapter One",   "icon": "📖", "title": "...", "paragraphs": ["...", "..."] },
    { "num": "Chapter Two",   "icon": "👟", "title": "...", "paragraphs": ["...", "..."] },
    { "num": "Chapter Three", "icon": "💪", "title": "...", "paragraphs": ["...", "..."] },
    { "num": "Chapter Four",  "icon": "🏅", "title": "...", "paragraphs": ["...", "..."] }
  ]
}
Each chapter: 2 to 4 paragraphs. Return only the JSON object.`;

        const stylePrompts = {
            factual: `You are writing a factual, readable account of a rehabilitation patient named Fred's recovery progress. Write in third person ("Fred...", "He..."). The tone should be clear and informative — like a well-written case summary or progress account — not a memoir or motivational piece. Avoid emotional language, flowery phrases, and superlatives.

${dataBlock}

INSTRUCTIONS:
Write exactly 4 chapters. Lead with the numbers — mention specific step counts, dates, compliance percentages, achievement names, and fun challenge progress. Weave Fred's notes into the narrative naturally without quoting them directly and without mentioning "notes" or "he wrote". Incorporate the events and details from his notes as plain factual statements. Keep the writing grounded and factual throughout.

Chapter Four must cover both personal achievements AND the fun distance challenges (Stoke to London etc.) — state clearly which challenges have been completed and the percentage progress on those that have not. Where achievement updates mention photos or videos, include a brief factual mention such as "a photo from this occasion is included in the story".

${jsonSchema}`,

            prose: `You are a skilled narrative writer telling the story of Fred's rehabilitation journey. Write in rich, literary third-person prose — warm, descriptive, and human. Think of it as a personal memoir written about Fred, not for a medical record. Let the numbers and facts emerge naturally within flowing paragraphs. Capture the atmosphere of recovery: the early struggles, the small victories, the growing confidence. Use vivid but tasteful language. Avoid clichés and melodrama.

${dataBlock}

INSTRUCTIONS:
Write exactly 4 chapters with evocative titles you choose yourself. Weave statistics and achievements into the narrative naturally — don't list them, bring them to life. Include Fred's notes as part of the story without quoting them directly or referencing "notes". Chapter Four should bring the story to a meaningful close covering achievements and the distance challenges. Where achievement updates mention photos or videos, weave in a brief mention such as "captured in a photo from that day".

${jsonSchema}`,

            children: `You are writing a fun, uplifting story for a young child (age 6–8) about a man named Fred who is getting better after being poorly. Use very simple words and short sentences. Make Fred sound like a brave hero going on a big adventure. Use fun comparisons children will love — like comparing his steps to how far away London is, or comparing his exercises to training to be a superhero. Be encouraging, cheerful, and positive. Never use medical jargon or complicated statistics — turn numbers into exciting facts ("That's like walking to the moon and back!"). Keep each paragraph short.

${dataBlock}

INSTRUCTIONS:
Write exactly 4 chapters with simple, fun titles you choose yourself. Turn the data into child-friendly storytelling — for example, total steps become an exciting journey on a map, exercise days become training sessions. Weave Fred's notes into the story naturally as things that happened to Fred. Chapter Four should celebrate his achievements and the distance challenges as exciting quests completed or underway. Keep the tone playful and celebratory throughout.

${jsonSchema}`
        };

        const prompt = stylePrompts[style];

        const client = new Anthropic();
        const message = await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 2048,
            messages: [{ role: 'user', content: prompt }],
        });

        const rawText = message.content[0].text.trim();
        // Strip any accidental markdown code fences
        const jsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        const parsed = JSON.parse(jsonText);

        // Cache in settings table (per style)
        const cacheKey = `story_cache_${style}`;
        db.serialize(() => {
            db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [cacheKey, JSON.stringify(parsed)]);
        });

        res.json({ ...parsed, _style: style });
    } catch (err) {
        console.error('Story generation error:', err);
        res.status(500).json({ error: err.message || 'Failed to generate story.' });
    }
});

app.get('/story.html', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'story.html'));
});

app.get('/milestones.html', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'milestones.html'));
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