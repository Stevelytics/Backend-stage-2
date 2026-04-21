const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

const db = new sqlite3.Database('./profiles.db');

// The exact schema requested by the brief
const createTableQuery = `
CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE,
    gender TEXT,
    gender_probability REAL,
    age INTEGER,
    age_group TEXT,
    country_id TEXT,
    country_name TEXT,
    country_probability REAL,
    created_at TEXT
)`;

db.serialize(() => {
    db.run(createTableQuery);

    // Read the seed file
    fs.readFile('./seed_profiles.json', 'utf8', (err, data) => {
        if (err) {
            console.error("Error reading seed file:", err.message);
            return;
        }

        const parsedData = JSON.parse(data);
        
        // Smart extract: Find the array whether it's raw, or nested inside "data" or "profiles"
        let profilesArray = [];
        if (Array.isArray(parsedData)) {
            profilesArray = parsedData;
        } else if (parsedData.data && Array.isArray(parsedData.data)) {
            profilesArray = parsedData.data;
        } else if (parsedData.profiles && Array.isArray(parsedData.profiles)) {
            profilesArray = parsedData.profiles;
        } else {
            console.error("Could not find the array inside the JSON file. Open the file and check the key name!");
            return;
        }

        console.log(`Starting seed of ${profilesArray.length} profiles...`);

        // Use a transaction for fast bulk inserts
        db.run('BEGIN TRANSACTION');
        
        const stmt = db.prepare(`
            INSERT OR IGNORE INTO profiles 
            (id, name, gender, gender_probability, age, age_group, country_id, country_name, country_probability, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        profilesArray.forEach(p => {
            stmt.run(p.id, p.name, p.gender, p.gender_probability, p.age, p.age_group, p.country_id, p.country_name, p.country_probability, p.created_at);
        });

        stmt.finalize();
        
        db.run('COMMIT', () => {
            console.log("Seeding complete! Duplicates were ignored.");
            db.close();
        });
    });
});