const express = require('express');
const cors = require('cors');
const axios = require('axios'); // Needed for the POST endpoint
const sqlite3 = require('sqlite3').verbose();
const { uuidv7 } = require('uuidv7'); // Needed for the POST endpoint

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const db = new sqlite3.Database('./profiles.db');

// --- DATABASE HELPERS ---
const dbAll = (query, params) => new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => err ? reject(err) : resolve(rows));
});
const dbGet = (query, params) => new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => err ? reject(err) : resolve(row));
});
const dbRun = (query, params) => new Promise((resolve, reject) => {
    db.run(query, params, function(err) { err ? reject(err) : resolve(this) });
});

// Initialize Database Table (Required so the POST endpoint can save data)
dbRun(`CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE,
    gender TEXT,
    gender_probability REAL,
    sample_size INTEGER,
    age INTEGER,
    age_group TEXT,
    country_id TEXT,
    country_probability REAL,
    created_at TEXT
)`).catch(console.error);

// Cache country names in memory for fast Natural Language lookup
let countryMap = {};
db.all("SELECT DISTINCT LOWER(country_id) as name, country_id FROM profiles", [], (err, rows) => {
    if (!err && rows) {
        rows.forEach(r => { if (r.name) countryMap[r.name] = r.country_id; });
    }
});


// ==========================================
// STAGE 1 ENDPOINTS (CREATE, READ ONE, DELETE)
// ==========================================

