/**
 * Разбор блоков <memory> из ответа ИИ.
 *
 * Чистый модуль: на входе текст сообщения, на выходе записи и текст без блоков.
 * Блок с текстом принимается всегда: нет категории — запись без категории.
 */

import { RE_FIELD, RE_TAGGED, RE_CATEGORY, parseMarkerTags } from './patterns.js';

const RE_BLOCK = /<memory>([\s\S]*?)<\/memory>/gi;

/**
 * Достаёт блоки из текста сообщения.
 * `unclosed` — позиция оборванного «<memory>» без закрывающего тега, иначе -1.
 */
export function extractBlocks(text) {
    const src = String(text ?? '');
    const items = [];
    RE_BLOCK.lastIndex = 0;
    let m;
    while ((m = RE_BLOCK.exec(src)) !== null) {
        items.push(parseBlock(m[1]));
    }
    const stripped = strip(src);
    const unclosed = stripped.toLowerCase().lastIndexOf('<memory>');
    return { items, stripped, unclosed };
}

/**
 * Убирает блоки, не трогая остальной текст: пробелы и пустые строки
 * схлопываются только на месте вырезанного, а не по всему сообщению.
 */
function strip(text) {
    const MARK = String.fromCharCode(1);
    let s = String(text ?? '').replace(RE_BLOCK, MARK);
    const around = new RegExp('(?:[ \t]*\n)?[ \t]*' + MARK + '[ \t]*(?:\n[ \t]*)?', 'g');
    s = s.replace(around, '\n');
    return s.replace(/^\n+/, '').replace(/\n+$/, '');
}

/**
 * Разбирает содержимое одного блока.
 */
function parseBlock(inner) {
    const lines = String(inner ?? '').split('\n').map(l => l.trimEnd());
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();

    if (!lines.length) return { record: null, error: 'пустой блок' };

    // Категория необязательна: нет её — первая строка уже текст.
    const cm = RE_CATEGORY.exec(lines[0].trim());
    const category = cm ? cm[1].trim().toUpperCase() : '';
    const catDescription = cm ? (cm[2] || '').trim() : '';

    let tags = [];
    let tagDescriptions = {};
    if (cm) {
        const parsed = parseMarkerTags(lines[0].trim().slice(cm[0].length));
        tags = parsed.tags;
        tagDescriptions = parsed.descriptions;
    }

    // поля — только после маркера с категорией, до первой строки не-поля
    const fields = [];
    let i = cm ? 1 : 0;
    if (cm) {
        for (; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('#')) break;
            const f = RE_FIELD.exec(line);
            if (!f) break;
            fields.push({ key: f[1].trim(), value: f[2].trim() });
        }
    }

    // тело
    const body = [];
    for (; i < lines.length; i++) {
        const line = lines[i];
        const t = RE_TAGGED.exec(line);
        if (t) {
            const name = t[1].toLowerCase();
            if (t[2] && t[2].trim()) tagDescriptions[name] = t[2].trim();
            body.push({ tag: name, text: t[3] });
        } else {
            body.push({ tag: null, text: line });
        }
    }

    if (!body.some(l => l.text.trim()) && !fields.length) {
        return { record: null, error: 'пустой текст записи' };
    }

    return {
        record: { date: '', category, tags, fields, lines: body, refines: null, catDescription, tagDescriptions },
        error: null,
    };
}
