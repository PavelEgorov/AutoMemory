/**
 * Доставка: что из лорбука попадает в контекст ИИ.
 *
 * Тело блокнота в контекст не уезжает. Три слоя (docs/delivery.md):
 *   1. оглавление — всегда;
 *   2. ядро — записи категорий, помеченных ядром в настройках;
 *   3. предугадывание — записи, чьи «Ключи:» встретились в последних сообщениях.
 * Четвёртый путь — выборка инструментом note_show по запросу модели.
 *
 * Чистый модуль: текст и настройки на входе, текст на выходе. Дат в формате нет.
 */

import { parseNotebook } from './notebook.js';

const SEP = '---';

/** Оглавление — от начала до первого разделителя включительно. */
export function glossarySlice(content) {
    const lines = String(content ?? '').split('\n');
    let i = 0;
    while (i < lines.length && !lines[i].trim()) i++;
    if (!lines[i] || !lines[i].trim().startsWith('[INDEX]')) return '';
    for (let k = i; k < lines.length; k++) {
        if (lines[k].trim() === SEP) return lines.slice(i, k + 1).join('\n');
    }
    return lines.slice(i).join('\n');
}

/** Совпадение целым словом, без учёта регистра. Без \b (не знает кириллицу)
 * и без lookbehind (нет в старых Safari). */
function wholeWord(text, word) {
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${esc}(?:[^\\p{L}\\p{N}_]|$)`, 'iu').test(text);
}

/** Сработали ли «Ключи:» записи на недавнем тексте разговора. */
function keysMatch(record, recentText) {
    if (!recentText) return false;
    const f = record.fields.find(x => x.key === 'Ключи');
    if (!f) return false;
    return f.value.split(',')
        .map(k => k.trim())
        .filter(Boolean)
        .some(k => wholeWord(recentText, k));
}

/** Маркерные строки записей: индекс записи -> абсолютный номер строки. */
function markerLines(model) {
    const markerAbs = new Map();
    for (const [abs, ref] of model.lineIndex) {
        if (ref.l === -1) markerAbs.set(ref.r, abs);
    }
    return markerAbs;
}

/** Кусок хранимого текста с записью ri — как есть, со своими строками. */
function sliceRecord(lines, model, markerAbs, ri) {
    const from = markerAbs.get(ri);
    if (!from) return null;
    const rec = model.records[ri];
    const len = 1 + rec.fields.length + rec.lines.length;
    return lines.slice(from - 1, from - 1 + len).join('\n');
}

/**
 * Собирает текст инъекции: оглавление + записи ядра + записи по ключам.
 * @param {string} content содержимое лорбука
 * @param {{coreCategories?: string[], recentText?: string}} opts
 * @returns {string}
 */
export function buildInjection(content, { coreCategories = [], recentText = '' } = {}) {
    const glossary = glossarySlice(content);
    if (!glossary) return '';

    const model = parseNotebook(content);
    const core = new Set(coreCategories.map(c => c.trim().toUpperCase()).filter(Boolean));
    const markerAbs = markerLines(model);
    const lines = String(content).split('\n');

    const picked = [];
    model.records.forEach((rec, ri) => {
        const isCore = rec.category && core.has(rec.category);
        if (!isCore && !keysMatch(rec, recentText)) return;
        const text = sliceRecord(lines, model, markerAbs, ri);
        if (text) picked.push(text);
    });

    return picked.length ? glossary + '\n' + picked.join('\n' + SEP + '\n') : glossary;
}

// ─── Выборка по запросу ──────────────────────────────────────────────

/**
 * Разбирает фильтр инструмента note_show. Части через пробел, работают как И:
 * слова с решёткой — теги, остальные — категория.
 * @returns {{all: boolean, tags: string[], category: string|null}}
 */
export function parseQuery(query) {
    const q = String(query ?? '').trim();
    const out = { all: !q, glossary: false, tags: [], category: null };
    if (q.toLowerCase() === 'оглавление') {
        out.glossary = true;
        return out;
    }
    for (const word of q.split(/\s+/).filter(Boolean)) {
        if (word.startsWith('#')) {
            const tag = word.slice(1).toLowerCase();
            if (tag && !out.tags.includes(tag)) out.tags.push(tag);
        } else {
            out.category = word.toUpperCase();
        }
    }
    return out;
}

/**
 * Выполняет выборку над содержимым лорбука.
 * @returns {string} текст выборки; пусто, если ничего не нашлось
 */
export function runQuery(content, query) {
    const f = parseQuery(query);
    if (f.glossary) return glossarySlice(content);
    if (f.all) return String(content ?? '');

    const model = parseNotebook(content);
    const markerAbs = markerLines(model);
    const lines = String(content).split('\n');

    const match = (rec) => {
        for (const t of f.tags) {
            if (!rec.tags.includes(t) && !rec.lines.some(l => l.tag === t)) return false;
        }
        if (f.category && rec.category !== f.category) return false;
        return true;
    };

    const picked = [];
    model.records.forEach((rec, ri) => {
        if (!match(rec)) return;
        const text = sliceRecord(lines, model, markerAbs, ri);
        if (text) picked.push(text);
    });
    return picked.join('\n' + SEP + '\n');
}
