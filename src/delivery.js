/**
 * Доставка: что из лорбука попадает в контекст ИИ.
 *
 * Тело блокнота в контекст не уезжает. Три слоя (docs/delivery.md):
 *   1. оглавление — всегда;
 *   2. ядро — записи категорий, помеченных ядром в настройках;
 *   3. предугадывание — записи, чьи «Ключи:» встретились в последних сообщениях.
 *
 * Чистый модуль: текст и настройки на входе, текст инъекции на выходе.
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

/** Совпадение целым словом, без учёта регистра; \b кириллицу не знает. */
function wholeWord(text, word) {
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])`, 'iu').test(text);
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

/**
 * Собирает текст инъекции: оглавление + записи ядра + записи по ключам.
 * Записи вырезаются из хранимого текста как есть, со своими строками.
 * @param {string} content содержимое лорбука
 * @param {{coreCategories?: string[], recentText?: string}} opts
 * @returns {string}
 */
export function buildInjection(content, { coreCategories = [], recentText = '' } = {}) {
    const glossary = glossarySlice(content);
    if (!glossary) return '';

    const model = parseNotebook(content);
    const core = new Set(coreCategories.map(c => c.trim().toUpperCase()).filter(Boolean));

    // маркерная строка каждой записи — из карты разбора
    const markerAbs = new Map();
    for (const [abs, ref] of model.lineIndex) {
        if (ref.l === -1) markerAbs.set(ref.r, abs);
    }

    const lines = String(content).split('\n');
    const picked = [];
    model.records.forEach((rec, ri) => {
        const isCore = rec.category && core.has(rec.category);
        if (!isCore && !keysMatch(rec, recentText)) return;
        const from = markerAbs.get(ri);
        if (!from) return;
        const len = 1 + rec.fields.length + rec.lines.length;
        picked.push(lines.slice(from - 1, from - 1 + len).join('\n'));
    });

    return picked.length ? glossary + '\n' + picked.join('\n' + SEP + '\n') : glossary;
}

// ─── Выборка по команде ──────────────────────────────────────────────

const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн',
    'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];

/** «15.01.2026» -> Date; «15.01» -> текущий год (допущение). Иначе null.
 * Несуществующие даты (32.13, 31.02) отвергаются: JS Date молча перекатывает
 * их в соседний месяц, поэтому сверяем, что собранная дата совпала с разобранной. */
function parseRuDate(s, now) {
    const m = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?$/.exec(String(s).trim());
    if (!m) return null;
    const day = Number(m[1]);
    const month = Number(m[2]);
    const year = m[3] ? Number(m[3]) : now.getFullYear();
    const d = new Date(year, month - 1, day);
    if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
    return d;
}

/** Имя месяца -> его номер, либо -1. «мая»/«маю» тоже узнаётся. */
function monthIndex(word) {
    const w = String(word).toLowerCase();
    if (w === 'мае') return 4;
    for (let i = 0; i < 12; i++) {
        if (i === 4 ? /^ма[йяюе]?$/.test(w) : w.startsWith(MONTHS[i])) return i;
    }
    return -1;
}

/** Месяц по имени: год из слова рядом, иначе текущий, а не наступивший — прошлый (допущение). */
function resolveMonth(idx, yearWord, now) {
    let year = yearWord ? Number(yearWord) : now.getFullYear();
    if (!yearWord && idx > now.getMonth()) year -= 1;
    return { from: new Date(year, idx, 1), to: new Date(year, idx + 1, 0, 23, 59, 59) };
}

/** Граница периода: дата или месяц (начало/конец в зависимости от стороны). */
function resolveBound(word, side, now) {
    const d = parseRuDate(word, now);
    if (d) return side === 'from' ? d : new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);
    const parts = String(word).trim().split(/\s+/);
    const idx = monthIndex(parts[0]);
    if (idx < 0) return null;
    const m = resolveMonth(idx, /^\d{4}$/.test(parts[1] ?? '') ? parts[1] : null, now);
    return side === 'from' ? m.from : m.to;
}

/** Календарный месяц назад: то же число прошлого месяца, с поджатием конца месяца. */
function calendarMonthAgo(now) {
    const y = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    const mo = (now.getMonth() + 11) % 12;
    const lastDay = new Date(y, mo + 1, 0).getDate();
    return new Date(y, mo, Math.min(now.getDate(), lastDay));
}

/**
 * Разбирает аргумент /note_show в набор фильтров. Фильтры комбинируются как И.
 * @returns {{all: boolean, tags: string[], category: string|null, from: Date|null, to: Date|null}}
 */
export function parseQuery(query, now = new Date()) {
    let q = String(query ?? '').trim();
    const out = { all: !q, tags: [], category: null, from: null, to: null, invalid: false };
    if (!q) return out;

    // период «с X по Y»; X и Y — дата или месяц (с годом или без)
    const period = /(?:^|\s)с\s+(.+?)\s+по\s+(.+?)(?=$|\s+#)/iu.exec(q);
    if (period) {
        const from = resolveBound(period[1], 'from', now);
        const to = resolveBound(period[2], 'to', now);
        if (from && to) {
            out.from = from;
            out.to = to;
            if (out.from > out.to) out.from = new Date(out.from.getFullYear() - 1, out.from.getMonth(), out.from.getDate());
        } else {
            // границу периода понять не удалось: лучше пусто, чем лишнее
            out.invalid = true;
        }
        q = (q.slice(0, period.index) + ' ' + q.slice(period.index + period[0].length)).trim();
    }

    // «за последний месяц» — календарный месяц назад от сегодня (допущение)
    if (/за\s+последний\s+месяц/iu.test(q)) {
        out.from = calendarMonthAgo(now);
        out.to = now;
        q = q.replace(/за\s+последний\s+месяц/iu, ' ').trim();
    }

    for (const word of q.split(/\s+/).filter(Boolean)) {
        if (word.startsWith('#')) {
            out.tags.push(word.slice(1).toLowerCase());
            continue;
        }
        const d = parseRuDate(word, now);
        if (d) {
            out.from = d;
            out.to = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);
            continue;
        }
        const mi = monthIndex(word);
        if (mi >= 0 && !out.from) {
            const m = resolveMonth(mi, null, now);
            out.from = m.from;
            out.to = m.to;
            continue;
        }
        if (/^\d{4}$/.test(word) && out.from) {
            // год после имени месяца: пересчитать границы на этот год
            const mi2 = out.from.getMonth();
            const m = resolveMonth(mi2, word, now);
            out.from = m.from;
            out.to = m.to;
            continue;
        }
        out.category = word.toUpperCase();
    }
    return out;
}

/**
 * Выполняет команду выборки над содержимым лорбука. Фильтры — как И.
 * @returns {string} текст выборки; пусто, если ничего не нашлось
 */
export function runQuery(content, query, now = new Date()) {
    const f = parseQuery(query, now);
    if (f.invalid) return '';
    if (f.all) return String(content ?? '');

    const model = parseNotebook(content);
    const lines = String(content).split('\n');
    const markerAbs = new Map();
    for (const [abs, ref] of model.lineIndex) {
        if (ref.l === -1) markerAbs.set(ref.r, abs);
    }

    const match = (rec) => {
        for (const t of f.tags) {
            if (!rec.tags.includes(t) && !rec.lines.some(l => l.tag === t)) return false;
        }
        if (f.category && rec.category !== f.category) return false;
        if (f.from || f.to) {
            const d = parseRuDate(rec.date, new Date(0));
            if (!d) return false;
            if (f.from && d < f.from) return false;
            if (f.to && d > f.to) return false;
        }
        return true;
    };

    const picked = [];
    model.records.forEach((rec, ri) => {
        if (!match(rec)) return;
        const from = markerAbs.get(ri);
        if (!from) return;
        const len = 1 + rec.fields.length + rec.lines.length;
        picked.push(lines.slice(from - 1, from - 1 + len).join('\n'));
    });
    return picked.join('\n' + SEP + '\n');
}