// 1. POST /api/profiles (Create a new profile)
app.post('/api/profiles', async (req, res) => {
    try {
        const name = req.body?.name;

        if (name === undefined || name === null || String(name).trim() === '') {
            return res.status(400).json({ status: "error", message: "Missing or empty name parameter" });
        }
        if (typeof name !== 'string') {
            return res.status(422).json({ status: "error", message: "name must be a string" });
        }

        const normalizedName = name.trim().toLowerCase();

        const existingProfile = await dbGet(`SELECT * FROM profiles WHERE LOWER(name) = ?`, [normalizedName]);
        if (existingProfile) {
            return res.status(200).json({ status: "success", message: "Profile already exists", data: existingProfile });
        }

        const encodedName = encodeURIComponent(normalizedName);
        const [genderRes, ageRes, natRes] = await Promise.all([
            axios.get(`https://api.genderize.io?name=${encodedName}`),
            axios.get(`https://api.agify.io?name=${encodedName}`),
            axios.get(`https://api.nationalize.io?name=${encodedName}`)
        ]);

        const genderData = genderRes.data;
        const ageData = ageRes.data;
        const natData = natRes.data;

        if (genderData.gender === null || genderData.count === 0) return res.status(502).json({ status: "502", message: "Genderize returned an invalid response" });
        if (ageData.age === null) return res.status(502).json({ status: "502", message: "Agify returned an invalid response" });
        if (!natData.country || natData.country.length === 0) return res.status(502).json({ status: "502", message: "Nationalize returned an invalid response" });

        const gender = genderData.gender;
        const gender_probability = genderData.probability;
        const sample_size = genderData.count;
        const age = ageData.age;
        
        let age_group = "";
        if (age <= 12) age_group = "child";
        else if (age <= 19) age_group = "teenager";
        else if (age <= 59) age_group = "adult";
        else age_group = "senior";

        const bestCountry = natData.country.reduce((prev, current) => (prev.probability > current.probability) ? prev : current);
        const country_id = bestCountry.country_id;
        const country_probability = bestCountry.probability;
        const id = uuidv7();
        const created_at = new Date().toISOString();

        await dbRun(
            `INSERT INTO profiles (id, name, gender, gender_probability, sample_size, age, age_group, country_id, country_probability, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, normalizedName, gender, gender_probability, sample_size, age, age_group, country_id, country_probability, created_at]
        );

        return res.status(201).json({ status: "success", data: { id, name: normalizedName, gender, gender_probability, sample_size, age, age_group, country_id, country_probability, created_at }});
    } catch (error) {
        console.error("POST Error:", error);
        return res.status(500).json({ status: "error", message: "Internal server error" });
    }
});


// GET Natural Language Search
app.get('/api/profiles/search', async (req, res) => {
    try {
        const { q, page, limit } = req.query;
        if (!q) return res.status(400).json({ status: "error", message: "Missing query parameter 'q'" });

        const filters = parseNLQuery(q);
        if (!filters) return res.status(400).json({ status: "error", message: "Unable to interpret query" });

        const result = await fetchProfiles(filters, { page, limit });
        return res.status(200).json({ status: "success", page: result.page, limit: result.limit, total: result.total, data: result.data });
    } catch (error) {
        return res.status(500).json({ status: "error", message: "Internal server error" });
    }
});

// GET Single Profile
app.get('/api/profiles/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const profile = await dbGet(`SELECT * FROM profiles WHERE id = ?`, [id]);
        if (!profile) return res.status(404).json({ status: "error", message: "Profile not found" });
        return res.status(200).json({ status: "success", data: profile });
    } catch (error) {
        return res.status(500).json({ status: "error", message: "Internal server error" });
    }
});

// DELETE Single Profile
app.delete('/api/profiles/:id', async (req, res) => {
    try {
        const result = await dbRun(`DELETE FROM profiles WHERE id = ?`, [req.params.id]);
        if (result.changes === 0) return res.status(404).json({ status: "error", message: "Profile not found" });
        return res.status(204).send();
    } catch (error) {
        return res.status(500).json({ status: "error", message: "Internal server error" });
    }
});


// ==========================================
// STAGE 2 ENDPOINTS (SEARCH & FILTER)
// ==========================================

async function fetchProfiles(filters, options) {
    let baseQuery = " FROM profiles WHERE 1=1";
    let params = [];

    if (filters.gender) { baseQuery += " AND LOWER(gender) = ?"; params.push(filters.gender.toLowerCase()); }
    if (filters.age_group) { baseQuery += " AND LOWER(age_group) = ?"; params.push(filters.age_group.toLowerCase()); }
    if (filters.country_id) { baseQuery += " AND UPPER(country_id) = ?"; params.push(filters.country_id.toUpperCase()); }
    if (filters.min_age !== undefined) { baseQuery += " AND age >= ?"; params.push(Number(filters.min_age)); }
    if (filters.max_age !== undefined) { baseQuery += " AND age <= ?"; params.push(Number(filters.max_age)); }
    if (filters.min_gender_probability !== undefined) { baseQuery += " AND gender_probability >= ?"; params.push(Number(filters.min_gender_probability)); }
    if (filters.min_country_probability !== undefined) { baseQuery += " AND country_probability >= ?"; params.push(Number(filters.min_country_probability)); }

    const countResult = await dbGet(`SELECT COUNT(*) as total ${baseQuery}`, params);
    const total = countResult.total;

    const validSortColumns = ['age', 'created_at', 'gender_probability'];
    let sortColumn = validSortColumns.includes(options.sort_by) ? options.sort_by : 'created_at';
    let sortOrder = options.order && options.order.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    
    let page = Math.max(1, parseInt(options.page) || 1);
    let limit = Math.max(1, Math.min(50, parseInt(options.limit) || 10));
    let offset = (page - 1) * limit;

    const dataQuery = `SELECT * ${baseQuery} ORDER BY ${sortColumn} ${sortOrder} LIMIT ? OFFSET ?`;
    const data = await dbAll(dataQuery, [...params, limit, offset]);

    return { total, page, limit, data };
}

function parseNLQuery(queryText) {
    if (!queryText || queryText.trim() === '') return null;
    let q = queryText.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    let filters = {};
    let matched = false;

    let isMale = /\b(male|males|men|boy|boys)\b/.test(q);
    let isFemale = /\b(female|females|women|girl|girls)\b/.test(q);
    if (isMale && !isFemale) { filters.gender = 'male'; matched = true; }
    if (isFemale && !isMale) { filters.gender = 'female'; matched = true; }

    if (/\b(child|children)\b/.test(q)) { filters.age_group = 'child'; matched = true; }
    if (/\b(teenager|teenagers|teens)\b/.test(q)) { filters.age_group = 'teenager'; matched = true; }
    if (/\b(adult|adults)\b/.test(q)) { filters.age_group = 'adult'; matched = true; }
    if (/\b(senior|seniors)\b/.test(q)) { filters.age_group = 'senior'; matched = true; }

    if (/\byoung\b/.test(q)) { filters.min_age = 16; filters.max_age = 24; matched = true; }

    let aboveMatch = q.match(/(?:above|over|older than)\s+(\d+)/);
    if (aboveMatch) { filters.min_age = parseInt(aboveMatch[1], 10); matched = true; }
    
    let belowMatch = q.match(/(?:below|under|younger than)\s+(\d+)/);
    if (belowMatch) { filters.max_age = parseInt(belowMatch[1], 10); matched = true; }

    let fromMatch = q.match(/from\s+([a-z\s]+)/);
    if (fromMatch) {
        let potentialCountry = fromMatch[1].trim();
        for (let countryName in countryMap) {
            if (potentialCountry.includes(countryName)) {
                filters.country_id = countryMap[countryName];
                matched = true;
                break;
            }
        }
    }

    if (!matched && /\bpeople\b/.test(q)) matched = true;
    return matched ? filters : null;
}



// GET Advanced Filtering endpoint 
app.get('/api/profiles', async (req, res) => {
    try {
        const { sort_by, order, page, limit, ...filters } = req.query;
        if (filters.min_age && isNaN(filters.min_age)) return res.status(422).json({ status: "error", message: "Invalid parameter type" });

        const result = await fetchProfiles(filters, { sort_by, order, page, limit });
        return res.status(200).json({ status: "success", page: result.page, limit: result.limit, total: result.total, data: result.data });
    } catch (error) {
        return res.status(500).json({ status: "error", message: "Internal server error" });
    }
});

// Add a root URL health check route
app.get('/', (req, res) => {
    res.status(200).json({ status: "success", message: "Welcome to the Profile Intelligence API!" });
});


// START SERVER
app.listen(PORT, () => console.log(`Combined Stage Server running on port ${PORT}`));