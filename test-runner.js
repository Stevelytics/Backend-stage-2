// test-runner.js
const assert = require('assert');

const BASE_URL = 'http://localhost:3000/api/profiles';

async function runTests() {
    console.log("🚀 Starting Local Thanos Grading...\n");

    try {
        // --- TEST 1: The Pagination Envelope ---
        console.log("Testing Pagination Envelope...");
        const pageRes = await fetch(`${BASE_URL}?page=1&limit=5`);
        const pageData = await pageRes.json();
        
        const expectedKeys = ['status', 'page', 'limit', 'total', 'data'];
        const actualKeys = Object.keys(pageData);
        
        // Check if there are ANY extra keys
        const hasExtraKeys = actualKeys.some(key => !expectedKeys.includes(key));
        if (hasExtraKeys) throw new Error(`Envelope contains invalid keys: ${actualKeys.join(', ')}`);
        if (pageData.limit !== 5) throw new Error(`Limit should be 5, got ${pageData.limit}`);
        console.log("✅ Pagination Envelope is perfect.\n");

        // --- TEST 2: Stable Sorting ---
        console.log("Testing Stable Sorting...");
        const sortRes1 = await fetch(`${BASE_URL}?page=1&limit=3&sort_by=created_at&order=desc`);
        const sortRes2 = await fetch(`${BASE_URL}?page=2&limit=3&sort_by=created_at&order=desc`);
        const sortData1 = await sortRes1.json();
        const sortData2 = await sortRes2.json();

        // Ensure no IDs from Page 1 appear on Page 2
        const page1Ids = sortData1.data.map(p => p.id);
        const overlap = sortData2.data.some(p => page1Ids.includes(p.id));
        if (overlap) throw new Error("Page overlap detected! Sorting is not stable.");
        console.log("✅ Sorting is stable (No overlap).\n");

        // --- TEST 3: NLP Edge Cases ---
        console.log("Testing NLP Edge Cases...");
        const nlpQueries = [
            "young males",
            "females above 30",
            "people from nigeria",
            "adult males from kenya",
            "Male and female teenagers above 17"
        ];

        for (const query of nlpQueries) {
            const res = await fetch(`${BASE_URL}/search?q=${encodeURIComponent(query)}`);
            if (res.status !== 200) throw new Error(`Query failed: ${query}`);
            console.log(`✅ NLP Query parsed successfully: "${query}"`);
        }

        console.log("\n🎉 ALL LOCAL TESTS PASSED. You are ready to deploy.");

    } catch (error) {
        console.error(`\n❌ TEST FAILED: ${error.message}`);
        console.log("Fix the code in index.js and run this test again.");
    }
}

runTests();