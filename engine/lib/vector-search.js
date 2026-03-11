#!/usr/bin/env node
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { extractQueryTags } = require('./tags-helper');
const { getConfig } = require('./config');
const { normalizeMemoryContext, allowRowForContext, scopeBonus, scopeRank, sourceFilterClause } = require('./memory-scope');

function runtimeLog(...args) {
    console.error(...args);
}

async function generateEmbedding(text) {
    const config = getConfig();
    try {
        const response = await fetch(`${config.ollamaUrl}/api/embed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: config.embedModel,
                input: text
            })
        });

        if (!response.ok) {
            throw new Error(`Ollama API error: ${response.statusText}`);
        }

        const data = await response.json();
        const vecArray = Array.isArray(data.embeddings) && data.embeddings.length > 0
            ? data.embeddings[0]
            : Array.isArray(data.embedding)
                ? data.embedding
                : null;

        if (Array.isArray(vecArray) && vecArray.length > 0) {
            const dim = vecArray.length;
            const float32 = new Float32Array(vecArray);
            const rawBuffer = Buffer.from(float32.buffer);
            return { raw: rawBuffer, dim };
        } else {
            throw new Error('No embeddings returned from Ollama');
        }
    } catch (error) {
        console.error("Error generating embedding via Ollama:", error.message);
        // Do not return zero‑vector – fail the search
        throw new Error(`Embedding generation failed: ${error.message}`);
    }
}

async function vectorSearchJson(query, limit = 10, options = {}) {
    const rows = await vectorSearch(query, limit, options);
    const memoryContext = normalizeMemoryContext(options.memoryContext);
    
    // Context from options or environment
    const context = {
        project: options.project || process.env.RAG_CONTEXT_PROJECT || null,
        service: options.service || process.env.RAG_CONTEXT_SERVICE || null,
        env: options.env || process.env.RAG_CONTEXT_ENV || null,
        tags: options.tagsWanted || [],
        tagsMode: options.tagsMode || 'or',
        memoryContext,
    };
    
    // Prepare hits array
    const hits = rows.map(row => {
        // Clean source string - remove escape sequences
        let source = row.source_type === 'doc' ? row.source_id : `${row.source_type}:${row.source_id}`;
        source = source.replace(/\\n/g, ' ').replace(/\\r/g, ' ').replace(/\\t/g, ' ');
        
        // Get content preview
        let content_preview = null;
        if (row.source_content) {
            content_preview = row.source_content.substring(0, 200).replace(/\n/g, ' ').replace(/\r/g, ' ');
        }
        
        return {
            id: row.id,
            kind: row.kind || 'unknown',
            status: row.status || 'ok',
            score: parseFloat((row.finalScore || (1 - row.distance)).toFixed(3)),
            source: source,
            tags: row.tags_norm ? row.tags_norm.split(',').map(t => t.trim()).filter(t => t) : [],
            content_preview: content_preview,
            metadata: {
                project: row.project || null,
                service: row.service || null,
                env: row.env || null,
                source: row.source || null,
                scope: row.scope || null,
                chat_id: row.chat_id || null,
                thread_id: row.thread_id || null,
                user_id: row.user_id || null,
                session_id: row.session_id || null,
                created_at: row.created_at || null,
                ttl_until: row.ttl_until || null
            }
        };
    });
    
    return {
        query,
        context,
        hits,
        count: hits.length,
        timestamp: new Date().toISOString()
    };
}

async function vectorSearch(query, limit = 10, options = {}) {
    let db;
    try {
        query = typeof query === 'string' ? query : String(query ?? '');
        if (!query.trim()) {
            throw new Error('Empty query for vector search');
        }

        db = await open({
            filename: getConfig().dbPath,
            driver: sqlite3.Database
        });

        // Set busy timeout and WAL mode for concurrent reads
        await db.exec('PRAGMA busy_timeout = 5000;');
        await db.exec('PRAGMA journal_mode = WAL;');

    // Load vector extension
    try {
        await db.loadExtension(getConfig().vecExtPath);
    } catch (e) {
        console.error('Failed to load vector extension:', e.message);
        process.exit(1);
    }

    // Context from options or environment
    const context = {
        project: options.project || process.env.RAG_CONTEXT_PROJECT || null,
        service: options.service || process.env.RAG_CONTEXT_SERVICE || null,
        env: options.env || process.env.RAG_CONTEXT_ENV || null,
        tags: options.tagsWanted || (options.tags ? options.tags.split(',').map(t => t.trim()).filter(t => t) : []),
        tagsMode: options.tagsMode || 'or',
        memoryContext: normalizeMemoryContext(options.memoryContext),
    };

    // Parameterizable weights (production defaults)
    const weights = {
        statusBonus: {
            verified: parseFloat(process.env.RAG_WEIGHT_STATUS_VERIFIED) || 0.10,
            ok: parseFloat(process.env.RAG_WEIGHT_STATUS_OK) || 0.00,
            draft: parseFloat(process.env.RAG_WEIGHT_STATUS_DRAFT) || -0.05,
        },
        kindBonus: {
            runbook: parseFloat(process.env.RAG_WEIGHT_KIND_RUNBOOK) || 0.08,
            decision: parseFloat(process.env.RAG_WEIGHT_KIND_DECISION) || 0.08,
            config: parseFloat(process.env.RAG_WEIGHT_KIND_CONFIG) || 0.08,
            postmortem: parseFloat(process.env.RAG_WEIGHT_KIND_POSTMORTEM) || 0.08,
            code: parseFloat(process.env.RAG_WEIGHT_KIND_CODE) || 0.04,
            doc: parseFloat(process.env.RAG_WEIGHT_KIND_DOC) || 0.04,
            chat: parseFloat(process.env.RAG_WEIGHT_KIND_CHAT) || -0.08,
            log: parseFloat(process.env.RAG_WEIGHT_KIND_LOG) || -0.08,
            worklog: parseFloat(process.env.RAG_WEIGHT_KIND_WORKLOG) || 0.00,
        },
        recencyBonusMax: parseFloat(process.env.RAG_WEIGHT_RECENCY_MAX) || 0.04,
        recencyDays: parseFloat(process.env.RAG_WEIGHT_RECENCY_DAYS) || 7,
        contextBonus: {
            project: parseFloat(process.env.RAG_WEIGHT_CONTEXT_PROJECT) || 0.06,
            service: parseFloat(process.env.RAG_WEIGHT_CONTEXT_SERVICE) || 0.05,
            env: parseFloat(process.env.RAG_WEIGHT_CONTEXT_ENV) || 0.03,
        },
        tagBonusPerMatch: parseFloat(process.env.RAG_WEIGHT_TAG_BONUS_PER_MATCH) || 0.05,
        tagBonusMax: parseFloat(process.env.RAG_WEIGHT_TAG_BONUS_MAX) || 0.15,
    };
    
    if (process.env.DEBUG_RAG) {
        runtimeLog('[DEBUG_RAG] weights:', JSON.stringify(weights, null, 2));
        runtimeLog('[DEBUG_RAG] context:', context);
    }

    runtimeLog(`Generating embedding for query: "${query}"`);
    const embedding = await generateEmbedding(query);
    
    // Extract tags from query for tag bonus
    const queryTags = extractQueryTags(query);
    // Also include tags from CLI options
    if (context.tags && context.tags.length > 0) {
        context.tags.forEach(tag => {
            if (!queryTags.includes(tag)) {
                queryTags.push(tag);
            }
        });
    }
    if (process.env.DEBUG_RAG && queryTags.length > 0) {
        runtimeLog(`[DEBUG_RAG] query tags: ${queryTags.join(', ')}`);
    }

    // Stage A: retrieve top‑50 candidates by raw distance with soft context filters
    const candidateLimit = Math.max(limit * 5, 50);
    
    // Build soft filters based on context
    const whereConditions = [
        'e.vector_raw IS NOT NULL',
        'e.vector_dim = ?',
        "e.status IN ('verified', 'ok')",
        '(e.ttl_until IS NULL OR e.ttl_until > datetime(\'now\', \'utc\'))'
    ];
    const queryParams = [embedding.raw, embedding.dim];
    
    if (context.project) {
        whereConditions.push('(e.project = ? OR e.project IS NULL)');
        queryParams.push(context.project);
    }
    if (context.service) {
        whereConditions.push('(e.service = ? OR e.service IS NULL)');
        queryParams.push(context.service);
    }
    if (context.env) {
        whereConditions.push('(e.env = ? OR e.env IS NULL)');
        queryParams.push(context.env);
    }
    sourceFilterClause(context.memoryContext, whereConditions, queryParams);
    // Filter by tags if specified in CLI options
    if (context.tags && context.tags.length > 0) {
        if (process.env.DEBUG_RAG) {
            runtimeLog(`[DEBUG_RAG] tags filter: ${context.tags.join(', ')} (mode: ${context.tagsMode})`);
        }
        
        // When filtering by tags, exclude records with NULL or empty tags
        whereConditions.push('e.tags_norm IS NOT NULL');
        whereConditions.push('e.tags_norm != \'\'');
        
        if (context.tagsMode === 'and') {
            // AND mode: must contain ALL tags
            // tags_norm format: "tag1,tag2,tag3" or ",tag1,tag2,tag3," (comma-separated)
            // Match tag as whole word in CSV: tag at start, middle, or end
            context.tags.forEach(tag => {
                // Four patterns to cover all cases
                whereConditions.push('(e.tags_norm LIKE ? OR e.tags_norm LIKE ? OR e.tags_norm LIKE ? OR e.tags_norm = ?)');
                queryParams.push(`${tag},%`);       // "tag,..." or "tag"
                queryParams.push(`%,${tag},%`);     // "...,tag,..." 
                queryParams.push(`%,${tag}`);       // "...,tag"
                queryParams.push(`%,${tag},`);      // "...,tag," (with trailing comma)
            });
        } else {
            // OR mode: must contain ANY tag (default)
            // Build OR condition with proper CSV matching
            const orConditions = context.tags.map(tag => {
                // Four patterns to cover all cases
                queryParams.push(`${tag},%`);       // "tag,..." or "tag"
                queryParams.push(`%,${tag},%`);     // "...,tag,..."
                queryParams.push(`%,${tag}`);       // "...,tag"
                queryParams.push(`%,${tag},`);      // "...,tag," (with trailing comma)
                return '(e.tags_norm LIKE ? OR e.tags_norm LIKE ? OR e.tags_norm LIKE ? OR e.tags_norm LIKE ?)';
            });
            whereConditions.push(`(${orConditions.join(' OR ')})`);
        }
    }
    
    queryParams.push(candidateLimit);
    
    const sql = `
        SELECT
            e.id,
            e.ts,
            e.created_at,
            e.source_type,
            e.source_id,
            e.model,
            e.vector_dim,
            e.status,
            e.kind,
            e.project,
            e.service,
            e.env,
            e.tags,
            e.tags_norm,
            e.meta_json,
            e.source,
            e.scope,
            e.chat_id,
            e.thread_id,
            e.user_id,
            e.session_id,
            -- Get source content based on source_type
            CASE
                WHEN e.source_type = 'code_snapshot' THEN cs.content
                ELSE NULL
            END as source_content,
            -- L2 distance
            vec_distance_l2(e.vector_raw, ?) as distance
        FROM embeddings e
        LEFT JOIN code_snapshots cs ON e.source_type = 'code_snapshot' AND e.source_id = cs.id
        WHERE ${whereConditions.join(' AND ')}
        ORDER BY distance ASC
        LIMIT ?
    `;
    
    if (process.env.DEBUG_RAG_SQL) {
        runtimeLog('[DEBUG_RAG_SQL] SQL:', sql);
        runtimeLog('[DEBUG_RAG_SQL] Params:', queryParams.slice(0, -1)); // Exclude limit
    }
    
    const candidates = await db.all(sql, queryParams);

    // Stage B: soft reranking with parameterized bonuses
    const now = Date.now();
    
    // If no candidates, return empty
    if (candidates.length === 0) {
        
        return [];
    }
    
    // Normalize distances within candidate set
    const distances = candidates.map(r => r.distance);
    const dmin = Math.min(...distances);
    const dmax = Math.max(...distances);
    const range = dmax - dmin;
    
    const rows = candidates
    .filter(row => allowRowForContext(row, context.memoryContext))
    .map(row => {
        // Normalized similarity: 1 for closest, 0 for farthest in candidate set
        const sim = range < 1e-9 ? 1.0 : 1 - (row.distance - dmin) / range;
        
        // Status bonus
        let statusBonus = weights.statusBonus[row.status] || 0;
        
        // Kind bonus
        const kindBonus = weights.kindBonus[row.kind] || 0;
        
        // Recency bonus (only for chat/log/worklog created in last N days)
        let recencyBonus = 0;
        if (row.created_at && ['chat', 'log', 'worklog'].includes(row.kind)) {
            const created = new Date(row.created_at).getTime();
            const daysAgo = (now - created) / (1000 * 60 * 60 * 24);
            if (daysAgo < weights.recencyDays) {
                recencyBonus = weights.recencyBonusMax * (1 - daysAgo / weights.recencyDays);
            }
        }
        
        // Context bonus: match project/service/env with current context
        let contextBonus = 0;
        if (context.project && row.project && row.project === context.project) {
            contextBonus += weights.contextBonus.project;
            if (process.env.DEBUG_RAG) runtimeLog(`[DEBUG_RAG] context bonus project +${weights.contextBonus.project} for ${row.id}`);
        }
        if (context.service && row.service && row.service === context.service) {
            contextBonus += weights.contextBonus.service;
            if (process.env.DEBUG_RAG) runtimeLog(`[DEBUG_RAG] context bonus service +${weights.contextBonus.service} for ${row.id}`);
        }
        if (context.env && row.env && row.env === context.env) {
            contextBonus += weights.contextBonus.env;
            if (process.env.DEBUG_RAG) runtimeLog(`[DEBUG_RAG] context bonus env +${weights.contextBonus.env} for ${row.id}`);
        }
        
        // Tag bonus: match tags from query (exact CSV matching)
        let tagBonus = 0;
        if (row.tags_norm && queryTags.length > 0) {
            // Normalize tags_norm to have commas at both ends for easier matching
            const tagsNorm = row.tags_norm.startsWith(',') ? row.tags_norm : `,${row.tags_norm}`;
            const normalizedTagsNorm = tagsNorm.endsWith(',') ? tagsNorm : `${tagsNorm},`;
            
            // Count exact matches: tag must be surrounded by commas
            let matched = 0;
            for (const tag of queryTags) {
                if (normalizedTagsNorm.includes(`,${tag},`)) {
                    matched++;
                }
            }
            
            // Calculate bonus: min(tagBonusMax, tagBonusPerMatch * matched)
            tagBonus = Math.min(weights.tagBonusMax, weights.tagBonusPerMatch * matched);
            
            if (process.env.DEBUG_RAG && matched > 0) {
                runtimeLog(`[DEBUG_RAG] tag bonus +${tagBonus.toFixed(3)} for ${row.id}, matched tags: ${matched} (exact CSV matching)`);
            }
        }

        const scopeBoost = scopeBonus(row, context.memoryContext);
        const rowScopeRank = scopeRank(row, context.memoryContext);
        
        const finalScore = sim + statusBonus + kindBonus + recencyBonus + contextBonus + tagBonus + scopeBoost;
        
        return {
            ...row,
            distance: row.distance,
            sim,
            statusBonus,
            kindBonus,
            recencyBonus,
            contextBonus,
            tagBonus,
            scopeBonus: scopeBoost,
            scopeRank: rowScopeRank,
            finalScore
        };
    }).sort((a, b) => {
        if (context.memoryContext.source === 'telegram' && a.scopeRank !== b.scopeRank) {
            return b.scopeRank - a.scopeRank;
        }

        // HARD GUARANTEE: verified ALWAYS comes first, regardless of score
        if (a.status === 'verified' && b.status !== 'verified') return -1;
        if (b.status === 'verified' && a.status !== 'verified') return 1;
        
        // Secondary: higher finalScore for same status
        return b.finalScore - a.finalScore;
    }).slice(0, limit);

    
    return rows;
    } finally {
        if (db) {
            await db.close();
        }
    }
}

function printResults(rows, query) {
    console.log(`\n## Vector search results for: "${query}"\n`);
    if (rows.length === 0) {
        console.log('No matches found.');
        return;
    }

    console.log(`| Rank | Distance | Source | ID |`);
    console.log(`|------|----------|--------|----|`);
    rows.forEach((row, idx) => {
        const source = `${row.source_type}:${row.source_id.substring(0, 8)}`;
        console.log(`| ${idx + 1} | ${row.distance.toFixed(6)} | ${source} | ${row.id.substring(0, 8)} |`);
    });

    console.log('\n### Top match details:\n');
    const top = rows[0];
    if (top) {
        console.log(`- **ID:** ${top.id}`);
        console.log(`- **Source:** ${top.source_type} → ${top.source_id}`);
        console.log(`- **Timestamp:** ${top.ts}`);
        console.log(`- **Model:** ${top.model}`);
        console.log(`- **Vector dimension:** ${top.vector_dim}`);
        if (top.source_content) {
            const preview = top.source_content.substring(0, 200).replace(/\n/g, ' ');
            console.log(`- **Preview:** ${preview}...`);
        }
    }
}

async function main() {
    const query = process.argv.slice(2).join(' ').trim();
    if (!query) {
        console.log('Usage: node memory-db-vector-search.js <query text> [limit]');
        console.log('Example: node memory-db-vector-search.js "llama2 model" 5');
        process.exit(1);
    }
    const limit = parseInt(process.argv[3]) || 10;

    try {
        const results = await vectorSearch(query, limit);
        printResults(results, query);
    } catch (err) {
        console.error('Search failed:', err);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = { vectorSearch, vectorSearchJson };
