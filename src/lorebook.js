/**
 * Доступ к хранилищу: мир персонажа и лорбук внутри него.
 *
 * Термины проекта: МИР — файл World Info, привязанный к карточке персонажа;
 * ЛОРБУК — запись внутри мира, где ИИ ведёт блокнот. Название лорбука человек
 * указывает в настройках расширения. Мы ничего не создаём и не чистим.
 *
 * Путь импорта: файл лежит в third-party/<папка>/src/, до scripts/ — четыре уровня вверх.
 */

import { setWIOriginalDataValue, originalWIDataKeyMap, world_info, selected_world_info } from '../../../../world-info.js';
import { looksLikeNotebook } from './notebook.js';

export const PROBLEM = {
    NO_CHARACTER: 'no_character',
    NO_BINDING: 'no_binding',
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
 * Миры конкретного персонажа: основной из карточки и дополнительные
 * (кнопка-глобус, выбор «Additional» — хранятся в world_info.charLore).
 * Чужие, чатовые и глобальные миры не смотрим: лорбук принадлежит персонажу.
 * @returns {{worlds: string[], problem: string|null, character: object|null}}
 */
/** Связка из таблицы: строка (старый вид, только мир) или {world, lorebook}. */
export function bindingOf(bindings, avatar) {
    const b = bindings?.[avatar];
    if (!b) return null;
    if (typeof b === 'string') return { world: b, lorebook: '' };
    return { world: b.world || '', lorebook: b.lorebook || '' };
}

/**
 * Цель записи для персонажа сообщения: мир и лорбук из таблицы связок.
 * Без связки писать некуда — привязки таверны не читаем, имена не угадываем.
 * @returns {{world: string|null, lorebook: string|null, problem: string|null, character: object|null}}
 */
export function resolveTarget(ctx, messageIndex, bindings = {}) {
    const character = resolveCharacter(ctx, messageIndex);
    if (!character) return { world: null, lorebook: null, problem: PROBLEM.NO_CHARACTER, character: null };

    const b = bindingOf(bindings, character.avatar);
    if (!b || !b.world || !b.lorebook) {
        return { world: null, lorebook: null, problem: PROBLEM.NO_BINDING, character };
    }
    return { world: b.world, lorebook: b.lorebook, problem: null, character };
}

/** Дополнительные миры персонажа из world_info.charLore. */
export function charExtraWorlds(character) {
    try {
        const fileName = String(character?.avatar ?? '').replace(/\.[^/.]+$/, '');
        const extra = world_info?.charLore?.find(e => e.name === fileName)?.extraBooks;
        return Array.isArray(extra) ? extra.filter(Boolean) : [];
    } catch (e) {
        console.warn('[AutoMemory] не удалось прочитать дополнительные миры:', e);
        return [];
    }
}

/**
 * Сырой снимок всех мест, где таверна может хранить привязку миров.
 * Только для диагностики: печатается человеку, на поведение не влияет.
 */
export function bindingSnapshot(ctx, character) {
    const out = [];
    const show = (v) => v === undefined ? 'undefined' : v === '' ? '«» (пустая строка)' : JSON.stringify(v);
    out.push('data.extensions.world: ' + show(character?.data?.extensions?.world));
    out.push('character.world (старое поле): ' + show(character?.world));
    try { out.push('привязка к чату (chatMetadata): ' + show(ctx.chatMetadata?.['world_info'])); }
    catch { out.push('привязка к чату: недоступна'); }
    try {
        out.push('активные глобально: ' + (Array.isArray(selected_world_info) && selected_world_info.length
            ? selected_world_info.join(', ') : '— нет —'));
    } catch { out.push('активные глобально: недоступны'); }
    try {
        const lore = Array.isArray(world_info?.charLore) ? world_info.charLore : [];
        out.push('charLore целиком: ' + (lore.length
            ? lore.map(e => String(e?.name) + ' → [' + (e?.extraBooks ?? []).join(', ') + ']').join('; ')
            : '— пусто —'));
    } catch (e) { out.push('charLore: ошибка чтения — ' + String(e?.message ?? e)); }
    return out;
}

/**
 * Находит лорбук по названию в заданном мире. Пустой лорбук годится —
 * начнём с чистого листа. Наш формат — работаем с сохранённым. Чужое не трогаем.
 * @returns {Promise<{data: object|null, entry: object|null, content: string, problem: string|null}>}
 */
export async function readNotebook(ctx, world, lorebookName) {
    const name = String(lorebookName ?? '').trim();
    if (!name || !world) {
        return { data: null, entry: null, content: '', problem: PROBLEM.NO_LOREBOOK };
    }

    const data = await ctx.loadWorldInfo(world);
    if (!data || !data.entries) {
        return { data: null, entry: null, content: '', problem: PROBLEM.NO_LOREBOOK };
    }

    // название приходит из выпадающего списка — совпадение точное, по строке
    const entry = Object.values(data.entries).filter(Boolean)
        .find(e => String(e.comment ?? '').trim() === name);
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
        case PROBLEM.NO_BINDING:
            return `для персонажа «${world}» нет связки в таблице — добавьте её в настройках AutoMemory`;
        case PROBLEM.NO_LOREBOOK:
            return `лорбук «${lorebookName}» не найден в мире «${world}»`;
        case PROBLEM.FOREIGN:
            return `лорбук «${lorebookName}» не пуст, и это не наш формат — трогать его не будем`;
        default:
            return 'неизвестная проблема';
    }
}
