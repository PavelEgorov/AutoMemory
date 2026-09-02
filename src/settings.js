/**
 * Настройки расширения. Недостающие ключи дозаполняются при каждом чтении,
 * чтобы обновление расширения не ломало существующие настройки.
 */

export const MODULE_NAME = 'autoMemory';
export const LOG_PREFIX = '[AutoMemory]';

const defaults = Object.freeze({
    enabled: true,
    debug: false,
    coreCategories: '',        // категории-ядро через запятую: уезжают в контекст всегда
    scanDepth: 2,              // сколько последних сообщений сканировать на «Ключи:»
    keepBlocks: false,         // не вырезать блоки <memory> из видимого текста
    trimToolPass: false,       // экономное продолжение после note_show: второй проход без давней истории
    trimToolPassHard: false,   // жёсткая экономия: во втором проходе вырезать и карточку с инструкциями
    bindings: {},              // связки персонаж → мир: { 'avatar.png': 'SOL' }
});

export function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaults);
    }
    for (const key of Object.keys(defaults)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaults[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

export function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

export function log(...args) {
    if (getSettings().debug) console.log(LOG_PREFIX, ...args);
}
