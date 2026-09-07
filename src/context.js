/**
 * Выдача в контекст следующего хода.
 *
 * То, что ИИ расширения вернула на команду показа, кладётся в контекст один
 * раз: собеседник видит это в своём следующем ходе, и дальше вставка снимается.
 *
 * Почему снятие в два приёма. Таверна снимает свои одноразовые вставки на
 * GENERATION_ENDED (slash-commands.js:3826-3840), но нам так нельзя: команда
 * приходит в MESSAGE_RECEIVED, а это событие эмитится внутри генерации
 * (script.js:6656-6659), тогда как GENERATION_ENDED приходит позже, из
 * activateSendButtons через hideStopButton (script.js:7016-7021, 3473-3479).
 * Снятие, повешенное сразу, сработало бы в конце текущей генерации — до того,
 * как вставкой кто-то воспользуется. Поэтому ждём следующего GENERATION_STARTED
 * и только тогда вешаем снятие на конец уже следующей генерации.
 */

import { MODULE_NAME, warn } from './settings.js';

// Значения из таверны: extension_prompt_types.IN_CHAT и
// extension_prompt_roles.SYSTEM (script.js:483-499).
const POSITION_IN_CHAT = 1;
const ROLE_SYSTEM = 0;
const DEPTH_LAST = 0; // 0 — последнее сообщение в контексте

// Подписки, ожидающие своего хода. eventSource.once снять нельзя: он вешает
// собственную обёртку, а не наш обработчик, поэтому подписываемся через on
// и снимаем сами.
let pending = null;

/** Снять подписки, если они висят. */
function disarm() {
    if (!pending) return;
    try {
        const { eventSource, event_types } = SillyTavern.getContext();
        eventSource.removeListener(event_types.GENERATION_STARTED, pending.onStart);
        eventSource.removeListener(event_types.GENERATION_ENDED, pending.onEnd);
        eventSource.removeListener(event_types.GENERATION_STOPPED, pending.onEnd);
    } catch (e) {
        warn('подписки на снятие вставки не сняты:', e);
    }
    pending = null;
}

/** Убрать вставку из контекста. */
export function clear() {
    disarm();
    try {
        const { setExtensionPrompt } = SillyTavern.getContext();
        setExtensionPrompt(MODULE_NAME, '', POSITION_IN_CHAT, DEPTH_LAST, false, ROLE_SYSTEM);
    } catch (e) {
        warn('вставка не снята:', e);
    }
}

/** Повесить снятие на конец следующей генерации. */
function armRemoval() {
    const { eventSource, event_types } = SillyTavern.getContext();

    const onEnd = () => clear();

    const onStart = () => {
        eventSource.removeListener(event_types.GENERATION_STARTED, onStart);
        eventSource.on(event_types.GENERATION_ENDED, onEnd);
        eventSource.on(event_types.GENERATION_STOPPED, onEnd);
    };

    pending = { onStart, onEnd };
    eventSource.on(event_types.GENERATION_STARTED, onStart);
}

/**
 * Положить текст в контекст следующего хода.
 * @param {string} text то, что вернула ИИ расширения
 * @returns {boolean} удалось ли
 */
export function show(text) {
    const value = String(text ?? '').trim();
    if (!value) {
        clear();
        return false;
    }
    try {
        const { setExtensionPrompt } = SillyTavern.getContext();
        disarm();
        setExtensionPrompt(MODULE_NAME, value, POSITION_IN_CHAT, DEPTH_LAST, false, ROLE_SYSTEM);
        armRemoval();
        return true;
    } catch (e) {
        warn('вставка не поставлена:', e);
        return false;
    }
}
