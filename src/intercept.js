/**
 * Перехват ответа собеседника.
 *
 * Расширение смотрит текст. Увидело команду — отдаёт текст ИИ расширения
 * вместе с промтом из настроек. Дальше работает она: вырезает записи, ведёт
 * блокнот, достаёт из него то, что просили, и говорит, что сделала.
 * Расширение только переносит: её блокнот — в World Info, её записи — в файл
 * последней операции, её выдачу — в контекст следующего хода.
 *
 * Разбирать команду, считать теги и решать, что записывать и что показывать,
 * расширение не берётся: это работа ИИ расширения.
 */

import {
    getSettings, warn, tell,
    currentAvatar, enabledFor, bindingFor,
} from './settings.js';
import { readNotebook, writeNotebook } from './lorebook.js';
import * as notebook from './notebook.js';
import { process as askAgent } from './agent.js';
import * as logfile from './logfile.js';
import * as context from './context.js';

/**
 * Признак команды: ⚠ и следом слэш. Границы нужны только чтобы отличить
 * сообщение с командой от сообщения без неё и убрать команду с экрана.
 */
const COMMAND = /⚠\s*\/[^\n\r]*/g;

/**
 * Все команды текста, как они написаны.
 * Позиция поиска сбрасывается явно: регулярка общая и с флагом g, а он хранит
 * позицию между вызовами — иначе второй поиск начнётся не с начала строки.
 */
export function findCommands(text) {
    COMMAND.lastIndex = 0;
    return [...String(text ?? '').matchAll(COMMAND)].map(m => m[0].trim());
}

/** Есть ли в тексте хоть одна команда. */
export function hasCommand(text) {
    return findCommands(text).length > 0;
}

/** Убрать команду с экрана, оставив ⚠ на её месте. */
export function strip(text) {
    return String(text ?? '').replace(COMMAND, '⚠');
}

/**
 * Сообщения, которые сейчас в работе.
 * Пока запрос к ИИ не вернулся, второй запуск по тому же сообщению не начнётся:
 * он прочитал бы блок до записи первого и не увидел бы в нём дубля.
 */
const working = new Set();

/**
 * Записать правку в свайп.
 * Без этого свайп назад и вперёд вернёт текст с командой: таверна хранит
 * варианты ответа отдельно от msg.mes.
 */
function syncSwipe(msg) {
    const i = msg.swipe_id;
    if (!Array.isArray(msg.swipes) || typeof i !== 'number') return;
    if (typeof msg.swipes[i] !== 'string') return;
    msg.swipes[i] = msg.mes;
    if (Array.isArray(msg.swipe_info) && msg.swipe_info[i]) {
        try {
            msg.swipe_info[i].extra = structuredClone(msg.extra);
        } catch (e) {
            warn('свайп-заметка не скопировалась:', e);
        }
    }
}

/**
 * Перерисовать сообщение и сохранить чат.
 * При потоковом выводе сообщение уже на экране к моменту нашей правки,
 * поэтому его надо перерисовать явно.
 */
function redraw(ctx, index, msg) {
    try {
        if (typeof ctx.updateMessageBlock === 'function') ctx.updateMessageBlock(index, msg);
    } catch (e) {
        warn('перерисовка не удалась:', e);
    }
    try {
        if (typeof ctx.saveChat === 'function') ctx.saveChat();
    } catch (e) {
        warn('чат не сохранился:', e);
    }
}

/** Начать операцию в файле: прежняя стирается, отдаваемый текст ложится сразу. */
async function begin(text, binding) {
    try {
        await logfile.start({ text, world: binding?.world, entry: binding?.entry });
    } catch (e) {
        warn('операция не начата в файле:', e);
    }
}

/** Дописать к начатой операции её итог. */
async function conclude(outcome) {
    try {
        await logfile.finish(outcome);
    } catch (e) {
        warn('итог операции не записан:', e);
    }
}

/**
 * Обработчик MESSAGE_RECEIVED.
 * Событие приходит до отрисовки сообщения, поэтому правка msg.mes попадает
 * и на экран, и в файл чата.
 *
 * @param {number} index номер сообщения в чате
 * @returns {Promise<{handled: boolean, reason: string}>}
 */
