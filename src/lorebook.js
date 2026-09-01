/**
 * Доступ к хранилищу: мир персонажа и лорбук внутри него.
 *
 * Термины проекта: МИР — файл World Info, привязанный к карточке персонажа;
 * ЛОРБУК — запись внутри мира, где ИИ ведёт блокнот. Название лорбука человек
 * указывает в настройках расширения. Мы ничего не создаём и не чистим.
 *
 * Путь импорта: файл лежит в third-party/<папка>/src/, до scripts/ — четыре уровня вверх.
 */

import { setWIOriginalDataValue, originalWIDataKeyMap } from '../../../../world-info.js';
import { looksLikeNotebook } from './notebook.js';

export const PROBLEM = {
    NO_CHARACTER: 'no_character',
    NO_WORLD: 'no_world',
    WORLD_MISSING: 'world_missing',
    EMBEDDED_ONLY: 'embedded_only',
    NO_LOREBOOK: 'no_lorebook',
    FOREIGN: 'foreign',
};

/**
 * Персонаж, которому принадлежит сообщение.
 * Сначала по original_avatar — уникальный ключ карточки, ST ставит его на каждое
 * сообщение именно для этого. Имя — запасной путь, characterId — последний.
 */
export function resolveCharacter(ctx, messageIndex) {
    const msg = ctx.chat?.[messageIndex];
    const chars = Array.isArray(ctx.characters) ? ctx.characters : [];

    if (msg?.original_avatar) {
        const byAvatar = chars.find(c => c?.avatar === msg.original_avatar);
        if (byAvatar) return byAvatar;
    }
    if (msg?.name) {
        const needle = String(msg.name).toLowerCase();
        const byName = chars.find(c => c?.name?.toLowerCase() === needle || c?.avatar === msg.name);
        if (byName) return byName;
    }
    return chars[ctx.characterId] ?? null;
}

/**
 * Мир, привязанный к карточке персонажа. Чистое чтение, ничего не создаёт.
 * @returns {{world: string|null, problem: string|null, character: object|null}}
 */
export function resolveWorld(ctx, messageIndex) {
    const character = resolveCharacter(ctx, messageIndex);
    if (!character) return { world: null, problem: PROBLEM.NO_CHARACTER, character: null };

    const world = character.data?.extensions?.world || '';
    if (!world) {
        const problem = character.data?.character_book ? PROBLEM.EMBEDDED_ONLY : PROBLEM.NO_WORLD;
        return { world: null, problem, character };
    }

    const known = typeof ctx.getWorldInfoNames === 'function' ? ctx.getWorldInfoNames() : [];
    if (Array.isArray(known) && known.length && !known.includes(world)) {
        return { world, problem: PROBLEM.WORLD_MISSING, character };
    }

    return { world, problem: null, character };
}

/** «[БЛОКНОТ SOL]» и «блокнот sol» считаются одним названием. */
function normalizeName(s) {
    return String(s ?? '').trim().replace(/^\[|\]$/g, '').trim().toLowerCase();
}

/**
 * Находит лорбук в мире по названию из настроек и проверяет его содержимое.
 * Пустой лорбук годится — начнём с чистого листа. Наш формат — работаем
 * с сохранёнными данными. Чужое содержимое не трогаем.
 * @returns {Promise<{data: object|null, entry: object|null, content: string, problem: string|null}>}
 */
export async function readNotebook(ctx, world, lorebookName) {
    const name = normalizeName(lorebookName);

    const data = name ? await ctx.loadWorldInfo(world) : null;
    if (!name || !data || !data.entries) {
        return { data: null, entry: null, content: '', problem: PROBLEM.NO_LOREBOOK };
    }

    // точное совпадение названия важнее совпадения по началу
    const all = Object.values(data.entries).filter(Boolean);
    const entry =
        all.find(e => normalizeName(e.comment) === name) ??
        all.find(e => normalizeName(e.comment).startsWith(name));

    if (!entry) {
        return { data, entry: null, content: '', problem: PROBLEM.NO_LOREBOOK };
    }
    const content = String(entry.content ?? '');
    if (!looksLikeNotebook(content)) {
        return { data, entry, content, problem: PROBLEM.FOREIGN };
    }

    return { data, entry, content, problem: null };
}

/**
 * Сохраняет содержимое лорбука. Пишет сразу, без отложенного сохранения.
 */
export async function writeNotebook(ctx, world, data, entry, content) {
    entry.content = content;

    if (data.originalData) {
        try {
            setWIOriginalDataValue(data, entry.uid, originalWIDataKeyMap['content'], content);
        } catch (e) {
            console.warn('[AutoMemory] не удалось синхронизировать originalData:', e);
        }
    }

    await ctx.saveWorldInfo(world, data, true);

    if (typeof ctx.reloadWorldInfoEditor === 'function') {
        try { ctx.reloadWorldInfoEditor(world); } catch { /* панель может быть закрыта */ }
    }
}

/** Человекочитаемое объяснение проблемы. */
export function describeProblem(problem, world, lorebookName) {
    switch (problem) {
        case PROBLEM.NO_CHARACTER:
            return 'не удалось определить персонажа, которому принадлежит сообщение';
        case PROBLEM.NO_WORLD:
            return 'к карточке персонажа не привязан мир (поле World в карточке)';
        case PROBLEM.WORLD_MISSING:
            return `мир «${world}» привязан к карточке, но не найден`;
        case PROBLEM.EMBEDDED_ONLY:
            return 'у персонажа только встроенный в карточку мир — его нужно импортировать в World Info';
        case PROBLEM.NO_LOREBOOK:
            return 'лорбук не найден — добавлять некуда';
        case PROBLEM.FOREIGN:
            return `лорбук «${lorebookName}» не пуст, и это не наш формат — трогать его не будем`;
        default:
            return 'неизвестная проблема';
    }
}
