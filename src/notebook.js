/**
 * Ядро формата блокнота: разбор текста, сборка, оглавление, нумерация.
 *
 * Про SillyTavern здесь не знают ничего: на входе строка, на выходе строка.
 * Формат описан в docs/structure.md. Текст никогда не выбрасывается:
 * непонятные строки сохраняются, «---» в тексте записи не рвёт её.
 */

import { RE_FIELD, RE_TAGGED, parseMarkerTags } from './patterns.js';

const SEP = '---';
const INDEX_MARKER = '[INDEX] [META]';

/** Маркер записи: [дата] [КАТЕГОРИЯ] хвост. Категория необязательна. */
const RE_MARKER = /^\[([^\]]*)\]\s*\[([^\]]+)\](.*)$/;
/** Маркер без категории: только дата ДД.ММ.ГГГГ — иначе любая [скобка] стала бы маркером */
const RE_MARKER_BARE = /^\[(\d{2}\.\d{2}\.\d{4})\](.*)$/;
/** Голова строки оглавления: «- ИМЯ — пояснение» или «- ИМЯ» */
const RE_GLOSS_HEAD = /^-\s+(.+?)(?:\s+—\s+(.+))?$/;
/** Отметка об уточнении на маркере — при разборе снимаем, при сборке ставим заново */
const RE_MARK = /\s*→\s*стр\.\s*\d+\s+уточнена\s+в\s+\d+/g;

// ─── Разбор ──────────────────────────────────────────────────────────

/** «---» закрывает запись, только если дальше маркер или конец текста. Иначе это текст. */
function isSeparator(lines, i) {
    for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (!next) continue;
        if (next === SEP) return true;
        return RE_MARKER.test(next) || RE_MARKER_BARE.test(next);
    }
    return true; // конец текста
}

/**
 * Разбирает текст блокнота.
 * @param {string} content
 * @returns {{records: object[], preamble: string[], descriptions: object, lineIndex: Map}}
 */
export function parseNotebook(content) {
    const lines = String(content ?? '').split('\n');
    const descriptions = { cat: {}, tag: {} };
    let i = 0;

    // ведущие пустые строки не должны прятать оглавление
    while (i < lines.length && !lines[i].trim()) i++;

    // Оглавление — от [INDEX] до первого разделителя
    if (lines[i] && lines[i].trim().startsWith('[INDEX]')) {
        let end = -1;
        for (let k = i; k < lines.length; k++) {
            if (lines[k].trim() === SEP) { end = k; break; }
        }
        if (end < 0) end = lines.length - 1;
        for (let k = i + 1; k < end; k++) {
            // имя и пояснение — в голове строки, до счётчиков за « · »
            const head = lines[k].split(' · ')[0];
            const m = RE_GLOSS_HEAD.exec(head);
            if (!m || !m[2]) continue;
            const name = m[1].trim();
            const desc = m[2].trim();
            if (name.startsWith('#')) descriptions.tag[name.slice(1).toLowerCase()] = desc;
            else descriptions.cat[name.toUpperCase()] = desc;
        }
        i = end + 1;
    }

    // Тело
    const records = [];
    const preamble = [];
    /** абсолютный номер строки -> {r, l}; l === -1 значит «маркер, запись целиком» */
    const lineIndex = new Map();
    let cur = null;
    let phase = 'marker';

    const pushLine = (rec, recIndex, abs, line) => {
        const t = RE_TAGGED.exec(line);
        lineIndex.set(abs, { r: recIndex, l: rec.lines.length });
        if (t) {
            const tag = t[1].toLowerCase();
            if (t[2] && t[2].trim()) descriptions.tag[tag] = t[2].trim();
            rec.lines.push({ tag, text: t[3] });
        } else {
            rec.lines.push({ tag: null, text: line });
        }
    };

    for (; i < lines.length; i++) {
        const abs = i + 1;
        const line = lines[i].trimEnd();

        if (line.trim() === SEP && isSeparator(lines, i)) {
            if (cur) records.push(cur);
            cur = null;
            phase = 'marker';
            continue;
        }

        if (!cur) {
            const m = RE_MARKER.exec(line);
            const b = m ? null : RE_MARKER_BARE.exec(line);
            if (!m && !b) {
                // не маркер — но текст не выбрасываем: не понял — сохрани
                if (!line.trim()) continue;
                if (records.length) pushLine(records[records.length - 1], records.length - 1, abs, line);
                else preamble.push(line);
                continue;
            }
            const rawTail = (m ? m[3] : b[2]).replace(RE_MARK, '');
            const category = m ? m[2].trim().toUpperCase() : '';
            const cm = /^\(([^)]*)\)/.exec(rawTail.trim());
            if (cm && category && cm[1].trim()) descriptions.cat[category] = cm[1].trim();
            const parsed = parseMarkerTags(rawTail);
            Object.assign(descriptions.tag, parsed.descriptions);
            cur = {
                date: (m ? m[1] : b[1]).trim(),
                category,
                tags: parsed.tags,
                fields: [],
                lines: [],
                refines: null,
            };
            lineIndex.set(abs, { r: records.length, l: -1 });
            phase = 'fields';
            continue;
        }

        if (phase === 'fields') {
            const f = RE_FIELD.exec(line);
            if (f && !line.startsWith('#')) {
                cur.fields.push({ key: f[1].trim(), value: f[2].trim() });
                continue;
            }
            phase = 'body';
        }

        pushLine(cur, records.length, abs, line);
    }
    if (cur) records.push(cur);

    const model = { records, preamble, descriptions, lineIndex };
    for (const rec of records) resolveRefine(model, rec);
    return model;
}

