/**
 * AutoMemory — долговременная память для собеседника в SillyTavern.
 *
 * Этот файл только собирает расширение: читает настройки, монтирует панель,
 * подписывается на события таверны и региструет команды. Вся работа —
 * в модулях src/.
 */

import { MODULE_NAME, LOG_PREFIX, getSettings, warn, currentAvatar, currentName, enabledFor, bindingFor } from './src/settings.js';
import { bindUI, refreshPanel, refreshLog, refreshWorlds, refreshProfiles } from './src/ui.js';
import { checkBinding } from './src/lorebook.js';
import { sourceName } from './src/connection.js';
import { onMessageReceived } from './src/intercept.js';
import { read as readLog, describe as describeLog, ensure as ensureLog } from './src/logfile.js';
import { clear as clearContext } from './src/context.js';

// Путь к папке расширения вычисляем сами: имя папки нигде не зашито строкой,
// поэтому переименование папки ничего не ломает.
const EXTENSION_PATH = decodeURIComponent(new URL('.', import.meta.url).pathname)
    .replace(/\/$/, '').split('/').filter(Boolean).slice(-2).join('/');

/**
 * Пришёл ответ собеседника — смотрим, нет ли в нём команды.
 * Событие приходит до отрисовки, поэтому правка текста попадает и на экран,
 * и в файл чата. Ошибка здесь ничего не роняет: расширение просто отступает.
 */
async function onMessage(index) {
    try {
        const result = await onMessageReceived(index);
        // Файл последней операции меняется только при записи в блокнот:
        // на показ он не трогается.
        if (result.wrote) refreshLog();
    } catch (e) {
        warn('обработка сообщения не удалась:', e);
    }
}

/** Панель перерисовывается при смене чата: персонаж другой — и связка другая. */
function onChatChanged() {
    try {
        // Выдача была для того чата: в новом ей делать нечего.
        clearContext();
        refreshWorlds();
        refreshPanel();
    } catch (e) {
        warn('панель не обновилась при смене чата:', e);
    }
}

function registerCommands() {
    try {
        const ctx = SillyTavern.getContext();
        const { SlashCommandParser, SlashCommand } = ctx;
        if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) {
            return;
        }

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'am-status',
            helpString: 'AutoMemory: показать состояние — персонаж, связка, подключение',
            callback: async () => {
                const avatar = currentAvatar();
                const binding = bindingFor(avatar);
                const lines = ['**AutoMemory**'];
                lines.push(`Персонаж: ${currentName() || 'не выбран'}`);
                lines.push(`Работает для него: ${enabledFor(avatar) ? 'да' : 'нет'}`);
                if (binding) {
                    const check = await checkBinding(binding.world, binding.entry);
                    lines.push(`Блокнот: ${binding.world} / ${binding.entry} — ${check.reason}`);
                } else {
                    lines.push('Блокнот: связка не задана');
                }
                lines.push(`Подключение: ${sourceName()}`);
                lines.push(`Последняя операция: ${describeLog(readLog())}`);
                return lines.join('\n');
            },
        }));

    } catch (e) {
        warn('не удалось зарегистрировать команды:', e);
    }
}

(async function init() {
    try {
        const { eventSource, event_types, renderExtensionTemplateAsync } = SillyTavern.getContext();

        getSettings();

        const html = await renderExtensionTemplateAsync(EXTENSION_PATH, 'settings', {});
        $('#extensions_settings2').append(html);

        bindUI();
        registerCommands();

        eventSource.on(event_types.MESSAGE_RECEIVED, onMessage);
        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

        // Первая отрисовка — только когда таверна собрала свои списки:
        // до APP_READY миров и профилей подключения ещё нет.
        eventSource.on(event_types.APP_READY, async () => {
            try {
                // Заготовка файла последней операции едет с расширением:
                // человеку её заводить не нужно, и отсутствовать она не может.
                await ensureLog();
                refreshWorlds();
                refreshProfiles();
                refreshPanel();
                console.log(LOG_PREFIX, `загружено из ${EXTENSION_PATH}, настройки в ${MODULE_NAME}`);
            } catch (e) {
                warn('первая отрисовка панели не удалась:', e);
            }
        });
    } catch (e) {
        // Расширение никогда не роняет таверну: не сложилось — молча пишем в консоль.
        console.error(LOG_PREFIX, 'расширение не запустилось:', e);
    }
})();
