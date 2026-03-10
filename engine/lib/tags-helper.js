/**
 * Extract tags from file path and optional heading path.
 * Returns { tags: string (CSV), tags_norm: string (lowercase, unique, sorted) }.
 */
function extractTags(filePath, headingPath = '', envTags = []) {
    const all = new Set();
    
    // Add envTags first
    if (envTags && Array.isArray(envTags)) {
        envTags.forEach(tag => all.add(tag));
    }
    
    // File path patterns
    const path = filePath.toLowerCase();
    const patterns = [
        { tag: 'docker', test: /\/docker\// },
        { tag: 'container', test: /\/docker\// }, // Also add container tag for docker
        { tag: 'xray', test: /\/xray\// },
        { tag: 'vpn', test: /\/xray\// }, // Also add vpn tag for xray
        { tag: 'nuxt', test: /\/nuxt\// },
        { tag: 'frontend', test: /\/nuxt\// }, // Also add frontend tag for nuxt
        { tag: 'n8n', test: /\/n8n\// },
        { tag: 'automation', test: /\/n8n\// }, // Also add automation tag for n8n
        { tag: 'nginx', test: /nginx/ },
        { tag: 'systemd', test: /systemd/ },
        { tag: 'traefik', test: /traefik/ },
        { tag: 'postgres', test: /postgres/ },
        { tag: 'sqlite', test: /sqlite/ },
        { tag: 'ollama', test: /ollama/ },
        { tag: 'openclaw', test: /openclaw/ },
        { tag: 'bash', test: /\.sh$/ },
        { tag: 'shell', test: /\.(sh|bash|zsh)$/ },
        { tag: 'javascript', test: /\.js$/ },
        { tag: 'typescript', test: /\.ts$/ },
        { tag: 'python', test: /\.py$/ },
        { tag: 'json', test: /\.json$/ },
        { tag: 'yaml', test: /\.(yaml|yml)$/ },
        { tag: 'xml', test: /\.xml$/ },
        { tag: 'markdown', test: /\.md$/ },
        { tag: 'sql', test: /\.sql$/ },
        { tag: 'env', test: /\.env$/ },
        { tag: 'config', test: /(config|conf)\./ },
        { tag: 'git', test: /\.git\// },
    ];
    
    for (const { tag, test } of patterns) {
        if (test.test(path)) {
            all.add(tag);
        }
    }
    
    // Extract from directory names (first level under known projects)
    const dirs = path.split('/');
    for (let i = 0; i < dirs.length; i++) {
        const dir = dirs[i];
        if (dir === 'projects' && i + 1 < dirs.length) {
            all.add(dirs[i + 1]); // project name as tag
        }
    }
    
    // Heading path keywords
    const heading = headingPath.toLowerCase();
    const headingKeywords = [
        'decision', 'runbook', 'postmortem', 'config', 'doc', 'memory', 
        'agents', 'soul', 'user', 'tools', 'heartbeat', 'context-safety',
        'preferences', 'completed', 'active', 'stable', 'model', 'switch',
        'fallback', 'manual', 'automatic', 'checkpoint', 'health', 'cron',
        'zoom', 'ai', 'conference', 'landing', 'email', 'security', 'audit',
        'update', 'compaction', 'monitor', 'context', 'window', 'vector',
        'search', 'promotion', 'ttl', 'cleanup', 'deprecate', 'archive',
        'ranking', 'metadata', 'filtering', 'conversation', 'ingest',
        'chunk', 'heading', 'source', 'open', 'helper', 'tag',
        'deployment', 'production', 'container'
    ];
    
    for (const kw of headingKeywords) {
        if (heading.includes(kw)) {
            all.add(kw);
        }
    }
    
    // Normalize: lowercase, remove spaces, unique, sorted
    const normalized = Array.from(all).map(t => t.toLowerCase().replace(/\s+/g, '-'));
    const unique = [...new Set(normalized)].sort();
    
    return {
        tags: unique.join(', '),
        tags_norm: unique.join(',')
    };
}

/**
 * Extract tags from query text.
 * Returns array of normalized tags found in query.
 */
function extractQueryTags(query) {
    const text = query.toLowerCase();
    const allTags = [
        // Tech stack
        'docker', 'container', 'xray', 'vpn', 'nuxt', 'frontend', 'n8n', 'automation',
        'nginx', 'systemd', 'traefik', 'postgres', 'sqlite', 'ollama', 'openclaw', 
        'bash', 'shell', 'javascript', 'typescript', 'python', 'json', 'yaml', 'xml',
        'markdown', 'sql', 'env', 'config', 'git',
        // Concepts
        'decision', 'runbook', 'postmortem', 'config', 'doc', 'memory',
        'agents', 'soul', 'user', 'tools', 'heartbeat', 'context-safety',
        'preferences', 'completed', 'active', 'stable', 'model', 'switch',
        'fallback', 'manual', 'automatic', 'checkpoint', 'health', 'cron',
        'zoom', 'ai', 'conference', 'landing', 'email', 'security', 'audit',
        'update', 'compaction', 'monitor', 'context', 'window', 'vector',
        'search', 'promotion', 'ttl', 'cleanup', 'deprecate', 'archive',
        'ranking', 'metadata', 'filtering', 'conversation', 'ingest',
        'chunk', 'heading', 'source', 'open', 'helper', 'tag',
        'deployment', 'production', 'container'
    ];
    const found = new Set();
    // Simple word matching
    const words = text.split(/\W+/);
    for (const word of words) {
        if (allTags.includes(word)) {
            found.add(word);
        }
    }
    // Also check for multi-word patterns
    if (text.includes('docker compose') || text.includes('docker-compose')) found.add('docker');
    if (text.includes('postgresql')) found.add('postgres');
    if (text.includes('node.js') || text.includes('nodejs')) found.add('javascript');
    if (text.includes('typescript')) found.add('typescript');
    if (text.includes('bash script')) found.add('bash');
    // Map related terms
    if (text.includes('container')) found.add('docker');
    if (text.includes('vpn')) found.add('xray');
    if (text.includes('frontend')) found.add('nuxt');
    if (text.includes('automation')) found.add('n8n');
    return Array.from(found).sort();
}

module.exports = { extractTags, extractQueryTags };