/**
 * Разрешает «Уточняет: N» записи в ссылку — по нумерации ДО пересчёта.
 * Номер может указывать и на маркер: тогда уточняется запись целиком.
 * @returns {boolean} удалось ли; если нет, поле снимается
 */
export function resolveRefine(model, record) {
    if (record.refines) return true;
    const i = record.fields.findIndex(f => f.key === 'Уточняет');
    if (i < 0) return true;
    const target = model.lineIndex.get(Number(record.fields[i].value));
    if (target) { record.refines = target; return true; }
    record.fields.splice(i, 1);
    return false;
}

// ─── Сборка ──────────────────────────────────────────────────────────

/**
 * Собирает текст блокнота: оглавление, нумерация, отметки об уточнении.
 * Попутно проставляет каждой записи rec.startLine — её строку в новом тексте.
 * @param {{records: object[], preamble?: string[], descriptions: object}} model
 * @param {string} [today] дата для шапки оглавления
 * @returns {string}
 */
export function renderNotebook(model, today = formatDate()) {
    const { records, descriptions } = model;
    const preamble = model.preamble ?? [];

    // 1. набор меток — известен до нумерации, от него зависит высота оглавления
    const cats = [];
    const tags = [];
    const catSet = new Set();
    const tagSet = new Set();
    const addTag = (t) => { if (!tagSet.has(t)) { tagSet.add(t); tags.push(t); } };
    for (const rec of records) {
        if (rec.category && !catSet.has(rec.category)) { catSet.add(rec.category); cats.push(rec.category); }
        for (const t of rec.tags) addTag(t);
        for (const l of rec.lines) if (l.tag) addTag(l.tag);
    }

    // 2. высота оглавления
    const L = 4 + cats.length + 2 + tags.length + 1;

    // 3. нумерация тела со смещением L и преамбулой
    const start = [];
    const lineNo = [];
    let n = L + 1 + preamble.length;
    for (const rec of records) {
        start.push(n);
        rec.startLine = n;
        n += 1 + rec.fields.length;
        const own = [];
        for (let k = 0; k < rec.lines.length; k++) { own.push(n); n++; }
        lineNo.push(own);
        n++; // SEP
    }
    const total = n - 1;

    // 4. разрешаем ссылки в новые номера; l === -1 — маркер записи
    const marks = new Map();
    const refineLine = new Map();
    records.forEach((rec, ri) => {
        if (!rec.refines) return;
        const { r, l } = rec.refines;
        const targetLine = l === -1 ? start[r] : lineNo[r]?.[l];
        if (targetLine === undefined) return;
        refineLine.set(ri, targetLine);
        if (!marks.has(r)) marks.set(r, []);
        marks.get(r).push(`  → стр. ${targetLine} уточнена в ${start[ri]}`);
    });

    // 5. оглавление
    const catRanges = new Map(cats.map(c => [c, []]));
    const tagLines = new Map(tags.map(t => [t, []]));
    records.forEach((rec, ri) => {
        catRanges.get(rec.category)?.push([start[ri], start[ri] + 1 + rec.fields.length + rec.lines.length]);
        const loc = new Map();
        for (const t of rec.tags) loc.set(t, start[ri]);
        rec.lines.forEach((l, li) => { if (l.tag) loc.set(l.tag, lineNo[ri][li]); });
        for (const [t, ln] of loc) tagLines.get(t).push(ln);
    });

    const cw = cats.reduce((a, c) => Math.max(a, c.length), 0);
    const tw = tags.reduce((a, t) => Math.max(a, t.length + 1), 0);

    const gloss = [
        INDEX_MARKER,
        `Обновлено: ${today} · записей: ${records.length} · строк: ${total}`,
        '',
        'КАТЕГОРИИ:',
    ];
    for (const c of cats) {
        const rs = catRanges.get(c);
        gloss.push(`- ${c.padEnd(cw)}${desc(descriptions.cat[c])} · ${rs.length} зап. · ${collapse(rs)}`);
    }
    gloss.push('', 'ТЕГИ:');
    for (const t of tags) {
        gloss.push(`- ${('#' + t).padEnd(tw)}${desc(descriptions.tag[t])} · ${tagLines.get(t).join(', ')}`);
    }
    gloss.push(SEP);

    if (gloss.length !== L) {
        console.warn('[AutoMemory] высота оглавления разошлась:', gloss.length, '!=', L);
    }

    // 6. тело
    const body = [...preamble];
    records.forEach((rec, ri) => {
        let marker = rec.category ? `[${rec.date}] [${rec.category}]` : `[${rec.date}]`;
        for (const t of rec.tags) marker += ` #${t}`;
        for (const m of marks.get(ri) || []) marker += m;
        body.push(marker);
        for (const f of rec.fields) {
            const v = f.key === 'Уточняет' && refineLine.has(ri) ? refineLine.get(ri) : f.value;
            body.push(`${f.key}: ${v}`);
        }
        for (const l of rec.lines) body.push(l.tag ? `#${l.tag} ${l.text}` : l.text);
        body.push(SEP);
    });

    return gloss.concat(body).join('\n');
}

/** Дописывает запись в конец блокнота, забирая пояснения меток в оглавление. */
export function appendRecord(model, record) {
    if (record.catDescription && record.category) {
        model.descriptions.cat[record.category] = record.catDescription;
    }
    for (const [k, v] of Object.entries(record.tagDescriptions || {})) {
        model.descriptions.tag[k] = v;
    }
    delete record.catDescription;
    delete record.tagDescriptions;
    model.records.push(record);
    return model;
}

/** Похоже ли содержимое на наш блокнот. Пустое годится — начнём с чистого листа. */
export function looksLikeNotebook(content) {
    const s = String(content ?? '').trim();
    if (!s) return true;
    return s.startsWith('[INDEX]');
}

export function formatDate(d = new Date()) {
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

// ─── Мелочи ──────────────────────────────────────────────────────────

function desc(d) { return d && d.trim() ? ` — ${d.trim()}` : ''; }

/** [[1,4],[5,9]] -> "1-9"; несмежные остаются отдельными */
function collapse(ranges) {
    const out = [];
    for (const [a, b] of ranges) {
        const last = out[out.length - 1];
        if (last && a === last[1] + 1) last[1] = b;
        else out.push([a, b]);
    }
    return out.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)).join(', ');
}
