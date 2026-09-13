/**
 * Доступ к World Info: список миров, чтение и запись блокнота.
 *
 * Работаем с объектом, который вернул loadWorldInfo, и не пересобираем
 * entries: там могут лежать чужие записи, которые не наши, чтобы терять.
 *
 * Всё, что таверна отдаёт через контекст, берётся из контекста
 * (reference/SillyTavern/public/scripts/st-context.js:276-282). Прямой импорт
 * модуля таверны опасен: путь к нему зависит от устройства чужого дерева, а
 * несуществующий импорт роняет не одну функцию, а весь модуль расширения —
 * тогда расширение не загружается целиком.
 */

import { warn } from './settings.js';

/** Имена всех миров, известных таверне. */
export function listWorlds() {
    try {
        return SillyTavern.getContext().getWorldInfoNames();
    } catch (e) {
        warn('список миров недоступен:', e);
        return [];
    }
}

/** Загрузить мир. Возвращает объект книги или null. */
export async function openWorld(world) {
    if (!world) return null;
    try {
        return await SillyTavern.getContext().loadWorldInfo(world);
    } catch (e) {
        warn(`мир «${world}» не открылся:`, e);
        return null;
    }
}

/** Сохранить мир целиком, сразу — без отложенной записи. */
async function saveWorld(world, book) {
    await SillyTavern.getContext().saveWorldInfo(world, book, true);
}

/**
 * Создать пустую запись в книге.
 *
 * Единственное, чего в контексте нет: createWorldInfoEntry живёт только в
 * модуле таверны (reference/SillyTavern/public/scripts/world-info.js:4057).
 * Берём её оттуда, но импортом по требованию: не нашлось — отваливается одно
 * создание записи, а расширение работает дальше.
 */
async function createEntry(world, book) {
    const module = await import('../../../../world-info.js');
    return module.createWorldInfoEntry(world, book);
}

/** Найти запись блокнота по comment. Возвращает объект записи или null. */
export function findEntry(book, entryName) {
    if (!book?.entries) return null;
    for (const uid of Object.keys(book.entries)) {
        const entry = book.entries[uid];
        if (entry?.comment === entryName) return entry;
    }
    return null;
}

/**
 * Проверить связку: открывается ли мир и есть ли в нём запись блокнота.
 * @returns {Promise<{ok: boolean, reason: string, entry: object|null}>}
 */
export async function checkBinding(world, entryName) {
    if (!world) return { ok: false, reason: 'мир не выбран', entry: null };
    const book = await openWorld(world);
    if (!book) return { ok: false, reason: `мир «${world}» не открылся`, entry: null };
    const entry = findEntry(book, entryName);
    if (!entry) return { ok: false, reason: `в мире «${world}» нет записи «${entryName}»`, entry: null };
    return { ok: true, reason: `запись «${entryName}» на месте`, entry };
}

/**
 * Завести запись блокнота, если её ещё нет.
 * Поля, которых мы не касаемся, остаются как их задала таверна:
 * null в поле — это «Глоб. настройка» человека, а не false.
 */
export async function ensureEntry(world, entryName) {
    const book = await openWorld(world);
    if (!book) return { ok: false, reason: `мир «${world}» не открылся` };

    if (findEntry(book, entryName)) {
        return { ok: true, reason: `запись «${entryName}» уже была`, created: false };
    }

    let entry = null;
    try {
        entry = await createEntry(world, book);
    } catch (e) {
        warn('создание записи недоступно:', e);
        return { ok: false, reason: 'таверна не дала создать запись' };
    }
    if (!entry) return { ok: false, reason: 'таверна не создала запись' };

    entry.comment = entryName;
    entry.key = [];
    entry.keysecondary = [];
    entry.content = '';
    entry.constant = false;
    entry.disable = false;

    await saveWorld(world, book);
    return { ok: true, reason: `запись «${entryName}» создана`, created: true };
}

/** Прочитать текст блокнота. */
export async function readNotebook(world, entryName) {
    const book = await openWorld(world);
    const entry = findEntry(book, entryName);
    return entry ? String(entry.content ?? '') : null;
}

/** Записать текст блокнота целиком. */
export async function writeNotebook(world, entryName, text) {
    const book = await openWorld(world);
    if (!book) return { ok: false, reason: `мир «${world}» не открылся` };
    const entry = findEntry(book, entryName);
    if (!entry) return { ok: false, reason: `в мире «${world}» нет записи «${entryName}»` };

    entry.content = text;
    if (book.originalData) {
        const original = book.originalData.entries?.[entry.uid];
        if (original) original.content = text;
    }
    await saveWorld(world, book);
    return { ok: true, reason: 'записано' };
}
