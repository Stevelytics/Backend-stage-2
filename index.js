const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();

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

// Cache country names in memory for fast Natural Language lookup
let countryMap = {};
db.all("SELECT DISTINCT LOWER(country_name) as name, country_id FROM profiles", [], (err, rows) => {
    if (!err && rows) {
        rows.forEach(r => { if (r.name) countryMap[r.name] = r.country_id; });
    }
});

// --- UNIFIED QUERY ENGINE ---
// This handles filtering, sorting, and pagination for ALL endpoints
async function fetchProfiles(filters, options) {
    let baseQuery = " FROM profiles WHERE 1=1";
    let params = [];

    // 1. Apply Filters dynamically
    if (filters.gender) { baseQuery += " AND LOWER(gender) = ?"; params.push(filters.gender.toLowerCase()); }
    if (filters.age_group) { baseQuery += " AND LOWER(age_group) = ?"; params.push(filters.age_group.toLowerCase()); }
    if (filters.country_id) { baseQuery += " AND UPPER(country_id) = ?"; params.push(filters.country_id.toUpperCase()); }
    if (filters.min_age !== undefined) { baseQuery += " AND age >= ?"; params.push(Number(filters.min_age)); }
    if (filters.max_age !== undefined) { baseQuery += " AND age <= ?"; params.push(Number(filters.max_age)); }
    if (filters.min_gender_probability !== undefined) { baseQuery += " AND gender_probability >= ?"; params.push(Number(filters.min_gender_probability)); }
    if (filters.min_country_probability !== undefined) { baseQuery += " AND country_probability >= ?"; params.push(Number(filters.min_country_probability)); }

    // 2. Count Total (before pagination)
    const countResult = await dbGet(`SELECT COUNT(*) as total ${baseQuery}`, params);
    const total = countResult.total;

    // 3. Sorting (Safeguarded against SQL injection)
    const validSortColumns = ['age', 'created_at', 'gender_probability'];
    let sortColumn = validSortColumns.includes(options.sort_by) ? options.sort_by : 'created_at';
    let sortOrder = options.order && options.order.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    
    // 4. Pagination
    let page = Math.max(1, parseInt(options.page) || 1);
    let limit = Math.max(1, Math.min(50, parseInt(options.limit) || 10)); // Max 50
    let offset = (page - 1) * limit;

    const dataQuery = `SELECT * ${baseQuery} ORDER BY ${sortColumn} ${sortOrder} LIMIT ? OFFSET ?`;
    const data = await dbAll(dataQuery, [...params, limit, offset]);

    return { total, page, limit, data };
}

// --- NATURAL LANGUAGE PARSER ---
function parseNLQuery(queryText) {
    if (!queryText || queryText.trim() === '') return null;
    let q = queryText.toLowerCase().replace(/[^a-z0-9\s]/g, ''); // sanitize
    let filters = {};
    let matched = false;

    // Gender Logic
    let isMale = /\b(male|males|men|boy|boys)\b/.test(q);
    let isFemale = /\b(female|females|women|girl|girls)\b/.test(q);
    if (isMale && !isFemale) { filters.gender = 'male'; matched = true; }
    if (isFemale && !isMale) { filters.gender = 'female'; matched = true; }
    // If both are present ("male and female"), we intentionally set neither to return both.

    // Age Group Logic
    if (/\b(child|children)\b/.test(q)) { filters.age_group = 'child'; matched = true; }
    if (/\b(teenager|teenagers|teens)\b/.test(q)) { filters.age_group = 'teenager'; matched = true; }
    if (/\b(adult|adults)\b/.test(q)) { filters.age_group = 'adult'; matched = true; }
    if (/\b(senior|seniors)\b/.test(q)) { filters.age_group = 'senior'; matched = true; }

    // "Young" Keyword Logic
    if (/\byoung\b/.test(q)) {
        filters.min_age = 16;
        filters.max_age = 24;
        matched = true;
    }

    // Greater/Less than Logic
    let aboveMatch = q.match(/(?:above|over|older than)\s+(\d+)/);
    if (aboveMatch) { filters.min_age = parseInt(aboveMatch[1], 10); matched = true; }
    
    let belowMatch = q.match(/(?:below|under|younger than)\s+(\d+)/);
    if (belowMatch) { filters.max_age = parseInt(belowMatch[1], 10); matched = true; }

    // Country Extraction
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

    // Fallback: If "people" is used but no specific filters triggered, consider it a valid query for "all"
    if (!matched && /\bpeople\b/.test(q)) matched = true;

    return matched ? filters : null;
}


// --- API ENDPOINTS ---

// 1. Search Endpoint (Natural Language)
app.get('/api/profiles/search', async (req, res) => {
    try {
        const { q, page, limit } = req.query;
        if (!q) {
            return res.status(400).json({ status: "error", message: "Missing query parameter 'q'" });
        }

        const filters = parseNLQuery(q);
        if (!filters) {
            return res.status(400).json({ status: "error", message: "Unable to interpret query" });
        }

        const result = await fetchProfiles(filters, { page, limit });
        
        return res.status(200).json({
            status: "success",
            page: result.page,
            limit: result.limit,
            total: result.total,
            data: result.data
        });
    } catch (error) {
        return res.status(500).json({ status: "error", message: "Internal server error" });
    }
});

// 2. Standard Profiles Endpoint (Advanced Filters)
app.get('/api/profiles', async (req, res) => {
    try {
        const { sort_by, order, page, limit, ...filters } = req.query;
        
        // Parameter validation check
        if (filters.min_age && isNaN(filters.min_age)) {
            return res.status(422).json({ status: "error", message: "Invalid parameter type" });
        }

        const result = await fetchProfiles(filters, { sort_by, order, page, limit });

        return res.status(200).json({
            status: "success",
            page: result.page,
            limit: result.limit,
            total: result.total,
            data: result.data
        });
    } catch (error) {
        return res.status(500).json({ status: "error", message: "Internal server error" });
    }
});


app.listen(PORT, () => console.log(`Stage 2 Query Engine running on port ${PORT}`));