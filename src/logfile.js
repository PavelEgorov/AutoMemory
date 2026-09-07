/**
 * Файл последней операции.
 *
 * Операция начинается до обращения к ИИ: расширение сразу кладёт сюда текст,
 * который отдаёт ИИ расширения. Поэтому текст цел, даже если дальше всё
 * сорвалось — ИИ не ответила, блокнот не записался. Когда ответ приходит,
 * к той же операции дописывается, что вырезано и чем всё кончилось.
 *
 * Файл хранит только последнюю операцию: она начинается с очистки прежней.
 *
 * Пустая заготовка файла едет вместе с расширением — data/last-operation.json.
 * Она есть всегда, её не нужно заводить человеку, и с неё расширение начинает
 * при запуске. Писать в неё нельзя: таверна принимает записи только в
 * пользовательский каталог (src/endpoints/files.js:43), а точек для записи в
 * папку расширения у неё нет. Поэтому рабочая копия уходит через
 * /api/files/upload, а путь к ней расширение держит у себя, не в настройках.
 *
 * Показанное в панели берётся из памяти расширения, поэтому оно всегда
 * совпадает с последней операцией, а не с прочитанным из кэша браузера.
 */

import { warn, currentName } from './settings.js';

const FILE_NAME = 'automemory-last.json';

const EMPTY = { at: '', character: '', world: '', entry: '', text: '', records: [], note: '' };

// Путь, который выдала таверна при первой записи, и сама последняя операция.
let filePath = '';
let last = { ...EMPTY };

/** base64 от строки в UTF-8 — таверна ждёт данные именно так. */
function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

/** Положить файл на диск целиком и запомнить путь. */
async function upload(payload) {
    const ctx = SillyTavern.getContext();
    const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({
            name: FILE_NAME,
            data: toBase64(JSON.stringify(payload, null, 2)),
        }),
    });
    if (!response.ok) throw new Error(`таверна не приняла файл: ${response.status}`);
    const { path } = await response.json();
    if (path) filePath = path;
    last = payload;
    return path;
}

/**
 * Начать с заготовки, приехавшей вместе с расширением.
 * Файла может не быть только если побили саму папку расширения; на этот случай
 * остаётся пустая операция в памяти, и расширение работает дальше.
 */
export async function ensure() {
    try {
        const response = await fetch(new URL('../data/last-operation.json', import.meta.url), {
            cache: 'no-store',
        });
        if (!response.ok) throw new Error(`заготовка не читается: ${response.status}`);
        const parsed = JSON.parse(await response.text());
        last = { ...EMPTY, ...parsed };
    } catch (e) {
        warn('заготовка файла последней операции не прочиталась:', e);
        last = { ...EMPTY };
    }
    return last;
}

/** Последняя операция. Расширение помнит её само, читать файл не нужно. */
export function read() {
    return last;
}

/** Стереть прежнюю операцию. Делается перед каждой новой записью. */
export async function clear() {
    await upload({ ...EMPTY });
}

/**
 * Начать операцию: стереть прежнюю и записать текст, который уходит ИИ.
 * Делается до обращения к ИИ, чтобы текст не пропал при сбое.
 * @param {object} operation
 * @param {string} operation.text текст, который расширение отдаёт ИИ расширения
 * @param {string} [operation.world] мир, куда пойдёт запись
 * @param {string} [operation.entry] запись блокнота
 */
export async function start(operation = {}) {
    const payload = {
        ...EMPTY,
        at: new Date().toISOString(),
        character: currentName(),
        world: operation.world || '',
        entry: operation.entry || '',
        text: operation.text || '',
    };
    await upload(payload);
    return payload;
}

/**
 * Дописать к начатой операции её итог.
 * @param {object} outcome
 * @param {string[]} [outcome.records] строки «#тег | текст», как их вернула ИИ
 * @param {string} [outcome.note] короткая пометка, если что-то пошло не так
 */
export async function finish(outcome = {}) {
    const payload = {
        ...last,
        records: Array.isArray(outcome.records) ? outcome.records : (last.records || []),
        note: outcome.note || '',
    };
    await upload(payload);
    return payload;
}

/** Однострочный итог — последняя ошибка или удачная операция. */
export function describe(data = last) {
    if (!data || !data.at) return 'операций ещё не было';
    const when = new Date(data.at).toLocaleString();
    if (data.note) return `${when} — ${data.note}`;
    const count = (data.records || []).length;
    const where = data.world ? `${data.world} / ${data.entry}` : 'блокнот не указан';
    return `${when} — записано: ${count} → ${where}`;
}

/** Содержимое файла в человекочитаемом виде — для поля в панели. */
export function render(data = last) {
    if (!data || !data.at) return '';
    const lines = [];
    lines.push(`${new Date(data.at).toLocaleString()}  ${data.character || ''}`.trim());
    if (data.world) lines.push(`${data.world} / ${data.entry}`);
    if (data.note) lines.push(data.note);
    if (data.text) {
        lines.push('');
        lines.push('Отдано ИИ:');
        lines.push(data.text);
    }
    if ((data.records || []).length) {
        lines.push('');
        lines.push('Вырезано:');
        for (const record of data.records) lines.push(String(record));
    }
    return lines.join('\n');
}
