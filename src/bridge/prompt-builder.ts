import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { MemoryStore, SearchResult } from '../memory/store.js';
import { touchUserProfile, formatUserProfile } from './user-profile.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, 'prompts');
const DATA_DIR = join(__dirname, '..', '..', 'data');

/** Load and cache prompt layer files. */
const layerCache = new Map<string, string>();

function loadLayer(name: string): string {
  if (layerCache.has(name)) return layerCache.get(name)!;
  try {
    const content = readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf-8').trim();
    layerCache.set(name, content);
    return content;
  } catch {
    console.warn(`[prompt] Layer "${name}" not found, skipping`);
    return '';
  }
}

/**
 * Build the static system prompt file (soul + mind + personality).
 * Written once at startup, reused for every invocation.
 * Returns the file path.
 */
export function buildSystemPromptFile(): string {
  mkdirSync(DATA_DIR, { recursive: true });
  const filePath = join(DATA_DIR, 'system-prompt.md');

  const layers = ['soul', 'mind', 'personality']
    .map(loadLayer)
    .filter(Boolean);

  // Inject owner name from env if set (keeps prompts anonymous in repo)
  const ownerName = process.env.OWNER_NAME;
  if (ownerName) {
    layers.push(`Le nom de ton owner est ${ownerName}.`);
  }

  writeFileSync(filePath, layers.join('\n\n---\n\n'));
  return filePath;
}

export interface DynamicContext {
  senderName: string;
  memory?: MemoryStore;
  message: string;
  platform?: 'whatsapp' | 'mattermost';
}

/**
 * Build the dynamic context to append to the system prompt.
 * Contains: platform info + user profile + relevant memory entries.
 * This changes per message (unlike the static system prompt).
 */
export function buildDynamicContext(ctx: DynamicContext): string {
  const parts: string[] = [];

  if (ctx.platform) {
    const label = ctx.platform === 'whatsapp' ? 'WhatsApp' : 'Mattermost';
    parts.push(`Plateforme active : ${label}`);
  }

  if (ctx.memory) {
    // User profile
    try {
      const profile = touchUserProfile(ctx.memory, ctx.senderName);
      const profileBlock = formatUserProfile(profile);
      if (profileBlock) parts.push(profileBlock);
    } catch { /* skip */ }

    // Memory search
    try {
      const results = ctx.memory.search(ctx.message, { limit: 5 });
      const memoryBlock = formatMemoryContext(results);
      if (memoryBlock) parts.push(memoryBlock);
    } catch { /* skip */ }
  }

  return parts.join('\n\n');
}

function formatMemoryContext(results: SearchResult[]): string {
  if (results.length === 0) return '';

  const lines = results.map(r => {
    const path = [r.entry.zone, r.entry.theme || '_', r.entry.name].join('/');
    const content = r.entry.content.length > 500
      ? r.entry.content.slice(0, 500) + '...'
      : r.entry.content;
    return `[${path}] ${content}`;
  });

  return `Contexte mémoire pertinent :\n${lines.join('\n')}`;
}

// Legacy function kept for test compatibility
export interface PromptContext {
  message: string;
  senderName: string;
  channelId: string;
  history: { format(channelId: string): string };
  memory?: MemoryStore;
}

export function buildPrompt(ctx: PromptContext): string {
  const parts: string[] = [];

  const soul = loadLayer('soul');
  const mind = loadLayer('mind');
  const personality = loadLayer('personality');

  if (soul) parts.push(soul);
  if (mind) parts.push(mind);
  if (personality) parts.push(personality);

  if (ctx.memory) {
    try {
      const profile = touchUserProfile(ctx.memory, ctx.senderName);
      const profileBlock = formatUserProfile(profile);
      if (profileBlock) parts.push(profileBlock);
    } catch { /* skip */ }

    try {
      const results = ctx.memory.search(ctx.message, { limit: 5 });
      const memoryBlock = formatMemoryContext(results);
      if (memoryBlock) parts.push(memoryBlock);
    } catch { /* skip */ }
  }

  const historyBlock = ctx.history.format(ctx.channelId);
  if (historyBlock) parts.push(historyBlock);

  parts.push(`Message de @${ctx.senderName} :\n${ctx.message}`);

  return parts.join('\n\n---\n\n');
}
