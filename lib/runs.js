// 5k runs: table setup and API routes.
// Kept in its own module so it can be released separately from other features.

const path = require('path');

const MAX_LOCATION_CHARS = 200;
const MAX_NOTES_CHARS = 1000;
const MAX_SECONDS = 10 * 60 * 60; // 10 hours: anything longer is a typo

const CREATE_RUNS_TABLE = `CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    start_time TEXT,
    duration_seconds INTEGER NOT NULL,
    distance_km REAL NOT NULL DEFAULT 5,
    location TEXT,
    latitude REAL,
    longitude REAL,
    effort INTEGER,
    notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`;

class RunInputError extends Error {}

function optionalText(value, maxChars, field) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw new RunInputError(`${field} must be text.`);
    const text = value.trim();
    if (text.length > maxChars) throw new RunInputError(`${field} must be under ${maxChars} characters.`);
    return text || null;
}

function optionalNumber(value, min, max, field) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) throw new RunInputError(`${field} is out of range.`);
    return n;
}

function validateRun(body) {
    if (!body || typeof body !== 'object') throw new RunInputError('Missing run details.');

    const date = body.date;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) {
        throw new RunInputError('Please enter a valid date.');
    }

    let startTime = body.start_time;
    if (startTime === undefined || startTime === null || startTime === '') {
        startTime = null;
    } else if (typeof startTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) {
        throw new RunInputError('Start time must look like 09:30.');
    }

    const seconds = Number(body.duration_seconds);
    if (!Number.isInteger(seconds) || seconds <= 0 || seconds > MAX_SECONDS) {
        throw new RunInputError('Please enter a valid finish time, like 28:45.');
    }

    const distance = optionalNumber(body.distance_km, 0.1, 100, 'Distance');
    const latitude = optionalNumber(body.latitude, -90, 90, 'Latitude');
    const longitude = optionalNumber(body.longitude, -180, 180, 'Longitude');
    if ((latitude === null) !== (longitude === null)) {
        throw new RunInputError('Latitude and longitude must be given together.');
    }
    const effort = optionalNumber(body.effort, 1, 10, 'Effort');
    if (effort !== null && !Number.isInteger(effort)) throw new RunInputError('Effort must be a whole number from 1 to 10.');

    return {
        date,
        start_time: startTime,
        duration_seconds: seconds,
        distance_km: distance === null ? 5 : distance,
        location: optionalText(body.location, MAX_LOCATION_CHARS, 'Location'),
        latitude,
        longitude,
        effort,
        notes: optionalText(body.notes, MAX_NOTES_CHARS, 'Notes'),
    };
}

const FIELDS = ['date', 'start_time', 'duration_seconds', 'distance_km', 'location', 'latitude', 'longitude', 'effort', 'notes'];

// getDb is a function because a backup restore replaces the database connection.
function registerRunRoutes(app, { getDb, requireLogin, requireEditor }) {
    // A restored backup from before this feature has no runs table, so make sure
    // it exists on each connection before use.
    const readyDbs = new WeakSet();
    function withDb(callback) {
        const db = getDb();
        if (readyDbs.has(db)) return callback(null, db);
        db.run(CREATE_RUNS_TABLE, (err) => {
            if (err) return callback(err);
            readyDbs.add(db);
            callback(null, db);
        });
    }

    function handle(res, work) {
        withDb((err, db) => {
            if (err) {
                console.error('Runs table error:', err.message);
                return res.status(500).json({ error: 'Could not open the runs table.' });
            }
            try {
                work(db);
            } catch (e) {
                if (e instanceof RunInputError) return res.status(400).json({ error: e.message });
                console.error('Runs error:', e);
                res.status(500).json({ error: 'Something went wrong.' });
            }
        });
    }

    app.get('/runs.html', requireLogin, (req, res) => {
        res.sendFile(path.join(__dirname, '..', 'public', 'runs.html'));
    });

    app.get('/api/runs', requireLogin, (req, res) => {
        handle(res, (db) => {
            db.all('SELECT * FROM runs ORDER BY date ASC, start_time ASC, id ASC', (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(rows);
            });
        });
    });

    app.post('/api/runs', requireLogin, requireEditor, (req, res) => {
        handle(res, (db) => {
            const run = validateRun(req.body);
            const placeholders = FIELDS.map(() => '?').join(', ');
            db.run(`INSERT INTO runs (${FIELDS.join(', ')}) VALUES (${placeholders})`,
                FIELDS.map(f => run[f]),
                function (err) {
                    if (err) return res.status(500).json({ error: err.message });
                    res.status(201).json({ id: this.lastID, ...run });
                });
        });
    });

    app.put('/api/runs/:id', requireLogin, requireEditor, (req, res) => {
        handle(res, (db) => {
            const id = Number(req.params.id);
            if (!Number.isInteger(id)) throw new RunInputError('Invalid run id.');
            const run = validateRun(req.body);
            db.run(`UPDATE runs SET ${FIELDS.map(f => `${f} = ?`).join(', ')} WHERE id = ?`,
                [...FIELDS.map(f => run[f]), id],
                function (err) {
                    if (err) return res.status(500).json({ error: err.message });
                    if (this.changes === 0) return res.status(404).json({ error: 'Run not found.' });
                    res.json({ id, ...run });
                });
        });
    });

    app.delete('/api/runs/:id', requireLogin, requireEditor, (req, res) => {
        handle(res, (db) => {
            const id = Number(req.params.id);
            if (!Number.isInteger(id)) throw new RunInputError('Invalid run id.');
            db.run('DELETE FROM runs WHERE id = ?', [id], function (err) {
                if (err) return res.status(500).json({ error: err.message });
                if (this.changes === 0) return res.status(404).json({ error: 'Run not found.' });
                res.json({ success: true });
            });
        });
    });
}

module.exports = { registerRunRoutes, validateRun, RunInputError };
