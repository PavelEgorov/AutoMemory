/**
 * Доступ к хранилищу: мир персонажа и лорбук внутри него.
 *
 * Термины проекта: МИР — файл World Info, привязанный к карточке персонажа;
 * ЛОРБУК — запись внутри мира, где ИИ ведёт блокнот. Название лорбука человек
 * указывает в настройках расширения. Мы ничего не создаём и не чистим.
 *
 * Путь импорта: файл лежит в third-party/<папка>/src/, до scripts/ — четыре уровня вверх.
 */

import { setWIOriginalDataValue, originalWIDataKeyMap, world_info } from '../../../../world-info.js';
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
 * Миры, привязанные к персонажу: основной из карточки и дополнительные
 * (кнопка-глобус, выбор «Additional» — хранятся в world_info.charLore).
 * Чистое чтение, ничего не создаёт.
 * @returns {{worlds: string[], problem: string|null, character: object|null}}
 */
export function resolveWorlds(ctx, messageIndex) {
    const character = resolveCharacter(ctx, messageIndex);
    if (!character) return { worlds: [], problem: PROBLEM.NO_CHARACTER, character: null };

    const worlds = [];
    const primary = character.data?.extensions?.world || '';
    if (primary) worlds.push(primary);

    try {
        const fileName = String(character.avatar ?? '').replace(/\.[^/.]+$/, '');
        const extra = world_info?.charLore?.find(e => e.name === fileName)?.extraBooks;
        if (Array.isArray(extra)) {
            for (const w of extra) if (w && !worlds.includes(w)) worlds.push(w);
        }
    } catch (e) {
        console.warn('[AutoMemory] не удалось прочитать дополнительные миры:', e);
    }

    if (!worlds.length) {
        const problem = character.data?.character_book ? PROBLEM.EMBEDDED_ONLY : PROBLEM.NO_WORLD;
        return { worlds: [], problem, character };
    }

    const known = typeof ctx.getWorldInfoNames === 'function' ? ctx.getWorldInfoNames() : [];
    const existing = Array.isArray(known) && known.length ? worlds.filter(w => known.includes(w)) : worlds;
    if (!existing.length) {
        return { worlds, problem: PROBLEM.WORLD_MISSING, character };
    }

    return { worlds: existing, problem: null, character };
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
            return `у персонажа «${world}» не найдено привязанных миров — ни основного, ни дополнительных`;
        case PROBLEM.WORLD_MISSING:
            return `миры персонажа «${world}» привязаны, но не найдены среди существующих`;
        case PROBLEM.EMBEDDED_ONLY:
            return 'у персонажа только встроенный в карточку мир — его нужно импортировать в World Info';
        case PROBLEM.NO_LOREBOOK:
            return `лорбук «${lorebookName}» не найден в мирах: ${world} — добавлять некуда`;
        case PROBLEM.FOREIGN:
            return `лорбук «${lorebookName}» не пуст, и это не наш формат — трогать его не будем`;
        default:
            return 'неизвестная проблема';
    }
}
