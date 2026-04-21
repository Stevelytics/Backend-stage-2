# Insighta Labs - Intelligence Query Engine (Stage 2)

This API serves as a demographic query engine, allowing clients to filter, sort, paginate, and utilize natural language to search through large datasets of profile information.

## Core Features
* **Advanced Filtering:** Query by exact matches or ranges (e.g., `min_age`, `min_country_probability`).
* **Pagination & Sorting:** Built-in safeguards restrict queries to 50 results per page, preventing database overload via full-table scans.
* **Natural Language Parsing:** A custom rule-based string parser translates human-readable queries into structured SQL parameters.

## Natural Language Search Examples
* `GET /api/profiles/search?q=young males from nigeria`
* `GET /api/profiles/search?q=females above 30`

The system safely extracts intent (mapping "young" to ages 16-24) and matches country strings dynamically against the database schema.