#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { getConfig } = require('../lib/config.js');
const { extractTags } = require('../lib/tags-helper.js');

const MAX_CHARS = 6000;
const MIN_CHARS = 400;
const OVERLAP_CHARS = 600;

async function getDb() {
    const config = getConfig();
    let db;
    try {
        db = await open({
            filename: config.dbPath,
            driver: sqlite3.Database
        });
        // Set busy timeout and WAL mode for concurrent writes
        await db.exec('PRAGMA busy_timeout = 5000;');
        await db.exec('PRAGMA journal_mode = WAL;');
        return db;
    } catch (error) {
        console.error('Failed to open database:', error);
        throw error;
    }
}

function getMetadata(filePath, headingPath = '') {
    const config = getConfig();
    const env = config.env;
    let project = config.project;
    let service = null;
    const servicePatterns = ['docker', 'xray', 'nuxt', 'n8n'];
    for (const pattern of servicePatterns) {
        if (filePath.includes(`/${pattern}/`)) {
            service = pattern;
            break;
        }
    }
    // Extract envTags from environment variable (comma-separated)
    const envTags = config.tags;
    // Extract tags from file path, heading path, and envTags
    const { tags, tags_norm } = extractTags(filePath, headingPath, envTags);
    return { project, service, env, tags, tags_norm };
}

