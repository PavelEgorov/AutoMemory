/**
 * ИИ расширения: та, что читает сообщение собеседника, вырезает из него записи,
 * ведёт блокнот и достаёт из него то, что попросили. Расширение здесь только
 * собирает запрос и разбирает ответ — что считать записью, что отдавать и как
 * это назвать, решает она сама по промту из настроек.
 *
 * Промт целиком принадлежит человеку. Расширение подставляет в него то, чего
 * ИИ иначе не увидит:
 *   {{оглавление}} — оглавление блокнота
 *   {{блоки}}      — только те блоки, чьи теги названы в командах
 *   {{текст}}      — сообщение собеседника (необязательно: оно и так уходит репликой)
 */

import { getSettings, warn } from './settings.js';
import { ask } from './connection.js';

// Границы частей ответа. Терпимо на входе: пробелы, регистр и число знаков
// равенства значения не имеют — но хотя бы один знак с каждой стороны нужен,
// иначе обычная строка ответа станет меткой.
const MARKS = [
    ['index', /^=+\s*ОГЛАВЛЕНИЕ\s*=+$/im],
    ['blocks', /^=+\s*БЛОКИ\s*=+$/im],
    ['records', /^=+\s*ЗАПИСИ\s*=+$/im],
    ['context', /^=+\s*В\s+КОНТЕКСТ\s*=+$/im],
    ['end', /^=+\s*КОНЕЦ\s*=+$/im],
];

/** Подставить в промт то, что ИИ иначе не увидит. */
export function buildPrompt(template, { index, blocks, text } = {}) {
    return String(template ?? '')
        .replaceAll('{{оглавление}}', index ?? '')
        .replaceAll('{{блоки}}', blocks ?? '')
        .replaceAll('{{текст}}', text ?? '');
}

/**
 * Разобрать ответ ИИ на части.
 * Части могут идти в любом порядке и любая может отсутствовать.
 *
 * @returns {{index: string|null, blocks: string|null, records: string[], context: string|null, raw: string}}
 *   records  — строки «#тег | текст», что было вырезано
 *   context  — то, что уходит в контекст следующего хода, null если нечего
 */
export function parseAnswer(answer) {
    const raw = String(answer ?? '');
    const result = { index: null, blocks: null, records: [], context: null, raw };

    // Границы частей: где начинается каждая и где её обрывает следующая.
    const found = [];
    for (const [name, mark] of MARKS) {
        const hit = raw.match(mark);
        if (hit) found.push({ name, at: hit.index, from: hit.index + hit[0].length });
    }
    if (found.length === 0) return result;
    found.sort((a, b) => a.at - b.at);

    const parts = {};
    for (let i = 0; i < found.length; i++) {
        if (found[i].name === 'end') continue;
        const until = i + 1 < found.length ? found[i + 1].at : raw.length;
        parts[found[i].name] = raw.slice(found[i].from, until).trim();
    }

    if (parts.index !== undefined) result.index = parts.index;
    if (parts.blocks !== undefined) result.blocks = parts.blocks;
    if (parts.context) result.context = parts.context;
    if (parts.records) {
        result.records = parts.records.split('\n').map(line => line.trim()).filter(Boolean);
    }

    return result;
}

/**
 * Отдать ИИ расширения текст сообщения и промт из настроек.
 * @param {string} text сообщение собеседника целиком, как пришло
 * @param {object} given что дать ИИ: { index, blocks }
 * @returns {Promise<object>} разобранный ответ
 */
export async function process(text, given = {}) {
    const s = getSettings();
    const system = buildPrompt(s.systemPrompt, { ...given, text });
    const answer = await ask(text, system);
    const parsed = parseAnswer(answer);
    const empty = parsed.index === null && parsed.blocks === null
        && parsed.records.length === 0 && parsed.context === null;
    if (empty) warn('ИИ ответила не по форме:', String(answer ?? '').slice(0, 200));
    return parsed;
}
