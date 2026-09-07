/**
 * Настройки расширения.
 *
 * Недостающие ключи дозаполняются при каждом чтении, чтобы обновление
 * расширения не ломало уже сохранённые настройки.
 */

export const MODULE_NAME = 'autoMemory';
export const LOG_PREFIX = '[AutoMemory]';

/**
 * Промт ИИ расширения по умолчанию.
 *
 * Здесь описано и что она делает, и в каком виде отвечает. Человек волен
 * переписать его целиком — код ничего не решает за неё и не подставляет
 * никаких правил от себя.
 *
 * Местозаполнители, которые расширение подставит перед отправкой:
 *   {{оглавление}} — оглавление блокнота
 *   {{блоки}}      — только блоки тегов, названных в командах этого сообщения
 *   {{текст}}      — сообщение собеседника (необязательно: оно и так уходит репликой)
 */
export const DEFAULT_PROMPT = [
    'Ты ведёшь блокнот памяти. Работаешь молча: ничего не объясняешь и не комментируешь.',
    '',
    'КОМАНДЫ',
    '',
    'В тексте собеседника найди все команды — они начинаются со знака ⚠ и слэша.',
    'Команд может быть несколько, в том числе разных. Обработай каждую отдельно, по порядку.',
    '',
    '⚠/add #тег текст — вырежи текст записи и положи его в блок этого тега.',
    '⚠/show — верни оглавление. Блоки при этом не меняй.',
    '⚠/get #тег #тег — верни блоки названных тегов. Блоки при этом не меняй.',
    '',
    'ЧТО ТЕБЕ ДАЮТ',
    '',
    'Блокнот целиком тебе не показывают и показывать не будут. Ты получаешь',
    'оглавление и только те блоки, чьи теги названы в командах этого сообщения.',
    'Про блок, которого тебе не дали, ничего не выдумывай.',
    '',
    'ПРАВИЛА БЛОКА',
    '',
    'Первая строка блока — номер и тег, ниже текст.',
    'Если блок тега тебе дали, дописывай новое ниже прежнего текста, ничего не стирая.',
    'Если блока нет, заведи новый: первая строка с тегом, ниже текст записи.',
    'Оглавление и номера пересчитывает расширение — тебе их вести не нужно.',
    '',
    'ЧТО ВЕРНУТЬ',
    '',
    'Ответ состоит из трёх частей и ничего кроме них не содержит.',
    '',
    '===БЛОКИ===',
    '#тег',
    'текст блока целиком, каким он должен стать',
    '---',
    '#другой тег',
    'текст другого блока',
    '===ЗАПИСИ===',
    '#тег | текст первой записи',
    '#тег | текст второй записи',
    '===В КОНТЕКСТ===',
    'здесь то, что собеседник должен увидеть в своём следующем ходе',
    '===КОНЕЦ===',
    '',
    'В части БЛОКИ — только те блоки, которые ты изменил или завёл, целиком.',
    'Блоки отделяются друг от друга строкой из трёх дефисов. Ничего не менял — оставь часть пустой.',
    'В части ЗАПИСИ перечисли всё, что вырезал из этого сообщения — по строке',
    'на команду, тег и текст через вертикальную черту.',
    'В части В КОНТЕКСТ положи то, что просили показать: на ⚠/show — оглавление,',
    'на ⚠/get — блоки названных тегов, и только их.',
    'Если названного тега в оглавлении нет, так и напиши в этой части: тег не найден.',
    'Молчать про ненайденный тег нельзя — иначе не отличить пропажу от поломки.',
    'Часть, которой нечего содержать, оставь пустой.',
    'Если команд в тексте не оказалось, оставь пустыми все три.',
    '',
    'ОГЛАВЛЕНИЕ СЕЙЧАС',
    '',
    '{{оглавление}}',
    '',
    'БЛОКИ ПО НАЗВАННЫМ ТЕГАМ',
    '',
    '{{блоки}}',
    '',
    'Текст собеседника придёт следующим сообщением.',
].join('\n');

const defaults = Object.freeze({
    enabled: true,              // общий выключатель расширения
    stripCommands: true,        // вырезать команду из видимого текста, оставив ⚠
    connectionSource: 'profile',// 'profile' — профиль подключения, 'main' — основное
    connectionProfileId: '',    // выбранный профиль подключения
    maxTokens: 2000,            // потолок ответа ИИ расширения
    systemPrompt: DEFAULT_PROMPT,
    bindings: {},               // avatar -> { world: 'Memory', entry: 'AutoMemory' }
    showErrors: true,           // показывать ошибки человеку всплывающим сообщением
});

export function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaults);
    }
    const s = extensionSettings[MODULE_NAME];
    for (const key of Object.keys(defaults)) {
        if (!Object.hasOwn(s, key)) {
            s[key] = structuredClone(defaults[key]);
        }
    }
    return s;
}

export function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

export function resetPrompt() {
    getSettings().systemPrompt = DEFAULT_PROMPT;
    saveSettings();
}

export function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
}

/** Всплывающее сообщение человеку — только если он его не отключил. */
export function tell(kind, text) {
    const s = getSettings();
    if (kind === 'error' && !s.showErrors) return;
    try {
        if (typeof toastr !== 'undefined') toastr[kind](text, 'AutoMemory', { timeOut: 4000 });
    } catch (e) {
        warn('не удалось показать сообщение:', e);
    }
}

// ─── Текущий персонаж ────────────────────────────────────────────────

/** Аватар текущего персонажа — он же ключ связок и включения. */
export function currentAvatar() {
    const ctx = SillyTavern.getContext();
    return ctx.characters?.[ctx.characterId]?.avatar || '';
}

export function currentName() {
    const ctx = SillyTavern.getContext();
    return ctx.characters?.[ctx.characterId]?.name || '';
}

/**
 * Работает ли расширение для этого персонажа.
 * Персонажа заводит человек: есть связка с миром — расширение работает,
 * нет связки — не работает. Отдельной галки на персонажа нет.
 */
export function enabledFor(avatar) {
    const s = getSettings();
    if (!s.enabled || !avatar) return false;
    return !!s.bindings[avatar]?.world;
}

// ─── Связка персонаж → мир → блокнот ─────────────────────────────────

/** Имя персонажа по аватару — для таблицы связок. */
export function nameOf(avatar) {
    const ctx = SillyTavern.getContext();
    const found = (ctx.characters || []).find(c => c?.avatar === avatar);
    return found?.name || avatar;
}

export function bindingFor(avatar) {
    if (!avatar) return null;
    return getSettings().bindings[avatar] || null;
}

export function setBinding(avatar, world, entry) {
    if (!avatar) return;
    const s = getSettings();
    if (!world) {
        delete s.bindings[avatar];
    } else {
        s.bindings[avatar] = { world, entry: entry || 'AutoMemory' };
    }
    saveSettings();
}