export async function onMessageReceived(index) {
    const settings = getSettings();
    if (!settings.enabled) return { handled: false, reason: 'расширение выключено' };

    const ctx = SillyTavern.getContext();
    const msg = ctx.chat?.[index];
    if (!msg) return { handled: false, reason: 'сообщения нет' };
    if (msg.is_user) return { handled: false, reason: 'сообщение человека' };
    if (msg.is_system) return { handled: false, reason: 'служебное сообщение' };

    const avatar = currentAvatar();
    if (!enabledFor(avatar)) return { handled: false, reason: 'выключено для персонажа' };

    // Расширение смотрит текст.
    if (!hasCommand(msg.mes)) return { handled: false, reason: 'команд нет' };

    // Метка ставится до первого же ожидания: иначе второй запуск успеет
    // проскочить проверку, пока первый ждёт файл или блокнот.
    if (working.has(index)) return { handled: false, reason: 'уже в работе' };
    working.add(index);

    try {
        // Связка здесь заведомо есть: enabledFor пропускает только персонажей,
        // которым человек её завёл.
        const binding = bindingFor(avatar);

        // Операция начинается здесь: текст, который уйдёт ИИ, ложится в файл
        // сразу, до всякой работы. Сорвётся дальше что угодно — текст цел.
        await begin(msg.mes, binding);

        const current = await readNotebook(binding.world, binding.entry);
        if (current === null) {
            const reason = `в мире «${binding.world}» нет записи «${binding.entry}»`;
            tell('error', `AutoMemory: ${reason}`);
            await conclude({ note: reason });
            return { handled: false, reason };
        }

        // Режем блокнот и отдаём ИИ только нужное: оглавление и те блоки,
        // чьи теги названы в самих командах. Весь блокнот не уезжает.
        const cut = notebook.split(current);
        const wanted = notebook.mentioned(notebook.tagsOf(cut.index), findCommands(msg.mes));
        const picked = notebook.pick(cut.blocks, wanted);

        // Один запрос на сообщение: команд в тексте может быть несколько
        // и разных, разбирает их все ИИ расширения.
        const answer = await askAgent(msg.mes, {
            index: cut.index,
            blocks: notebook.joinBlocks(picked),
        });

        // Что записать в блокнот: ИИ присылает изменённые блоки, документ
        // собирает расширение. Блокнот целиком от ИИ не принимается.
        const incoming = answer.blocks ? notebook.split(answer.blocks).blocks : [];
        let returned = '';
        if (incoming.length) {
            const merged = notebook.merge(cut.blocks, incoming);
            const index = answer.index?.trim() || notebook.buildIndex(merged);
            returned = notebook.render(merged, index);
        }

        const hasRecords = answer.records.length > 0;
        const hasContext = !!answer.context;

        // Ни одной части — ответ не по форме, догадываться не будем.
        if (answer.index === null && answer.blocks === null && !hasRecords && !hasContext) {
            const reason = 'ИИ ответила не по форме';
            tell('error', `AutoMemory: ${reason}`);
            await conclude({ note: reason });
            return { handled: false, reason };
        }

        // Все части пустые — ИИ не нашла, что делать. Ничего не трогаем
        // и второй раз про это сообщение не спрашиваем.
        if (!returned && !hasRecords && !hasContext) {
            const reason = 'ИИ не нашла в сообщении команд';
            await conclude({ note: reason });
            return { handled: false, reason };
        }

        // Записи есть, а блоков нет — это потеря памяти, а не запись.
        if (!returned && hasRecords) {
            const reason = 'ИИ вернула записи без блоков — блокнот оставлен прежним';
            tell('error', `AutoMemory: ${reason}`);
            await conclude({ records: answer.records, note: reason });
            return { handled: false, reason };
        }

        // Блокнот меняем, только если ИИ прислала блоки: на команду показа
        // она их не трогает и присылает эту часть пустой.
        if (returned) {
            const written = await writeNotebook(binding.world, binding.entry, returned);
            if (!written.ok) {
                tell('error', `AutoMemory: ${written.reason}`);
                await conclude({ records: answer.records, note: written.reason });
                return { handled: false, reason: written.reason };
            }
        }

        // Выдача уходит в контекст следующего хода и живёт ровно один ход.
        if (hasContext) context.show(answer.context);

        // Файл последней операции — про запись в блокнот. Показ его не трогает:
        // он ничего не записывает.
        if (hasRecords) await conclude({ records: answer.records });

        // ⚠ остаётся на месте команды: человеку видно, что команда была.
        if (settings.stripCommands) msg.mes = strip(msg.mes);
        syncSwipe(msg);
        redraw(ctx, index, msg);

        const reason = `записей: ${answer.records.length}, в контекст: ${hasContext ? 'да' : 'нет'}`;
        return { handled: true, reason, wrote: hasRecords };
    } catch (e) {
        const reason = String(e?.message || e);
        warn('обработка не удалась:', e);
        tell('error', `AutoMemory: ${reason}`);
        await conclude({ note: reason });
        return { handled: false, reason };
    } finally {
        working.delete(index);
    }
}
