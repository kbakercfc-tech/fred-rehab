const sqlite3 = require('sqlite3').verbose();

// --- CONFIGURATION ---
// The path to your database file.
const DB_PATH = '/var/data/rehab.db';
// ---------------------


const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        return console.error(`Error connecting to database at ${DB_PATH}:`, err.message);
    }
    console.log(`Connected to the database at ${DB_PATH}.`);
});

db.serialize(() => {
    // 1. Check if the 'exercises' table exists and if migration is needed
    db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='exercises'", (err, table) => {
        if (err) {
            db.close();
            return console.error("Error checking for 'exercises' table:", err.message);
        }
        if (!table) {
            console.log("'exercises' table not found. No migration needed as it will be created by the app.");
            db.close();
            return;
        }

        // Table exists, now check for the 'weights_done' column (new schema indicator)
        db.all("PRAGMA table_info(exercises)", (err, columns) => {
            if (err) {
                db.close();
                return console.error("Error checking 'exercises' table schema:", err.message);
            }

            const hasWeightsDone = columns.some(col => col.name === 'weights_done'); // Check for new column
            if (hasWeightsDone) {
                console.log("No migration needed. The 'exercises' table already has the 'weights_done' column.");
                db.close();
                return;
            }

            console.log("Migration is required. Starting the process...");

            // 2. Perform the migration inside a transaction
            const migrationScript = `
                BEGIN TRANSACTION;

                ALTER TABLE exercises RENAME TO exercises_old;

                CREATE TABLE exercises (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    done TEXT NOT NULL,
                    date TEXT NOT NULL,
                    weights_done TEXT NOT NULL
                );

                INSERT INTO exercises (id, done, date, weights_done)
                SELECT 
                    id, 
                    done, 
                    date, 
                    'No'
                FROM exercises_old;

                DROP TABLE exercises_old;

                COMMIT;
            `;

            db.exec(migrationScript, function(err) {
                if (err) {
                    console.error("An error occurred during the migration:", err.message);
                    console.log("Attempting to roll back changes...");
                    db.exec('ROLLBACK;');
                } else {
                    console.log("\nMigration successful!");
                    console.log("The 'exercises' table has been updated.");
                    console.log("The 'repetitions' column has been removed and 'weights_done' is set to 'No' for all previous entries.");
                }
                db.close((err) => {
                    if (err) console.error('Error closing the database:', err.message);
                });
            });
        });
    });
});