async function generateEmbedding(content) {
    const config = getConfig();
    try {
        const response = await fetch(`${config.ollamaUrl}/api/embed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: config.embedModel,
                input: content
            })
        });

        if (!response.ok) {
            throw new Error(`Ollama API error: ${response.statusText}`);
        }

        const data = await response.json();
        if (data.embeddings && data.embeddings.length > 0) {
            const vecArray = data.embeddings[0];
            const dim = vecArray.length;
            // JSON version for backward compatibility
            const jsonBuffer = Buffer.from(JSON.stringify(vecArray));
            // Raw float32 buffer for vector extension
            const float32 = new Float32Array(vecArray);
            const rawBuffer = Buffer.from(float32.buffer);
            return { json: jsonBuffer, raw: rawBuffer, dim, status: 'ok', error: null };
        } else {
            throw new Error('No embeddings returned from Ollama');
        }
    } catch (error) {
        console.error("Error generating embedding via Ollama:", error.message);
        // HARD GUARDRAIL: Never return zero-vector
        // If embedding fails → status='failed', vector_raw=NULL, vector_dim=NULL
        return { 
            json: null, 
            raw: null, 
            dim: null, 
            status: 'failed', 
            error: error.message 
        };
    }
}

/**
 * Splits markdown content into sections based on headings.
 * Returns array of { headingPath, content, startLine, endLine }.
 */
function splitMarkdownByHeadings(content, filePath) {
    const lines = content.split('\n');
    const sections = [];
    let currentHeadingPath = [];
    let currentContent = [];
    let startLine = 0;
    let inCodeBlock = false;
    let lineNumber = 0;

    function pushSection() {
        if (currentContent.length > 0) {
            const content = currentContent.join('\n').trim();
            // Keep sections regardless of MIN_CHARS; filtering later
            sections.push({
                headingPath: currentHeadingPath.join(' > '),
                content,
                startLine: startLine + 1,
                endLine: lineNumber,
                filePath
            });
        }
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        lineNumber = i + 1;

        // Toggle code block detection (simple)
        if (line.startsWith('```')) {
            inCodeBlock = !inCodeBlock;
        }

        if (!inCodeBlock && line.startsWith('#')) {
            const match = line.match(/^(#{1,6})\s+(.*)$/);
            if (match) {
                const level = match[1].length;
                const title = match[2].trim();
                // Push previous section (could be root content or previous heading section)
                pushSection();
                // Update heading path
                while (currentHeadingPath.length >= level) {
                    currentHeadingPath.pop();
                }
                currentHeadingPath.push(title);
                // Start new section with this heading line included
                currentContent = [line];
                startLine = i;
            } else {
                // Not a valid heading format, treat as normal content
                currentContent.push(line);
            }
        } else {
            currentContent.push(line);
        }
    }
    // Push last section
    pushSection();
    return sections;
}

/**
 * Further splits a section into chunks if it exceeds MAX_CHARS.
 * Uses paragraph splitting with overlap, falls back to line splitting if needed.
 * Returns array of { headingPath, content, startLine, endLine, filePath, chunkIndex }.
 */
function chunkSection(section) {
    const { content, headingPath, startLine, endLine, filePath } = section;
    if (content.length <= MAX_CHARS) {
        // Single chunk, index 0
        return [{
            headingPath,
            content: content.trim(),
            startLine,
            endLine,
            filePath,
            chunkIndex: 0
        }];
    }
    // Split by double newline (paragraphs)
    const paragraphs = content.split(/\n\s*\n/);
    // If any paragraph is still too large, split by single newline
    const needsLineSplit = paragraphs.some(p => p.length > MAX_CHARS);
    const splitPattern = needsLineSplit ? /\n/ : /\n\s*\n/;
    const parts = content.split(splitPattern);
    
    const chunks = [];
    let currentChunk = '';
    let currentStartLine = startLine;
    let partStartLine = startLine;
    let chunkIndex = 0;

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (currentChunk.length + part.length > MAX_CHARS) {
            // Finalize current chunk if it meets minimum size
            if (currentChunk.length >= MIN_CHARS) {
                chunks.push({
                    headingPath,
                    content: currentChunk.trim(),
                    startLine: currentStartLine,
                    endLine: partStartLine - 1,
                    filePath,
                    chunkIndex: chunkIndex++
                });
            }
            // Start new chunk with overlap: include last OVERLAP_CHARS from previous chunk
            let overlap = '';
            if (chunks.length > 0) {
                const prevContent = chunks[chunks.length - 1].content;
                overlap = prevContent.slice(-OVERLAP_CHARS);
            }
            currentChunk = overlap + (splitPattern.source === '\\n' ? '\n' : '\n\n') + part;
            currentStartLine = partStartLine;
        } else {
            if (currentChunk) {
                currentChunk += (splitPattern.source === '\\n' ? '\n' : '\n\n') + part;
            } else {
                currentChunk = part;
            }
        }
        // Approximate line counting: each part roughly lines count
        partStartLine += part.split('\n').length + (splitPattern.source === '\\n' ? 1 : 2);
    }
    // Push final chunk
    if (currentChunk.length >= MIN_CHARS) {
        chunks.push({
            headingPath,
            content: currentChunk.trim(),
            startLine: currentStartLine,
            endLine,
            filePath,
            chunkIndex: chunkIndex
        });
    }
    return chunks;
}

/**
 * Determine kind based on heading path.
 */
function determineKind(headingPath) {
    const lower = headingPath.toLowerCase();
    if (lower.includes('decision')) {
        return 'decision';
    }
    if (lower.includes('runbook') || lower.includes('playbook')) {
        return 'runbook';
    }
    if (lower.includes('postmortem')) {
        return 'postmortem';
    }
    return 'doc';
}

/**
 * Whether the file is considered an official knowledge base (e.g., MEMORY.md).
 * Decisions/runbooks/postmortems from such files can be auto‑verified.
 */
function isOfficialFile(filePath) {
    const officialNames = [
        'MEMORY.md',
        'AGENTS.md',
        'SOUL.md',
        'USER.md',
        'TOOLS.md',
        'IDENTITY.md',
        'HEARTBEAT.md',
        'CONTEXT-SAFETY.md'
    ];
    const base = path.basename(filePath);
    return officialNames.includes(base);
}

/**
 * Normalize text for consistent hashing:
 * - Replace CRLF with LF
 * - Trim trailing spaces per line
 * - Ensure single newline at end
 */
function normalizeText(text) {
    return text
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map(line => line.trimEnd())
        .join('\n')
        .trim() + '\n';
}

/**
 * Encode a heading path for use in a '#'‑separated source ID.
 * Replaces any '#' with '%23' to avoid breaking the separator.
 */
function encodeHeadingPath(headingPath) {
    return headingPath.replace(/#/g, '%23');
}

async function ingestDocFile(filePath) {
    const db = await getDb();
    const absoluteFilePath = path.resolve(filePath);
    const content = await fs.readFile(absoluteFilePath, 'utf-8');
    
    // Optional: skip conversation metadata if needed
    // if (content.includes('Conversation info (untrusted metadata)')) {
    //     console.log(`Skipping ${filePath}: contains conversation metadata`);
    //     await db.close();
    //     return;
    // }
    
    const sections = splitMarkdownByHeadings(content, filePath);
    let totalChunks = 0;
    let skipped = 0;
    for (const section of sections) {
        const chunks = chunkSection(section);
        for (const chunk of chunks) {
            // Normalized text for consistent hashing
            const normalized = normalizeText(chunk.content);
            const contentHash = crypto.createHash('sha256').update(normalized).digest('hex');
            const ts = new Date().toISOString();
            const kind = determineKind(chunk.headingPath);
            const { project, service, env, tags, tags_norm } = getMetadata(absoluteFilePath, chunk.headingPath);
            
            // Auto‑verification for official knowledge‑base files
            let status = 'ok';
            if (isOfficialFile(filePath) && (kind === 'decision' || kind === 'runbook' || kind === 'postmortem')) {
                status = 'verified';
            }
            
            // Source ID format: <filepath>#<heading_path>#<chunk_index>
            const encodedHeading = encodeHeadingPath(chunk.headingPath);
            const sourceId = `${absoluteFilePath}#${encodedHeading}#${chunk.chunkIndex}`;
            
            // Check if this chunk already exists with same content hash
            const existing = await db.get(
                `SELECT id, content_hash FROM embeddings WHERE source_type = ? AND source_id = ?`,
                'doc', sourceId
            );
            if (existing) {
                if (existing.content_hash === contentHash) {
                    // Update metadata (tags, project, service, env) in case they changed
                    await db.run(
                        `UPDATE embeddings SET ts = ?, project = ?, service = ?, env = ?, tags = ?, tags_norm = ? WHERE id = ?`,
                        ts, project, service, env, tags, tags_norm, existing.id
                    );
                    console.log(`Updated metadata for existing doc chunk ${chunk.headingPath} (${chunk.startLine}-${chunk.endLine})`);
                    skipped++;
                    continue;
                } else {
                    // Content changed, delete old entry
                    await db.run(`DELETE FROM embeddings WHERE id = ?`, existing.id);
                    console.log(`Removed outdated embedding for ${sourceId}`);
                }
            }
            
            // Generate embedding
            const embedding = await generateEmbedding(chunk.content);
            const dbStatus = embedding.status === 'ok' ? status : embedding.status;
            // TTL: for doc/decision/runbook/postmortem, no expiration (NULL)
            const createdAt = ts.replace('T', ' ').substring(0, 19);
            const ttlUntilSql = null; // permanent
            
            // Metadata for easier retrieval and promotion
            const metaJson = JSON.stringify({
                headingPath: chunk.headingPath,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                filePath: absoluteFilePath,
                chunkIndex: chunk.chunkIndex
            });
            
            const embeddingId = uuidv4();
            await db.run(
                `INSERT INTO embeddings (id, ts, source_type, source_id, content_hash, vector, vector_raw, vector_dim, model, meta_json, status, error_text, kind, created_at, ttl_until, project, service, env, tags, tags_norm)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                embeddingId, ts, 'doc', sourceId, contentHash,
                embedding.json, embedding.raw, embedding.dim, getConfig().embedModel, metaJson,
                dbStatus, embedding.error, kind, createdAt, ttlUntilSql, project, service, env, tags, tags_norm
            );
            const statusMsg = embedding.status === 'ok' ? 'ingested' : 'failed';
            console.log(`Doc chunk ${chunk.headingPath} (${chunk.startLine}-${chunk.endLine}) ${statusMsg} with ID: ${embeddingId}`);
            totalChunks++;
        }
    }
    await db.close();
    console.log(`Ingested ${totalChunks} chunks, skipped ${skipped} unchanged from ${absoluteFilePath}`);
}

async function main() {
    const glob = require('glob');
    const args = process.argv.slice(2);
    if (args.length < 1) {
        console.error('Usage: node bin/ingest-docs.js <directory> [pattern]');
        console.error('Example: node bin/ingest-docs.js ~/notes "**/*.md"');
        process.exit(1);
    }
    const dir = args[0];
    const pattern = args[1] || '**/*.md';
    const fullPattern = path.join(dir, pattern);
    const files = glob.sync(fullPattern, { nodir: true });
    console.log(`Found ${files.length} files matching ${fullPattern}`);
    for (const file of files) {
        try {
            await ingestDocFile(file);
        } catch (error) {
            console.error(`Error ingesting ${file}:`, error);
        }
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
}
