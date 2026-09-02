/**
 * Ядро формата блокнота: разбор текста, сборка, оглавление, нумерация.
 *
 * Про SillyTavern здесь не знают ничего: на входе строка, на выходе строка.
 * Формат описан в docs/structure.md. Текст никогда не выбрасывается:
 * непонятные строки сохраняются, «---» в тексте записи не рвёт её.
 * Дат в формате нет.
 */

import { RE_FIELD, RE_TAGGED, parseMarkerTags } from './patterns.js';

const SEP = '---';
const INDEX_MARKER = '[INDEX] [META]';

/** Маркер записи: [КАТЕГОРИЯ] хвост. Пустые скобки — запись без категории. */
const RE_MARKER = /^\[([^\]]*)\](.*)$/;
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
        return RE_MARKER.test(next);
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
            if (!m) {
                // не маркер — но текст не выбрасываем: не понял — сохрани
                if (!line.trim()) continue;
                if (records.length) pushLine(records[records.length - 1], records.length - 1, abs, line);
                else preamble.push(line);
                continue;
            }
            const category = m[1].trim().toUpperCase();
            const rawTail = m[2].replace(RE_MARK, '');
            const cm = /^\(([^)]*)\)/.exec(rawTail.trim());
            if (cm && category && cm[1].trim()) descriptions.cat[category] = cm[1].trim();
            const parsed = parseMarkerTags(rawTail);
            Object.assign(descriptions.tag, parsed.descriptions);
            cur = {
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

// ─── Правка ──────────────────────────────────────────────────────────

/**
 * Разрешает команду правки «Удаляет: N» / «Заменяет: N» — по нумерации ДО пересчёта.
 * Поле снимается с записи. Номер может указывать на маркер (запись целиком)
 * или на строку текста. Строки полей не адресуются.
 * @returns {{op: 'delete'|'replace', ref?: {r:number,l:number}, line: number, error?: boolean}|null}
 */
export function resolveEdit(model, record) {
    const i = record.fields.findIndex(f => f.key === 'Удаляет' || f.key === 'Заменяет');
    if (i < 0) return null;
    const f = record.fields[i];
    record.fields.splice(i, 1);
    const op = f.key === 'Удаляет' ? 'delete' : 'replace';
    const line = Number(f.value);
    const ref = model.lineIndex.get(line);
    if (!ref) return { op, line, error: true };
    return { op, ref: { r: ref.r, l: ref.l }, line };
}

/** Убирает запись r; ссылки «Уточняет» на неё снимаются, остальные съезжают. */
function dropRecord(model, r) {
    model.records.splice(r, 1);
    // refines могут делить один объект (общая цель) — правим каждый объект один раз
    const objs = new Set(model.records.map(x => x.refines).filter(Boolean));
    const dead = new Set();
    for (const rf of objs) {
        if (rf.r === r) dead.add(rf);
        else if (rf.r > r) rf.r--;
    }
    for (const rec of model.records) {
        if (rec.refines && dead.has(rec.refines)) rec.refines = null;
    }
}

/** Сдвигает ссылки на строки записи r после позиции fromL. */
function shiftLineRefs(model, r, fromL, delta) {
    if (!delta) return;
    const objs = new Set(model.records.map(x => x.refines).filter(Boolean));
    for (const rf of objs) {
        if (rf.r === r && rf.l !== -1 && rf.l > fromL) rf.l += delta;
    }
}

/**
 * Применяет команды правки к модели. Порядок надёжный: сначала строки
 * (снизу вверх), затем замены записей на месте, затем удаления записей (с конца).
 * @param {object[]} edits элементы из resolveEdit, у замен — поле record
 * @returns {object[]} исходы для отчёта: {...edit, ok, category}
 */
export function applyEdits(model, edits) {
    const out = [];

    const lineOps = edits.filter(e => e.ref.l !== -1).sort((a, b) => b.ref.l - a.ref.l);
    for (const e of lineOps) {
        const rec = model.records[e.ref.r];
        if (!rec || e.ref.l >= rec.lines.length) { out.push({ ...e, ok: false }); continue; }
        if (e.op === 'delete') {
            rec.lines.splice(e.ref.l, 1);
            shiftLineRefs(model, e.ref.r, e.ref.l, -1);
        } else {
            rec.lines.splice(e.ref.l, 1, ...e.record.lines);
            shiftLineRefs(model, e.ref.r, e.ref.l, e.record.lines.length - 1);
        }
        out.push({ ...e, ok: true, category: rec.category });
    }

    for (const e of edits.filter(x => x.ref.l === -1 && x.op === 'replace')) {
        const old = model.records[e.ref.r];
        if (!old) { out.push({ ...e, ok: false }); continue; }
        absorbDescriptions(model, e.record);
        model.records[e.ref.r] = e.record;
        out.push({ ...e, ok: true, category: old.category });
    }

    for (const e of edits.filter(x => x.ref.l === -1 && x.op === 'delete').sort((a, b) => b.ref.r - a.ref.r)) {
        const old = model.records[e.ref.r];
        if (!old) { out.push({ ...e, ok: false }); continue; }
        dropRecord(model, e.ref.r);
        out.push({ ...e, ok: true, category: old.category });
    }

    return out;
}

// ─── Сборка ──────────────────────────────────────────────────────────

/**
 * Собирает текст блокнота: оглавление, нумерация, отметки об уточнении.
 * Попутно проставляет каждой записи rec.startLine — её строку в новом тексте.
 * @param {{records: object[], preamble?: string[], descriptions: object}} model
 * @returns {string}
 */
export function renderNotebook(model) {
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
        `Записей: ${records.length} · строк: ${total}`,
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
        let marker = `[${rec.category}]`;
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

/** Забирает пояснения меток записи в оглавление. */
function absorbDescriptions(model, record) {
    if (record.catDescription && record.category) {
        model.descriptions.cat[record.category] = record.catDescription;
    }
    for (const [k, v] of Object.entries(record.tagDescriptions || {})) {
        model.descriptions.tag[k] = v;
    }
    delete record.catDescription;
    delete record.tagDescriptions;
}

/** Дописывает запись в конец блокнота, забирая пояснения меток в оглавление. */
export function appendRecord(model, record) {
    absorbDescriptions(model, record);
    model.records.push(record);
    return model;
}

/** Похоже ли содержимое на наш блокнот. Пустое годится — начнём с чистого листа. */
export function looksLikeNotebook(content) {
    const s = String(content ?? '').trim();
    if (!s) return true;
    return s.startsWith('[INDEX]');
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
