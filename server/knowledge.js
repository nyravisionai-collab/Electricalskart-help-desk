import fs from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { all, run } from './db.js';

const knowledgeEntrySchema = z.object({
  id: z.string().trim().min(1).max(100).optional(),
  topic: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(4000),
  keywords: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  source: z.string().trim().min(1).max(500),
  active: z.boolean().default(true),
});

const stopWords = new Set([
  'a', 'an', 'and', 'are', 'can', 'do', 'for', 'from', 'help', 'i', 'in', 'is',
  'it', 'me', 'my', 'of', 'on', 'please', 'the', 'to', 'we', 'what', 'with', 'you', 'your',
]);

const intentGroups = [
  ['price', 'pricing', 'cost', 'quote'],
  ['stock', 'availability', 'available'],
  ['hour', 'hours', 'timing', 'open', 'close'],
  ['install', 'installation'],
  ['warranty', 'guarantee'],
  ['payment', 'cash', 'upi', 'card', 'emi'],
  ['delivery', 'shipping'],
  ['return', 'refund', 'cancel'],
];

function normalizeWords(value) {
  return new Set(
    String(value || '')
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter(word => word.length > 1 && !stopWords.has(word)) || [],
  );
}

function deserializeEntry(row) {
  let keywords = [];
  try { keywords = JSON.parse(row.keywords || '[]'); } catch { keywords = []; }
  return {
    id: row.id,
    topic: row.topic,
    title: row.title,
    content: row.content,
    keywords,
    source: row.source,
    verifiedAt: row.verified_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    active: Boolean(row.is_active),
  };
}

export function listKnowledgeEntries({ activeOnly = false } = {}) {
  const rows = all(
    `SELECT id, topic, title, content, keywords, source, is_active, verified_at, updated_at, updated_by
     FROM knowledge_entries ${activeOnly ? 'WHERE is_active = 1' : ''}
     ORDER BY topic, title`,
  );
  return rows.map(deserializeEntry);
}

export function saveKnowledgeEntry(input, updatedBy = null) {
  const parsed = knowledgeEntrySchema.parse(input);
  const id = parsed.id || `kb_${nanoid(12)}`;
  const timestamp = Date.now();
  run(
    `INSERT INTO knowledge_entries
       (id, topic, title, content, keywords, source, is_active, verified_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       topic = excluded.topic,
       title = excluded.title,
       content = excluded.content,
       keywords = excluded.keywords,
       source = excluded.source,
       is_active = excluded.is_active,
       verified_at = excluded.verified_at,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
    [
      id,
      parsed.topic,
      parsed.title,
      parsed.content,
      JSON.stringify(parsed.keywords),
      parsed.source,
      parsed.active ? 1 : 0,
      timestamp,
      timestamp,
      updatedBy,
    ],
  );
  return listKnowledgeEntries().find(entry => entry.id === id);
}

export function findVerifiedKnowledge(question, limit = 5) {
  const queryWords = normalizeWords(question);
  if (queryWords.size === 0) return [];
  const requiredIntent = intentGroups.find(group => group.some(word => queryWords.has(word)));

  return listKnowledgeEntries({ activeOnly: true })
    .map(entry => {
      const keywordWords = normalizeWords(entry.keywords.join(' '));
      const titleWords = normalizeWords(`${entry.topic} ${entry.title}`);
      const contentWords = normalizeWords(entry.content);
      if (requiredIntent) {
        const entryWords = new Set([...keywordWords, ...titleWords, ...contentWords]);
        if (!requiredIntent.some(word => entryWords.has(word))) return { entry, score: 0 };
      }
      let score = 0;
      for (const word of queryWords) {
        if (keywordWords.has(word)) score += 5;
        if (titleWords.has(word)) score += 3;
        if (contentWords.has(word)) score += 1;
      }
      return { entry, score };
    })
    .filter(result => result.score >= 3)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(result => result.entry);
}

export async function importKnowledgeFile(filePath = process.env.BUSINESS_KNOWLEDGE_FILE) {
  if (!filePath) return 0;
  const resolved = path.resolve(filePath);
  const raw = await fs.readFile(resolved, 'utf8');
  const parsedJson = JSON.parse(raw);
  const entries = z.array(knowledgeEntrySchema).parse(parsedJson);
  for (const entry of entries) saveKnowledgeEntry(entry, null);
  console.log(`[knowledge] Imported ${entries.length} verified entries from configured knowledge file.`);
  return entries.length;
}

export { knowledgeEntrySchema };
