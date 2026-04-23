const express = require('express');
const cors = require('cors');
const axios = require('axios'); 
const sqlite3 = require('sqlite3').verbose();
const { uuidv7 } = require('uuidv7'); 

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
    
    // Standard inclusive ages
    if (filters.min_age !== undefined) { baseQuery += " AND age >= ?"; params.push(Number(filters.min_age)); }
    if (filters.max_age !== undefined) { baseQuery += " AND age <= ?"; params.push(Number(filters.max_age)); }
    if (filters.min_gender_probability !== undefined) { baseQuery += " AND gender_probability >= ?"; params.push(Number(filters.min_gender_probability)); }
    if (filters.min_country_probability !== undefined) { baseQuery += " AND country_probability >= ?"; params.push(Number(filters.min_country_probability)); }

    const countResult = await dbGet(`SELECT COUNT(*) as total ${baseQuery}`, params);
    const total = countResult.total;

    const validSortColumns = ['age', 'created_at', 'gender_probability'];
    let sortByParam = options.sort_by || options.sortBy;
    let sortColumn = validSortColumns.includes(sortByParam) ? sortByParam : 'created_at';
    
    let orderParam = options.order || options.sortOrder;
    let sortOrder = orderParam && orderParam.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    
    let page = Math.max(1, parseInt(options.page) || 1);
    let limit = Math.max(1, Math.min(50, parseInt(options.limit) || 10));
    let offset = (page - 1) * limit;

    const dataQuery = `SELECT * ${baseQuery} ORDER BY ${sortColumn} ${sortOrder}, id ASC LIMIT ? OFFSET ?`;
    const data = await dbAll(dataQuery, [...params, limit, offset]);

    // Stripped down to strictly required envelope fields
    return { total, page, limit, data };
}

function parseNLQuery(queryText) {
    if (!queryText || queryText.trim() === '') return null;
    let q = queryText.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    let filters = {};

    let isMale = /\b(male|males|men|boy|boys)\b/.test(q);
    let isFemale = /\b(female|females|women|girl|girls)\b/.test(q);
    if (isMale && !isFemale) filters.gender = 'male';
    if (isFemale && !isMale) filters.gender = 'female';

    if (/\b(child|children)\b/.test(q)) filters.age_group = 'child';
    if (/\b(teenager|teenagers|teens)\b/.test(q)) filters.age_group = 'teenager';
    if (/\b(adult|adults)\b/.test(q)) filters.age_group = 'adult';
    if (/\b(senior|seniors)\b/.test(q)) filters.age_group = 'senior';

    // Strict mathematical bounds
    let aboveMatch = q.match(/(?:above|over|older than|greater than)\s+(\d+)/);
    if (aboveMatch) filters.min_age = parseInt(aboveMatch[1], 10) + 1; // "above 30" -> age >= 31
    
    let belowMatch = q.match(/(?:below|under|younger than|less than)\s+(\d+)/);
    if (belowMatch) filters.max_age = parseInt(belowMatch[1], 10) - 1; // "below 30" -> age <= 29

    // "Young" fallback
    if (/\byoung\b/.test(q) && !belowMatch) filters.max_age = 30;

    // Simplified Country Matching
    const countryMap = {
        "nigeria": "NG", "united states": "US", "america": "US", "usa": "US",
        "cameroon": "CM", "ghana": "GH", "kenya": "KE",
        "south africa": "ZA", "united kingdom": "GB", "england": "GB", "uk": "GB"
    };

    for (let countryName in countryMap) {
        if (q.includes(countryName)) {
            filters.country_id = countryMap[countryName];
            break;
        }
    }

    // If we matched any filters, OR if they just said "people/persons" (which returns all), return it.
    return Object.keys(filters).length > 0 || /\b(people|persons)\b/.test(q) ? filters : null;
}

// GET Natural Language Search
app.get('/api/profiles/search', async (req, res) => {
    try {
        const { q, page, limit } = req.query;
        if (!q) return res.status(400).json({ status: "error", message: "Missing query parameter 'q'" });

        const filters = parseNLQuery(q);
        if (!filters) return res.status(400).json({ status: "error", message: "Unable to interpret query" });

        const result = await fetchProfiles(filters, { page, limit });
        
        // Strict JSON Envelope Output
        return res.status(200).json({ 
            status: "success", 
            page: Number(result.page), 
            limit: Number(result.limit), 
            total: Number(result.total), 
            data: result.data 
        });
    } catch (error) {
        return res.status(500).json({ status: "error", message: "Internal server error" });
    }
});

// GET Advanced Filtering endpoint 
app.get('/api/profiles', async (req, res) => {
    try {
        const { sort_by, sortBy, order, sortOrder, page, limit, ...filters } = req.query;
        if (filters.min_age && isNaN(filters.min_age)) return res.status(422).json({ status: "error", message: "Invalid parameter type" });

        const options = { sort_by: sort_by || sortBy, order: order || sortOrder, page, limit };
        const result = await fetchProfiles(filters, options);
        
        // Strict JSON Envelope Output
        return res.status(200).json({ 
            status: "success", 
            page: Number(result.page), 
            limit: Number(result.limit), 
            total: Number(result.total), 
            data: result.data 
        });
    } catch (error) {
        return res.status(500).json({ status: "error", message: "Internal server error" });
    }
});

// Add a root URL health check route
app.get('/', (req, res) => {
    res.status(200).json({ status: "success", message: "Welcome to the Profile Intelligence API!" });
});

// --- BULLETPROOF INITIALIZATION ---
async function initializeDatabaseAndServer() {
    try {
        await dbRun(`DROP TABLE IF EXISTS profiles`);
        await dbRun(`CREATE TABLE profiles (
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
        )`);
        console.log("Database wiped and rebuilt flawlessly.");

        app.listen(PORT, () => console.log(`Combined Stage Server running on port ${PORT}`));
    } catch (error) {
        console.error("Startup Error:", error);
    }
}

initializeDatabaseAndServer();